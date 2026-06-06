import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlmReviewer } from './anthropic-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { AnthropicWalkthroughSummarizer } from '@/infrastructure/llm/anthropic-walkthrough-summarizer';
import {
  FAITHFULNESS_JUDGE,
  type IFaithfulnessJudge,
} from '@/modules/reviews/eval/faithfulness-judge.contract';
import { AnthropicFaithfulnessJudge } from '@/infrastructure/llm/anthropic-faithfulness-judge';
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
    {
      // The eval faithfulness judge also follows the active provider so
      // capture runs against whichever LLM is being evaluated. Default
      // model is Haiku (the historical canonical judge); operators can
      // override per run if needed.
      provide: FAITHFULNESS_JUDGE,
      useFactory: (config: ConfigService): IFaithfulnessJudge =>
        new AnthropicFaithfulnessJudge(
          new Anthropic({ apiKey: config.anthropicApiKey }),
        ),
      inject: [ConfigService],
    },
  ],
  exports: [LLM_REVIEWER, WALKTHROUGH_SUMMARIZER, FAITHFULNESS_JUDGE],
})
export class AnthropicModule {}
