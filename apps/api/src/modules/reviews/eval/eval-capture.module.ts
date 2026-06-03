/**
 * Lean NestJS module for the eval capture step.
 *
 * Imports ONLY the modules the capture loop needs:
 *   - ConfigModule  (typed env gateway — validates Anthropic + Voyage + Chroma keys)
 *   - DatabaseModule (SQLite lifecycle — EmbeddingsService injects repository tokens)
 *   - EmbeddingsModule (Voyage + Chroma + corpus loader + search)
 *   - AnthropicModule (LLM_REVIEWER token -> AnthropicLlmReviewer)
 *
 * This avoids booting:
 *   - GithubAppService (GET /app probe)
 *   - QueueModule (Redis ping)
 *   - ReviewsService (stale-row sweep)
 *   - Fail-fast validation of GITHUB_WEBHOOK_SECRET / APP_ID /
 *     APP_PRIVATE_KEY / REDIS_URL
 *
 * ConfigService's constructor still validates the keys this module
 * DOES need (ANTHROPIC_API_KEY, VOYAGE_API_KEY, CHROMA_URL, etc.).
 * Capture reads keys exclusively via ConfigService — never bare env.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule } from '@/modules/embeddings';
import { AnthropicModule } from '@/infrastructure/anthropic';

@Module({
  imports: [ConfigModule, DatabaseModule, EmbeddingsModule, AnthropicModule],
})
export class EvalCaptureModule {}
