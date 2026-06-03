// Minimal application context for the seed:knowledge script.
//
// Imports only the modules the seed path actually needs:
//   - ConfigModule (global, provides ConfigService)
//   - DatabaseModule (global, opens SQLite + provides repository tokens)
//   - EmbeddingsModule (Voyage + Chroma adapters + EmbeddingsService)
//
// Deliberately excludes every module that carries an external boot probe:
//   - GithubModule  — runs GET /app against the GitHub API on onModuleInit
//   - WebhookModule — transitively imports QueueModule
//   - QueueModule   — pings Redis on onModuleInit (unless SKIP_REDIS_PROBE)
//   - ReviewsModule — imports QueueModule + GithubModule
//   - DashboardModule — review-read surface; not needed by indexCorpus()
//
// ConfigService still validates the env vars it knows about; seed
// operators must supply the vars that ConfigService reads on
// construction. The set that seed-only operators need is:
//   VOYAGE_API_KEY, DATABASE_PATH (optional), CHROMA_URL (optional),
//   CHROMA_COLLECTION (optional), EMBEDDING_MODEL (optional).
//
// ConfigService also reads GITHUB_WEBHOOK_SECRET, APP_ID, APP_PRIVATE_KEY,
// REDIS_URL, and ANTHROPIC_API_KEY and fails fast when they are absent.
// To avoid requiring those for seed-only use, this module substitutes a
// lean SeedConfigService in place of the full ConfigService. It exposes
// only the properties that the seed path actually injects (databasePath,
// voyageApiKey, embeddingModel, chromaUrl, chromaCollection), leaving
// everything else absent. TypeScript ensures no provider downstream of
// this context reads a property the seed context doesn't provide.
//
// createApplicationContext skips HTTP server bootstrap entirely, so no
// NestJS HTTP adapter, no route registration, and no ThrottlerModule are
// needed.

import { Module, Injectable, Global } from '@nestjs/common';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule } from '@/modules/embeddings';
import { ConfigService } from '@/config';

// Properties of ConfigService that the seed bootstrap path reads.
// DatabaseService uses databasePath (optional — it falls back to
// process.env.DATABASE_PATH when the injected service omits it).
// VoyageEmbeddingProvider uses voyageApiKey + embeddingModel.
// ChromaVectorStore uses chromaUrl + chromaCollection.
type SeedConfigShape = Pick<
  ConfigService,
  'databasePath' | 'voyageApiKey' | 'embeddingModel' | 'chromaUrl' | 'chromaCollection'
>;

@Injectable()
class SeedConfigService implements SeedConfigShape {
  readonly databasePath: string;
  readonly voyageApiKey: string;
  readonly embeddingModel: string;
  readonly chromaUrl: string;
  readonly chromaCollection: string;

  constructor() {
    this.voyageApiKey = this.requireSecret(
      'VOYAGE_API_KEY',
      process.env.VOYAGE_API_KEY,
    );
    this.databasePath = process.env.DATABASE_PATH ?? './data/app.sqlite';
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

  private requireSecret(name: string, value: string | undefined): string {
    if (!value || value === 'undefined' || value === 'null' || value.length < 16) {
      throw new Error(
        `${name} is missing, a placeholder ("undefined"/"null"), or shorter than 16 characters.`,
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

  private requireNonEmptyToken(name: string, value: string): string {
    if (!value || value.trim() !== value || /\s/.test(value)) {
      throw new Error(
        `${name} must be a non-empty token without whitespace (got "${value}").`,
      );
    }
    return value;
  }
}

// @Global() so DatabaseModule and EmbeddingsModule — which are themselves
// global or import global modules — can resolve ConfigService without each
// importing SeedConfigModule explicitly.
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useClass: SeedConfigService,
    },
  ],
  exports: [ConfigService],
})
class SeedConfigModule {}

// The top-level module the seed script passes to
// NestFactory.createApplicationContext(). Importing SeedConfigModule first
// registers the ConfigService binding before DatabaseModule and
// EmbeddingsModule resolve their providers.
@Module({
  imports: [SeedConfigModule, DatabaseModule, EmbeddingsModule],
})
export class SeedModule {}
