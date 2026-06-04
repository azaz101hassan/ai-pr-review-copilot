import { Module } from '@nestjs/common';
import { OpenAICompatibleLlmReviewer } from './openai-compatible-llm-reviewer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';

// OpenAI-compatible LLM client. Active when `LLM_PROVIDER=openrouter`.
// Speaks to any host that exposes an OpenAI-compatible
// `chat/completions` endpoint (OpenRouter, Fireworks AI, Together AI,
// a self-hosted vLLM, etc.); the host is selected via
// `OPENROUTER_BASE_URL`. Mirrors `AnthropicModule` shape so the
// `LlmProviderModule.forRoot()` wrapper can swap one for the other.
@Module({
  providers: [
    {
      provide: LLM_REVIEWER,
      useClass: OpenAICompatibleLlmReviewer,
    },
  ],
  exports: [LLM_REVIEWER],
})
export class OpenAICompatibleModule {}
