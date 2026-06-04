import { DynamicModule, Logger, Module } from '@nestjs/common';
import { parseLlmProvider } from '@/config';
import { AnthropicModule } from '@/infrastructure/anthropic';
import { OpenRouterModule } from '@/infrastructure/openrouter';

/**
 * Runtime swap between provider modules. `forRoot()` runs at
 * module-definition time and imports either AnthropicModule or
 * OpenRouterModule based on `LLM_PROVIDER`. Both children bind the
 * same `LLM_REVIEWER` DI token; consumers (ReviewsService) inject
 * the interface, not the class, so the swap is transparent at the
 * call site.
 */
@Module({})
export class LlmProviderModule {
  private static readonly logger = new Logger(LlmProviderModule.name);

  static forRoot(): DynamicModule {
    const provider = parseLlmProvider(process.env.LLM_PROVIDER);
    const child = provider === 'openrouter' ? OpenRouterModule : AnthropicModule;

    LlmProviderModule.logger.log(`Active LLM provider: ${provider}`);

    return {
      module: LlmProviderModule,
      imports: [child],
      exports: [child],
    };
  }
}
