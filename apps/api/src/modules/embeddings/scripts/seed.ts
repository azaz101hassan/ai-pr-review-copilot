// Seed runner — `npm run seed:knowledge --workspace apps/api`.
//
// Bootstraps a headless Nest application context (no HTTP listener),
// resolves EmbeddingsService, calls indexCorpus(), prints the counts,
// exits. Idempotent — re-running updates `updated_at` on existing
// chunks and re-upserts the same vectors into Chroma by id.
//
// Uses SeedModule instead of the full AppModule so operators who only
// need to index conventions into Chroma are not required to supply
// GitHub App credentials or a Redis connection. SeedModule imports only
// the three modules the seed path needs: SeedConfigModule (env
// validation scoped to seed vars), DatabaseModule, and EmbeddingsModule.

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SeedModule } from './seed.module';
import { EmbeddingsService } from '@/modules/embeddings';

async function main(): Promise<void> {
  const logger = new Logger('seed:knowledge');
  const app = await NestFactory.createApplicationContext(SeedModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const embeddings = app.get(EmbeddingsService);
    logger.log('starting indexCorpus()…');
    const result = await embeddings.indexCorpus();
    logger.log(
      `done — sources=${result.insertedSources}, chunks=${result.upsertedChunks}, tokens=${result.totalTokens}`,
    );
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('seed:knowledge failed:', err);
    process.exit(1);
  });
