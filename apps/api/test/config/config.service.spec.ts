import { Logger } from '@nestjs/common';
import { ConfigService } from '@/config';

// ConfigService reads process.env at construction. Every test below
// preserves the surrounding shell env, mutates only what it asserts on,
// and restores in afterEach so adjacent specs (especially the e2e
// blocks that load AppModule) aren't tainted.
describe('ConfigService', () => {
  const snapshot = {
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    CHROMA_URL: process.env.CHROMA_URL,
    CHROMA_COLLECTION: process.env.CHROMA_COLLECTION,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ENABLE_DRY_RUN: process.env.ENABLE_DRY_RUN,
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_PATH: process.env.DATABASE_PATH,
    PORT: process.env.PORT,
  };

  const VALID_WEBHOOK_SECRET = 'webhook-test-secret-0123456789abcdef';
  const VALID_VOYAGE_KEY = 'voyage-test-key-0123456789abcdef';
  const VALID_ANTHROPIC_KEY = 'anthropic-test-key-0123456789abcdef';

  function setEnv(overrides: Partial<Record<keyof typeof snapshot, string | undefined>>) {
    for (const key of Object.keys(snapshot) as (keyof typeof snapshot)[]) {
      const v = overrides[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }

  // Shared happy-path env for tests that don't care about a specific
  // var — sets every required key + a deterministic NODE_ENV.
  const HAPPY_ENV = {
    GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
    VOYAGE_API_KEY: VALID_VOYAGE_KEY,
    ANTHROPIC_API_KEY: VALID_ANTHROPIC_KEY,
    NODE_ENV: 'test',
  } as const;

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('happy paths', () => {
    it('exposes all four Day-2 vars when set explicitly', () => {
      setEnv({
        ...HAPPY_ENV,
        CHROMA_URL: 'http://chroma.internal:9000',
        CHROMA_COLLECTION: 'custom-collection',
        EMBEDDING_MODEL: 'voyage-3-lite',
      });

      const cfg = new ConfigService();

      expect(cfg.voyageApiKey).toBe(VALID_VOYAGE_KEY);
      expect(cfg.chromaUrl).toBe('http://chroma.internal:9000');
      expect(cfg.chromaCollection).toBe('custom-collection');
      expect(cfg.embeddingModel).toBe('voyage-3-lite');
    });

    it('falls back to documented defaults when only required keys are set', () => {
      setEnv(HAPPY_ENV);

      const cfg = new ConfigService();

      expect(cfg.chromaUrl).toBe('http://localhost:8000');
      expect(cfg.chromaCollection).toBe('code-style-rules');
      expect(cfg.embeddingModel).toBe('voyage-code-3');
    });

    it('accepts an https Chroma URL (remote-deployed scenario)', () => {
      setEnv({
        ...HAPPY_ENV,
        CHROMA_URL: 'https://chroma.example.com',
      });

      const cfg = new ConfigService();
      expect(cfg.chromaUrl).toBe('https://chroma.example.com');
    });
  });

  describe('error paths', () => {
    it('throws when VOYAGE_API_KEY is missing', () => {
      setEnv({ ...HAPPY_ENV, VOYAGE_API_KEY: undefined });
      expect(() => new ConfigService()).toThrow(/VOYAGE_API_KEY/);
    });

    it('throws when VOYAGE_API_KEY is the literal string "undefined"', () => {
      setEnv({ ...HAPPY_ENV, VOYAGE_API_KEY: 'undefined' });
      expect(() => new ConfigService()).toThrow(/VOYAGE_API_KEY/);
    });

    it('throws when VOYAGE_API_KEY is shorter than 16 chars', () => {
      setEnv({ ...HAPPY_ENV, VOYAGE_API_KEY: 'short' });
      expect(() => new ConfigService()).toThrow(/VOYAGE_API_KEY/);
    });

    it('throws when CHROMA_URL is not a parseable URL', () => {
      setEnv({ ...HAPPY_ENV, CHROMA_URL: 'definitely not a url' });
      expect(() => new ConfigService()).toThrow(/CHROMA_URL/);
    });

    it('throws when CHROMA_URL uses an unsupported protocol', () => {
      setEnv({ ...HAPPY_ENV, CHROMA_URL: 'ftp://localhost:8000' });
      expect(() => new ConfigService()).toThrow(/CHROMA_URL/);
    });

    it('throws when CHROMA_COLLECTION contains whitespace', () => {
      setEnv({ ...HAPPY_ENV, CHROMA_COLLECTION: 'has space' });
      expect(() => new ConfigService()).toThrow(/CHROMA_COLLECTION/);
    });

    it('throws when EMBEDDING_MODEL is empty', () => {
      setEnv({ ...HAPPY_ENV, EMBEDDING_MODEL: '' });
      expect(() => new ConfigService()).toThrow(/EMBEDDING_MODEL/);
    });
  });

  // Day 3 ─ Anthropic + dry-run gate.
  describe('Anthropic API key', () => {
    it('exposes anthropicApiKey when set', () => {
      setEnv(HAPPY_ENV);
      expect(new ConfigService().anthropicApiKey).toBe(VALID_ANTHROPIC_KEY);
    });

    it('throws when ANTHROPIC_API_KEY is missing', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_API_KEY: undefined });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('throws when ANTHROPIC_API_KEY is the literal "undefined"', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_API_KEY: 'undefined' });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('throws when ANTHROPIC_API_KEY is shorter than 16 chars', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_API_KEY: 'sk-short' });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_API_KEY/);
    });
  });

  describe('Anthropic model resolution', () => {
    it('defaults to Sonnet when NODE_ENV=production and ANTHROPIC_MODEL is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'production' });
      expect(new ConfigService().anthropicModel).toBe('claude-sonnet-4-6');
    });

    it('defaults to Haiku when NODE_ENV=development and ANTHROPIC_MODEL is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'development' });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('defaults to Haiku when NODE_ENV=test (any non-production)', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'test' });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('defaults to Haiku when NODE_ENV is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: undefined });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('explicit ANTHROPIC_MODEL wins over NODE_ENV defaults (Haiku in prod)', () => {
      setEnv({
        ...HAPPY_ENV,
        NODE_ENV: 'production',
        ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
      });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('explicit ANTHROPIC_MODEL wins over NODE_ENV defaults (Sonnet in dev)', () => {
      setEnv({
        ...HAPPY_ENV,
        NODE_ENV: 'development',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      });
      expect(new ConfigService().anthropicModel).toBe('claude-sonnet-4-6');
    });

    it('explicit ANTHROPIC_MODEL accepts other model ids verbatim', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_MODEL: 'claude-opus-4-7' });
      expect(new ConfigService().anthropicModel).toBe('claude-opus-4-7');
    });

    it('throws when explicit ANTHROPIC_MODEL contains whitespace', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_MODEL: 'claude sonnet 4-6' });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_MODEL/);
    });

    it('logs the resolved model at construction', () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'production' });

      new ConfigService();

      const resolvedLog = logSpy.mock.calls.find((args) =>
        typeof args[0] === 'string' && /^Resolved model:\s/.test(args[0] as string),
      );
      expect(resolvedLog).toBeDefined();
      expect(resolvedLog![0]).toContain('claude-sonnet-4-6');
      logSpy.mockRestore();
    });
  });

  describe('ENABLE_DRY_RUN resolution', () => {
    it('defaults to true when NODE_ENV=development and ENABLE_DRY_RUN is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'development' });
      expect(new ConfigService().enableDryRun).toBe(true);
    });

    it('defaults to false when NODE_ENV=production and ENABLE_DRY_RUN is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'production' });
      expect(new ConfigService().enableDryRun).toBe(false);
    });

    it('defaults to false when NODE_ENV=test and ENABLE_DRY_RUN is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'test' });
      expect(new ConfigService().enableDryRun).toBe(false);
    });

    it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES'])(
      'parses "%s" as true regardless of NODE_ENV',
      (value) => {
        setEnv({ ...HAPPY_ENV, NODE_ENV: 'production', ENABLE_DRY_RUN: value });
        expect(new ConfigService().enableDryRun).toBe(true);
      },
    );

    it.each(['false', '0', 'no', 'garbage', ' '])(
      'parses "%s" as false regardless of NODE_ENV',
      (value) => {
        setEnv({ ...HAPPY_ENV, NODE_ENV: 'development', ENABLE_DRY_RUN: value });
        expect(new ConfigService().enableDryRun).toBe(false);
      },
    );
  });
});
