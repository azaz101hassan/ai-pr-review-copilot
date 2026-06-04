import { DynamicModule, Logger, Module } from '@nestjs/common';
import { parseLlmProvider } from '@/config';
import { AnthropicModule } from '@/infrastructure/anthropic';
import { OpenAICompatibleModule } from '@/infrastructure/openai-compatible';

// LLM-provider seam. `forRoot()` is invoked at module-definition time
// from `ReviewsModule.forRoot()` and picks the active adapter based
// on `LLM_PROVIDER`:
//   - 'anthropic' (default): import AnthropicModule (binds
//     LLM_REVIEWER → AnthropicLlmReviewer).
//   - 'openrouter':         import OpenAICompatibleModule (binds
//     LLM_REVIEWER → OpenAICompatibleLlmReviewer).
//
// Both children bind the same DI token; consumers (ReviewsService)
// inject the interface, not the class, so the swap is transparent at
// the call site. Module-eval-time env access goes through
// `parseLlmProvider` from `@/config`, preserving the no-bare-env
// discipline (CLAUDE.md pitfall #3) even before ConfigService is
// constructible.
@Module({})
export class LlmProviderModule {
  private static readonly logger = new Logger(LlmProviderModule.name);

  static forRoot(): DynamicModule {
    const provider = parseLlmProvider(process.env.LLM_PROVIDER);
    const child =
      provider === 'openrouter' ? OpenAICompatibleModule : AnthropicModule;

    LlmProviderModule.logger.log(
      `LlmProviderModule: active adapter = ${provider}`,
    );

    return {
      module: LlmProviderModule,
      imports: [child],
      // Re-export the child so `LLM_REVIEWER` is visible to any
      // module that imports `LlmProviderModule`.
      exports: [child],
    };
  }
}
