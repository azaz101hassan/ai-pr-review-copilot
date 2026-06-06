import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@/config';
import { OpenRouterModule } from '@/infrastructure/openrouter';
import { OpenRouterLlmReviewer } from '@/infrastructure/openrouter';
import { OpenRouterWalkthroughSummarizer } from '@/infrastructure/llm/openrouter-walkthrough-summarizer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';

// Proves the provider-follows binding: under LLM_PROVIDER=openrouter the
// WALKTHROUGH_SUMMARIZER token must resolve to the OpenRouter impl, and
// the existing LLM_REVIEWER binding must remain undisturbed.
//
// ConfigService reads process.env at construction, so the env must be in
// place BEFORE Test.createTestingModule(...).compile(). The shared keys
// mirror HAPPY_ENV from test/config/config.service.spec.ts; the
// OpenRouter branch additionally requires OPENROUTER_API_KEY and
// OPENROUTER_MODEL (OPENROUTER_BASE_URL has a documented default). We
// snapshot the touched keys in beforeEach and restore in afterEach so
// this suite cannot leak LLM_PROVIDER=openrouter into adjacent suites
// (which assume the anthropic default).
describe('OpenRouterModule DI wiring', () => {
  const ENV_KEYS = [
    'GITHUB_WEBHOOK_SECRET',
    'VOYAGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'LLM_PROVIDER',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'NODE_ENV',
    'APP_ID',
    'APP_PRIVATE_KEY',
    'REDIS_URL',
  ] as const;

  const HAPPY_ENV: Record<(typeof ENV_KEYS)[number], string> = {
    GITHUB_WEBHOOK_SECRET: 'webhook-test-secret-0123456789abcdef',
    VOYAGE_API_KEY: 'voyage-test-key-0123456789abcdef',
    ANTHROPIC_API_KEY: 'anthropic-test-key-0123456789abcdef',
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'openrouter-test-key-0123456789abcdef',
    OPENROUTER_MODEL: 'qwen/qwen3-coder',
    NODE_ENV: 'test',
    APP_ID: '123456',
    APP_PRIVATE_KEY:
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEAtest\\n-----END RSA PRIVATE KEY-----',
    REDIS_URL: 'redis://:password@localhost:6379',
  };

  const snapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      snapshot[key] = process.env[key];
      process.env[key] = HAPPY_ENV[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const v = snapshot[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  it('resolves WALKTHROUGH_SUMMARIZER to OpenRouterWalkthroughSummarizer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, OpenRouterModule],
    }).compile();

    const summarizer = moduleRef.get<IWalkthroughSummarizer>(
      WALKTHROUGH_SUMMARIZER,
    );
    expect(summarizer).toBeInstanceOf(OpenRouterWalkthroughSummarizer);

    // Guard the catastrophic misrouting regression: the factory MUST point
    // the OpenAI client at OpenRouter, not the default api.openai.com.
    const config = moduleRef.get(ConfigService);
    const client = (summarizer as any).client;
    expect(client.baseURL).toContain('openrouter.ai');
    expect(client.baseURL).not.toContain('api.openai.com');
    // And the model must be the active OpenRouter model.
    expect((summarizer as any).options.model).toBe(config.openrouterModel);

    await moduleRef.close();
  });

  it('leaves LLM_REVIEWER bound to OpenRouterLlmReviewer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, OpenRouterModule],
    }).compile();

    const reviewer = moduleRef.get(LLM_REVIEWER);
    expect(reviewer).toBeInstanceOf(OpenRouterLlmReviewer);

    await moduleRef.close();
  });
});
