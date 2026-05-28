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

  constructor() {
    this.githubWebhookSecret = this.requireSecret(
      'GITHUB_WEBHOOK_SECRET',
      process.env.GITHUB_WEBHOOK_SECRET,
    );
    this.databasePath = process.env.DATABASE_PATH ?? './data/app.sqlite';
    this.port = Number(process.env.PORT) || 3001;

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
