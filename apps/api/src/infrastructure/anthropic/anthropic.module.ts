import { Module } from '@nestjs/common';
import { AnthropicLlmReviewer } from './anthropic-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';

@Module({
  providers: [{ provide: LLM_REVIEWER, useClass: AnthropicLlmReviewer }],
  exports: [LLM_REVIEWER],
})
export class AnthropicModule {}
