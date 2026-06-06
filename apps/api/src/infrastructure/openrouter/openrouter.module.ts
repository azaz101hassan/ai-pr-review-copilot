import { Module } from '@nestjs/common';
import OpenAI from 'openai';
import { OpenRouterLlmReviewer } from './openrouter-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { OpenRouterWalkthroughSummarizer } from '@/infrastructure/llm/openrouter-walkthrough-summarizer';
import {
  FAITHFULNESS_JUDGE,
  type IFaithfulnessJudge,
} from '@/modules/reviews/eval/faithfulness-judge.contract';
import { OpenRouterFaithfulnessJudge } from '@/infrastructure/llm/openrouter-faithfulness-judge';
import { ConfigService } from '@/config';

@Module({
  providers: [
    { provide: LLM_REVIEWER, useClass: OpenRouterLlmReviewer },
    {
      // The walkthrough summarizer follows the active provider — bound
      // here so `LLM_PROVIDER=openrouter` resolves the OpenRouter impl,
      // mirroring the LLM_REVIEWER binding above.
      provide: WALKTHROUGH_SUMMARIZER,
      useFactory: (config: ConfigService): IWalkthroughSummarizer =>
        new OpenRouterWalkthroughSummarizer(
          new OpenAI({
            apiKey: config.openrouterApiKey,
            baseURL: config.openrouterBaseUrl,
          }),
          { model: config.openrouterModel },
        ),
      inject: [ConfigService],
    },
    {
      // The eval faithfulness judge also follows the active provider so
      // capture runs against whichever LLM is being evaluated. The
      // OpenRouter adapter uses the same model id as the reviewer so the
      // eval cost matches production behaviour.
      provide: FAITHFULNESS_JUDGE,
      useFactory: (config: ConfigService): IFaithfulnessJudge =>
        new OpenRouterFaithfulnessJudge(
          new OpenAI({
            apiKey: config.openrouterApiKey,
            baseURL: config.openrouterBaseUrl,
          }),
          { model: config.openrouterModel },
        ),
      inject: [ConfigService],
    },
  ],
  exports: [LLM_REVIEWER, WALKTHROUGH_SUMMARIZER, FAITHFULNESS_JUDGE],
})
export class OpenRouterModule {}
