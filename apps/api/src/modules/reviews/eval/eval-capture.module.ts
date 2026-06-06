/**
 * Lean NestJS module for the eval capture step.
 *
 * Imports ONLY the modules the capture loop needs:
 *   - ConfigModule  (typed env gateway — validates Anthropic + Voyage + Chroma keys)
 *   - DatabaseModule (SQLite lifecycle — EmbeddingsService injects repository tokens)
 *   - EmbeddingsModule (Voyage + Chroma + corpus loader + search)
 *   - LlmProviderModule.forRoot() (binds LLM_REVIEWER + WALKTHROUGH_SUMMARIZER
 *     + FAITHFULNESS_JUDGE to the provider selected by LLM_PROVIDER —
 *     Anthropic or OpenRouter — so a capture run judges with the same
 *     provider it reviews with)
 *
 * This avoids booting:
 *   - GithubAppService (GET /app probe)
 *   - QueueModule (Redis ping)
 *   - ReviewsService (stale-row sweep)
 *   - Fail-fast validation of GITHUB_WEBHOOK_SECRET / APP_ID /
 *     APP_PRIVATE_KEY / REDIS_URL
 *
 * ConfigService's constructor still validates the keys this module
 * DOES need (active provider's key, VOYAGE_API_KEY, CHROMA_URL, etc.).
 * Capture reads keys exclusively via ConfigService — never bare env.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule } from '@/modules/embeddings';
import { LlmProviderModule } from '@/infrastructure/llm';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    EmbeddingsModule,
    LlmProviderModule.forRoot(),
  ],
})
export class EvalCaptureModule {}
