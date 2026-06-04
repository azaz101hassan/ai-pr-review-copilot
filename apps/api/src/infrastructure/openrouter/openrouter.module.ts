import { Module } from '@nestjs/common';
import { OpenRouterLlmReviewer } from './openrouter-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';

@Module({
  providers: [{ provide: LLM_REVIEWER, useClass: OpenRouterLlmReviewer }],
  exports: [LLM_REVIEWER],
})
export class OpenRouterModule {}
