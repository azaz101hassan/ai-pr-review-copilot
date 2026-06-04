import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_LLM_PROVIDER,
  isLlmProvider,
  LLM_PROVIDERS,
  type LlmProvider,
} from '@/infrastructure/llm/llm-provider.types';

/**
 * Single typed gateway to process.env. Read once at boot, fail fast
 * on misconfig, hand strongly-typed values to consumers. Inline
 * validators sit next to the consumer's mental model — we can move to
 * @nestjs/config + Joi when the surface grows past ~10 vars or needs
 * per-environment .env layering.
 */
@Injectable()
export class ConfigService {
  private static readonly logger = new Logger(ConfigService.name);

  readonly githubWebhookSecret: string;
  readonly databasePath: string;
  readonly port: number;

  readonly voyageApiKey: string;
  readonly chromaUrl: string;
  readonly chromaCollection: string;
  readonly embeddingModel: string;

  readonly anthropicApiKey: string;
  readonly anthropicModel: string;

  /** Active LLM provider. Set via `LLM_PROVIDER`. Defaults to anthropic. */
  readonly llmProvider: LlmProvider;

  readonly openrouterApiKey: string;
  readonly openrouterModel: string;
  readonly openrouterBaseUrl: string;

  /** Per-turn raw request/response logging for the active reviewer. */
  readonly llmSpikeVerbose: boolean;

  readonly enableDryRun: boolean;

  readonly appId: string;
  readonly appPrivateKey: string;
  readonly redisUrl: string;
  readonly dogfoodRepos: ReadonlySet<string>;
  readonly anthropicUseZeroRetention: boolean;

  /**
   * Hard ceiling on agent-loop turns per review. Default 6 keeps the
   * worst-case spend bounded across both providers; bump for larger
   * PRs that need more exploration turns. Bounded 1–70.
   */
  readonly agentTurnCap: number;
  readonly workerConcurrency: number;
  readonly shutdownDrainTimeoutMs: number;
  readonly maxDiffBytes: number;

  /**
   * Soft size gate on changed lines (additions + deletions). PRs above
   * this threshold skip the agent loop and post a friendly walkthrough
   * comment instead. Distinct from `maxDiffBytes` (hard system-safety
   * ceiling, silent failure path).
   */
  readonly maxReviewDiffLines: number;

  // Test-only escape hatches; AppModule-bootstrapping specs flip these
  // to skip GitHub/Redis boot probes. Always false outside test.
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

    this.llmProvider = parseLlmProvider(process.env.LLM_PROVIDER);

    // Per-provider validation is gated on the active provider — the
    // inactive side gets sentinel empties so consumers can read fields
    // without optional-chaining, but a stray injection while the wrong
    // provider is active surfaces obviously rather than silently
    // hitting the upstream with empty creds.
    if (this.llmProvider === 'anthropic') {
      this.anthropicApiKey = this.requireSecret(
        'ANTHROPIC_API_KEY',
        process.env.ANTHROPIC_API_KEY,
      );
      this.anthropicModel = this.resolveAnthropicModel(process.env.ANTHROPIC_MODEL);
      this.openrouterApiKey = '';
      this.openrouterModel = '';
      this.openrouterBaseUrl = '';
    } else {
      this.anthropicApiKey = '';
      this.anthropicModel = '';
      this.openrouterApiKey = this.requireSecret(
        'OPENROUTER_API_KEY',
        process.env.OPENROUTER_API_KEY,
      );
      this.openrouterModel = this.requireNonEmptyToken(
        'OPENROUTER_MODEL',
        process.env.OPENROUTER_MODEL ?? '',
      );
      this.openrouterBaseUrl = this.validateOpenrouterBaseUrl(
        process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      );
    }
    this.llmSpikeVerbose = parseBooleanFlag(process.env.LLM_SPIKE_VERBOSE, false);
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
    this.agentTurnCap = this.requireBoundedInteger(
      'AGENT_TURN_CAP',
      process.env.AGENT_TURN_CAP,
      6,
      1,
      70,
    );
    this.workerConcurrency = this.requirePositiveInteger(
      'WORKER_CONCURRENCY',
      process.env.WORKER_CONCURRENCY,
      1,
    );
    // 15s default leaves 15s margin under k8s's default
    // terminationGracePeriodSeconds: 30 for Nest's own shutdown.
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
    this.maxReviewDiffLines = this.requireBoundedInteger(
      'MAX_REVIEW_DIFF_LINES',
      process.env.MAX_REVIEW_DIFF_LINES,
      1000,
      1,
      100_000,
    );
    this.skipGithubAppProbe = parseBooleanFlag(process.env.SKIP_GITHUB_APP_PROBE, false);
    this.skipRedisProbe = parseBooleanFlag(process.env.SKIP_REDIS_PROBE, false);

    if (this.llmProvider === 'openrouter') {
      ConfigService.logger.log(
        `Resolved LLM provider: openrouter (model=${this.openrouterModel}, base=${this.openrouterBaseUrl})`,
      );
    } else {
      ConfigService.logger.log(
        `Resolved LLM provider: anthropic (model=${this.anthropicModel})`,
      );
    }
  }

  private validateOpenrouterBaseUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        `OPENROUTER_BASE_URL must be a valid URL (got "${value}"). Example: https://openrouter.ai/api/v1`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `OPENROUTER_BASE_URL must use http or https (got "${parsed.protocol}").`,
      );
    }
    return value;
  }

  // Reject placeholders ("undefined"/"null") and anything shorter than
  // 16 chars (openssl rand -hex 32 produces 64). Catches obvious
  // misconfigs before they authenticate strangers.
  private requireSecret(name: string, value: string | undefined): string {
    if (!value || value === 'undefined' || value === 'null' || value.length < 16) {
      throw new Error(
        `${name} is missing, a placeholder ("undefined"/"null"), or shorter than 16 characters. Generate one with \`openssl rand -hex 32\` and put it in apps/api/.env before starting apps/api.`,
      );
    }
    return value;
  }

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

  // Reject empty / whitespace-only / embedded-whitespace tokens — those
  // almost always indicate a .env parsing accident.
  private requireNonEmptyToken(name: string, value: string): string {
    if (!value || value.trim() !== value || /\s/.test(value)) {
      throw new Error(
        `${name} must be a non-empty token without whitespace (got "${value}").`,
      );
    }
    return value;
  }

  private resolveAnthropicModel(explicit: string | undefined): string {
    if (explicit !== undefined && explicit !== '') {
      return this.requireNonEmptyToken('ANTHROPIC_MODEL', explicit);
    }
    return 'claude-haiku-4-5-20251001';
  }

  private resolveEnableDryRun(
    explicit: string | undefined,
    nodeEnv: string | undefined,
  ): boolean {
    return parseEnableDryRun(explicit, nodeEnv);
  }

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

  // PEM keys are stored with literal "\n" escape sequences (real
  // newlines break dotenv); normalise back to real newlines for
  // @octokit/auth-app. The "-----BEGIN" probe catches the obvious
  // misconfig of pasting a fingerprint or SSH key instead of the PEM.
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

  private requirePositiveInteger(
    name: string,
    value: string | undefined,
    fallback: number,
  ): number {
    if (value === undefined || value === '') return fallback;
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new Error(`${name} must be a positive integer (got "${value}").`);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite integer (got "${value}").`);
    }
    return parsed;
  }

  private requireBoundedInteger(
    name: string,
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = this.requirePositiveInteger(name, value, fallback);
    if (parsed < min || parsed > max) {
      throw new Error(
        `${name} must be between ${min} and ${max} inclusive (got ${parsed}).`,
      );
    }
    return parsed;
  }
}

// Module-definition-time parsers — used where consumers (forRoot
// wrappers, @Processor decorators) need an env value before
// ConfigService is constructible. Centralising the parse rules keeps
// the no-bare-env discipline intact.

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

export function parseSkipRedisProbe(
  explicit: string | undefined,
  fallback: boolean,
): boolean {
  return parseBooleanFlag(explicit, fallback);
}

export function parseLlmProvider(explicit: string | undefined): LlmProvider {
  if (explicit === undefined || explicit.trim() === '') {
    return DEFAULT_LLM_PROVIDER;
  }
  const normalized = explicit.trim().toLowerCase();
  if (isLlmProvider(normalized)) {
    return normalized;
  }
  throw new Error(
    `LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(', ')} (got "${explicit}").`,
  );
}

export function parseBooleanFlag(
  explicit: string | undefined,
  fallback: boolean,
): boolean {
  if (explicit === undefined || explicit === '') return fallback;
  const normalized = explicit.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

// DOGFOOD_REPOS = comma-separated "owner/repo" tokens. Embedded
// whitespace fails fast (smoking gun for a .env parse accident).
// Empty/unset → empty Set, which silently disables the bot.
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
