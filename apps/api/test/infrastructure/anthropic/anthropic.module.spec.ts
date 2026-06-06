import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@/config';
import { AnthropicModule } from '@/infrastructure/anthropic';
import { AnthropicLlmReviewer } from '@/infrastructure/anthropic';
import { AnthropicWalkthroughSummarizer } from '@/infrastructure/llm/anthropic-walkthrough-summarizer';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';

// Proves the provider-follows binding: under LLM_PROVIDER=anthropic the
// WALKTHROUGH_SUMMARIZER token must resolve to the Anthropic impl, and
// the existing LLM_REVIEWER binding must remain undisturbed.
//
// ConfigService reads process.env at construction, so the env must be in
// place BEFORE Test.createTestingModule(...).compile(). The keys mirror
// HAPPY_ENV from test/config/config.service.spec.ts — the minimal set
// that lets ConfigService construct without fail-fast. We snapshot the
// touched keys in beforeEach and restore in afterEach so neither this
// suite nor adjacent ones leak env.
describe('AnthropicModule DI wiring', () => {
  const ENV_KEYS = [
    'GITHUB_WEBHOOK_SECRET',
    'VOYAGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'LLM_PROVIDER',
    'NODE_ENV',
    'APP_ID',
    'APP_PRIVATE_KEY',
    'REDIS_URL',
  ] as const;

  const HAPPY_ENV: Record<(typeof ENV_KEYS)[number], string> = {
    GITHUB_WEBHOOK_SECRET: 'webhook-test-secret-0123456789abcdef',
    VOYAGE_API_KEY: 'voyage-test-key-0123456789abcdef',
    ANTHROPIC_API_KEY: 'anthropic-test-key-0123456789abcdef',
    LLM_PROVIDER: 'anthropic',
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

  it('resolves WALKTHROUGH_SUMMARIZER to AnthropicWalkthroughSummarizer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, AnthropicModule],
    }).compile();

    const summarizer = moduleRef.get<IWalkthroughSummarizer>(
      WALKTHROUGH_SUMMARIZER,
    );
    expect(summarizer).toBeInstanceOf(AnthropicWalkthroughSummarizer);

    // The factory must wire the active Anthropic model into the summarizer.
    const config = moduleRef.get(ConfigService);
    expect((summarizer as any).options.model).toBe(config.anthropicModel);

    await moduleRef.close();
  });

  it('leaves LLM_REVIEWER bound to AnthropicLlmReviewer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, AnthropicModule],
    }).compile();

    const reviewer = moduleRef.get(LLM_REVIEWER);
    expect(reviewer).toBeInstanceOf(AnthropicLlmReviewer);

    await moduleRef.close();
  });
});
