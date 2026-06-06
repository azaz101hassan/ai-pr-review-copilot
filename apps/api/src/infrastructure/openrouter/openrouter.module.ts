import { Module } from '@nestjs/common';
import OpenAI from 'openai';
import { OpenRouterLlmReviewer } from './openrouter-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { OpenRouterWalkthroughSummarizer } from '@/infrastructure/llm/openrouter-walkthrough-summarizer';
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
  ],
  exports: [LLM_REVIEWER, WALKTHROUGH_SUMMARIZER],
})
export class OpenRouterModule {}
