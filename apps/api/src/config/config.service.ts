import { Injectable, Logger } from '@nestjs/common';

// Single typed gateway to process.env. Read once at boot, fail fast on
// misconfig, hand strongly-typed values to consumers. Reasons we own a
// hand-rolled one instead of @nestjs/config for now:
//  - Day 1 has 3 vars total; the dependency isn't paying its way yet.
//  - Inline validation lives next to the consumer's mental model
//    (the guard's "16+ chars" rule lives here, not in a Joi schema).
//  - We can move to @nestjs/config + Joi when the surface grows past
//    ~10 vars or we need per-environment .env layering.
@Injectable()
export class ConfigService {
  private static readonly logger = new Logger(ConfigService.name);

  readonly githubWebhookSecret: string;
  readonly databasePath: string;
  readonly port: number;

  // Day 2 — RAG foundation. Voyage = embedding provider, Chroma = vector
  // index. Voyage key is required and fails fast like the webhook secret;
  // the other three carry sensible defaults so a fresh `.env` only needs
  // VOYAGE_API_KEY filled in.
  readonly voyageApiKey: string;
  readonly chromaUrl: string;
  readonly chromaCollection: string;
  readonly embeddingModel: string;

  // Day 3 — Claude integration. Key is required (fails fast). Model
  // default is NODE_ENV-aware: Haiku in dev (~8× cheaper per call, fine
  // for iteration), Sonnet in production (demo-quality output). Explicit
  // ANTHROPIC_MODEL always wins. The resolved model is logged at boot so
  // a misconfig (Sonnet silently downgrading because NODE_ENV is wrong)
  // surfaces immediately.
  readonly anthropicApiKey: string;
  readonly anthropicModel: string;

  // Gates registration of POST /reviews/dry-run. Defaults to true in dev
  // (NODE_ENV=development) and false everywhere else — forecloses the
  // accidental-deploy-to-prod denial-of-wallet path before Day 5 ships
  // auth. The CLI path is unaffected (no HTTP).
  readonly enableDryRun: boolean;

  // Day 5 — real-PR integration. App credentials authenticate Octokit
  // via @octokit/auth-app; Redis backs the BullMQ review queue;
  // DOGFOOD_REPOS is the allowlist + kill switch for which repos the
  // bot reviews; the remaining knobs bound the agent loop's runtime
  // and cost surface. See docs/setup/day5-real-pr.md.
  readonly appId: string;
  readonly appPrivateKey: string;
  readonly redisUrl: string;
  readonly dogfoodRepos: ReadonlySet<string>;
  readonly anthropicUseZeroRetention: boolean;
  readonly workerConcurrency: number;
  readonly shutdownDrainTimeoutMs: number;
  readonly maxDiffBytes: number;

  // Test-only escape hatches. When true, the corresponding boot
  // probe is skipped so AppModule-bootstrapping specs don't need real
  // upstream dependencies (GitHub API, Redis). Always false in
  // production / dev. Set via jest.setup.ts.
  readonly skipGithubAppProbe: boolean;
  readonly skipRedisProbe: boolean;

  constructor() {
    this.githubWebhookSecret = this.requireSecret(
      'GITHUB_WEBHOOK_SECRET',
      process.env.GITHUB_WEBHOOK_SECRET,
    );
    this.databasePath = process.env.DATABASE_PATH ?? './data/app.sqlite';
    this.port = Number(process.env.PORT) || 4001;

    this.voyageApiKey = this.requireSecret('VOYAGE_API_KEY', process.env.VOYAGE_API_KEY);
    this.chromaUrl = this.validateChromaUrl(
      process.env.CHROMA_URL ?? 'http://localhost:8000',
    );
    this.chromaCollection = this.requireNonEmptyToken(
      'CHROMA_COLLECTION',
      process.env.CHROMA_COLLECTION ?? 'code-style-rules',
    );
    this.embeddingModel = this.requireNonEmptyToken(
      'EMBEDDING_MODEL',
      process.env.EMBEDDING_MODEL ?? 'voyage-code-3',
    );

    this.anthropicApiKey = this.requireSecret(
      'ANTHROPIC_API_KEY',
      process.env.ANTHROPIC_API_KEY,
    );
    this.anthropicModel = this.resolveAnthropicModel(
      process.env.ANTHROPIC_MODEL,
      process.env.NODE_ENV,
    );
    this.enableDryRun = this.resolveEnableDryRun(
      process.env.ENABLE_DRY_RUN,
      process.env.NODE_ENV,
    );

    this.appId = this.requireAppId('APP_ID', process.env.APP_ID);
    this.appPrivateKey = this.requireAppPrivateKey(
      'APP_PRIVATE_KEY',
      process.env.APP_PRIVATE_KEY,
    );
    this.redisUrl = this.validateRedisUrl('REDIS_URL', process.env.REDIS_URL);
    this.dogfoodRepos = parseDogfoodRepos(process.env.DOGFOOD_REPOS);
    this.anthropicUseZeroRetention = parseBooleanFlag(
      process.env.ANTHROPIC_USE_ZERO_RETENTION,
      false,
    );
    this.workerConcurrency = this.requirePositiveInteger(
      'WORKER_CONCURRENCY',
      process.env.WORKER_CONCURRENCY,
      1,
    );
    // F14 closure: 15s default leaves 15s margin under k8s's default
    // terminationGracePeriodSeconds: 30 for Nest's own shutdown
    // (database close, queue shutdown, etc.). Bumped down from
    // 25_000 where the 5s margin proved tight on real shutdowns.
    // Operators with a longer platform grace can raise this.
    this.shutdownDrainTimeoutMs = this.requirePositiveInteger(
      'SHUTDOWN_DRAIN_TIMEOUT_MS',
      process.env.SHUTDOWN_DRAIN_TIMEOUT_MS,
      15_000,
    );
    this.maxDiffBytes = this.requirePositiveInteger(
      'MAX_DIFF_BYTES',
      process.env.MAX_DIFF_BYTES,
      256 * 1024,
    );
    this.skipGithubAppProbe = parseBooleanFlag(
      process.env.SKIP_GITHUB_APP_PROBE,
      false,
    );
    this.skipRedisProbe = parseBooleanFlag(
      process.env.SKIP_REDIS_PROBE,
      false,
    );

    ConfigService.logger.log(`Resolved model: ${this.anthropicModel}`);
  }

  // Reject the truthy-but-broken cases too: literal "undefined"/"null"
  // (common from `${VAR:-undefined}` templating or `String(undef)`),
  // and anything shorter than 16 chars (`openssl rand -hex 32`
  // produces 64). The bar isn't strong-secret enforcement; it's
  // catching obvious misconfigs before they authenticate strangers.
  private requireSecret(name: string, value: string | undefined): string {
    if (!value || value === 'undefined' || value === 'null' || value.length < 16) {
      throw new Error(
        `${name} is missing, a placeholder ("undefined"/"null"), or shorter than 16 characters. Generate one with \`openssl rand -hex 32\` and put it in apps/api/.env before starting apps/api.`,
      );
    }
    return value;
  }

  // Chroma's compose-hosted server listens on http://host:port. Reject
  // anything that doesn't parse as a URL with an http(s) scheme so a
  // typo'd CHROMA_URL fails at boot, not on the first vector upsert.
  private validateChromaUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        `CHROMA_URL must be a valid URL (got "${value}"). Example: http://localhost:8000`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `CHROMA_URL must use http or https (got "${parsed.protocol}"). Example: http://localhost:8000`,
      );
    }
    return value;
  }

  // CHROMA_COLLECTION and EMBEDDING_MODEL are passed verbatim into the
  // Chroma API and the Voyage API respectively. Reject empty strings,
  // whitespace-only values, and embedded whitespace — those almost
  // always indicate a `.env` parsing accident (e.g., `EMBEDDING_MODEL=
  // voyage-code-3` with a stray newline).
  private requireNonEmptyToken(name: string, value: string): string {
    if (!value || value.trim() !== value || /\s/.test(value)) {
      throw new Error(
        `${name} must be a non-empty token without whitespace (got "${value}").`,
      );
    }
    return value;
  }

  // ANTHROPIC_MODEL resolution order:
  //   1. Explicit ANTHROPIC_MODEL value in process.env (validated as a
  //      non-empty token).
  //   2. NODE_ENV=production → claude-sonnet-4-6.
  //   3. Anything else (development/test/undefined) → claude-haiku-4-5.
  // Dev iteration runs ~8× cheaper at Haiku rates; Sonnet stays the
  // production default for demo-quality output.
  private resolveAnthropicModel(
    explicit: string | undefined,
    nodeEnv: string | undefined,
  ): string {
    if (explicit !== undefined && explicit !== '') {
      return this.requireNonEmptyToken('ANTHROPIC_MODEL', explicit);
    }
    return nodeEnv === 'production' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  }

  private resolveEnableDryRun(
    explicit: string | undefined,
    nodeEnv: string | undefined,
  ): boolean {
    return parseEnableDryRun(explicit, nodeEnv);
  }

  // GitHub App IDs from the App settings page are a positive integer
  // (typically 6–7 digits). We accept the string form because env
  // values are strings; reject anything non-numeric or non-positive.
  private requireAppId(name: string, value: string | undefined): string {
    if (!value || value === 'undefined' || value === 'null') {
      throw new Error(
        `${name} is required (the GitHub App ID from your App's settings page).`,
      );
    }
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new Error(
        `${name} must be a positive integer (the App's numeric ID), got "${value}".`,
      );
    }
    return trimmed;
  }

  // PEM private keys are stored in .env with literal "\n" escape
  // sequences (real newlines break dotenv parsing). We normalise them
  // back to real newlines so @octokit/auth-app — which parses the PEM
  // with node's crypto — accepts the value. The "-----BEGIN" prefix
  // check catches the obvious misconfig of pasting a fingerprint or a
  // SSH key instead of the App's downloaded PEM.
  private requireAppPrivateKey(name: string, value: string | undefined): string {
    if (!value || value === 'undefined' || value === 'null') {
      throw new Error(
        `${name} is required (the App private key PEM, newlines escaped as \\n).`,
      );
    }
    const normalized = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
    if (!normalized.includes('-----BEGIN')) {
      throw new Error(
        `${name} does not look like a PEM private key — expected to contain "-----BEGIN". Download a fresh key from your App's settings page.`,
      );
    }
    return normalized;
  }

  // BullMQ's connection field accepts a URL with redis:// or rediss://
  // scheme. We parse to surface typos at boot rather than at first
  // queue.add. Loopback-only enforcement and TLS policy live in docs;
  // see the Day-5 Open Questions about non-localhost deployments.
  private validateRedisUrl(name: string, value: string | undefined): string {
    if (!value) {
      throw new Error(
        `${name} is required (e.g. redis://:password@localhost:6379).`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid URL (got "${value}").`);
    }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(
        `${name} must use redis:// or rediss:// (got "${parsed.protocol}").`,
      );
    }
    return value;
  }

  // Positive-integer parser with a default. `undefined`/empty → default;
  // non-numeric, zero, negative, or non-finite → throw. Used for the
  // worker concurrency knob, shutdown drain budget, and the diff cap.
  private requirePositiveInteger(
    name: string,
    value: string | undefined,
    fallback: number,
  ): number {
    if (value === undefined || value === '') return fallback;
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new Error(
        `${name} must be a positive integer (got "${value}").`,
      );
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `${name} must be a positive finite integer (got "${value}").`,
      );
    }
    return parsed;
  }
}

// ENABLE_DRY_RUN parser exported as a pure function so module-definition-
// time code (notably ReviewsModule.forRoot in app.module.ts) can decide
// whether to register the dry-run route WITHOUT constructing a full
// ConfigService at file-load time. Centralising the parse rule here keeps
// the "single gateway for env values" discipline intact:
//   - explicit value: parse 'true'/'1'/'yes' (case-insensitive) → true,
//     anything else → false.
//   - unset: NODE_ENV=development → true, anything else → false.
// The dev default makes the surface ergonomic for local work; the
// non-dev default forecloses accidental-deploy denial-of-wallet.
export function parseEnableDryRun(
  explicit: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  if (explicit !== undefined && explicit !== '') {
    const normalized = explicit.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return nodeEnv === 'development';
}

// Module-definition-time parser for WORKER_CONCURRENCY. Mirrors the
// `parseEnableDryRun` / `parseBooleanFlag` pattern so the @Processor
// decorator on ReviewsProcessor can read the env at class-eval time
// without constructing a ConfigService (which would fail-fast on
// any unrelated missing env var). Returns `fallback` for unset /
// empty values. Invalid values (non-numeric, zero, negative,
// non-finite) fall back to `fallback` with no throw — module-eval
// must not crash; ConfigService.requirePositiveInteger is still the
// strict gate for runtime values surfaced to consumers.
export function parseWorkerConcurrency(
  explicit: string | undefined,
  fallback: number,
): number {
  if (explicit === undefined || explicit === '') return fallback;
  const trimmed = explicit.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Module-definition-time parser for SKIP_REDIS_PROBE. The QueueModule
// and ReviewsModule both branch on this flag at forRoot()-time to
// decide whether to wire BullMQ or fall back to the no-op queue.
// Replaces direct `process.env.SKIP_REDIS_PROBE` reads in those
// modules (CLAUDE.md pitfall #3 — no bare env reads outside
// ConfigService or the parse helpers in @/config).
export function parseSkipRedisProbe(
  explicit: string | undefined,
  fallback: boolean,
): boolean {
  return parseBooleanFlag(explicit, fallback);
}

// Generic boolean-flag parser modelled on parseEnableDryRun but
// without the NODE_ENV branch. Used for ANTHROPIC_USE_ZERO_RETENTION
// and any future Day-5+ feature flag that has a fixed default rather
// than a per-environment default. Truthy tokens (case-insensitive):
// 'true', '1', 'yes'. Empty / unset → fallback. Anything else → false.
export function parseBooleanFlag(
  explicit: string | undefined,
  fallback: boolean,
): boolean {
  if (explicit === undefined || explicit === '') return fallback;
  const normalized = explicit.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

// DOGFOOD_REPOS parsing. Comma-separated list of GitHub `repo_full_name`
// values ("owner/repo"). Whitespace around tokens is trimmed; empty
// tokens (e.g., a trailing comma) are dropped. A whitespace-bearing
// token (e.g., "owner / repo") is the smoking gun for a .env parse
// accident and we refuse to start. Empty/unset input → empty Set,
// which silently disables the bot (operator kill switch).
export function parseDogfoodRepos(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') return new Set();
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (/\s/.test(token)) {
      throw new Error(
        `DOGFOOD_REPOS contains a token with embedded whitespace ("${token}"). Use comma separation: "owner/repo,owner2/repo2".`,
      );
    }
    if (!/^[^/]+\/[^/]+$/.test(token)) {
      throw new Error(
        `DOGFOOD_REPOS token "${token}" is not in "owner/repo" form.`,
      );
    }
  }
  return new Set(tokens);
}
