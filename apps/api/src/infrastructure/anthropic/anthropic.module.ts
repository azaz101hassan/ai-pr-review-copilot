import { Module } from '@nestjs/common';
import { AnthropicLlmReviewer } from './anthropic-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';

// Day 3 LLM client. Bound to the `LLM_REVIEWER` token so consumers
// (ReviewsService) inject the `ILlmReviewer` interface, not the
// concrete class. Swapping to a different provider is a one-line
// change in this file. Same pattern as `VoyageModule` for Day 2.
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
