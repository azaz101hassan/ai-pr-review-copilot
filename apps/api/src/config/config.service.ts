import { Injectable } from '@nestjs/common';

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
}
