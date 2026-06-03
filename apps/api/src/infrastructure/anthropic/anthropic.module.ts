import { Module } from '@nestjs/common';
import { AnthropicLlmReviewer } from './anthropic-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';

// LLM client. Bound to the `LLM_REVIEWER` token so consumers
// (ReviewsService) inject the `ILlmReviewer` interface, not the
// concrete class. Swapping providers is a one-line change here.
@Module({
  providers: [
    {
      provide: LLM_REVIEWER,
      useClass: AnthropicLlmReviewer,
    },
  ],
  exports: [LLM_REVIEWER],
})
export class AnthropicModule {}
