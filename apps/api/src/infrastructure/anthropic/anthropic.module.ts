import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlmReviewer } from './anthropic-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { AnthropicWalkthroughSummarizer } from '@/infrastructure/llm/anthropic-walkthrough-summarizer';
import { ConfigService } from '@/config';

@Module({
  providers: [
    { provide: LLM_REVIEWER, useClass: AnthropicLlmReviewer },
    {
      // The walkthrough summarizer follows the active provider — bound
      // here so `LLM_PROVIDER=anthropic` resolves the Anthropic impl,
      // mirroring the LLM_REVIEWER binding above.
      provide: WALKTHROUGH_SUMMARIZER,
      useFactory: (config: ConfigService): IWalkthroughSummarizer =>
        new AnthropicWalkthroughSummarizer(
          new Anthropic({ apiKey: config.anthropicApiKey }),
          { model: config.anthropicModel },
        ),
      inject: [ConfigService],
    },
  ],
  exports: [LLM_REVIEWER, WALKTHROUGH_SUMMARIZER],
})
export class AnthropicModule {}
