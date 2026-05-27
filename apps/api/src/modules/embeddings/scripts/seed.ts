// Seed runner — `npm run seed:knowledge --workspace apps/api`.
//
// Bootstraps a headless Nest application context (no HTTP listener),
// resolves EmbeddingsService, calls indexCorpus(), prints the counts,
// exits. Idempotent — re-running updates `updated_at` on existing
// chunks and re-upserts the same vectors into Chroma by id.

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { EmbeddingsService } from '@/modules/embeddings';

async function main(): Promise<void> {
  const logger = new Logger('seed:knowledge');
  const app = await NestFactory.createApplicationContext(AppModule, {
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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed:knowledge failed:', err);
  process.exit(1);
});
