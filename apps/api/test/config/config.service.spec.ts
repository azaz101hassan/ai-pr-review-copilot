import { Logger } from '@nestjs/common';
import {
  ConfigService,
  parseBooleanFlag,
  parseDogfoodRepos,
} from '@/config';

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
    APP_ID: process.env.APP_ID,
    APP_PRIVATE_KEY: process.env.APP_PRIVATE_KEY,
    REDIS_URL: process.env.REDIS_URL,
    DOGFOOD_REPOS: process.env.DOGFOOD_REPOS,
    ANTHROPIC_USE_ZERO_RETENTION: process.env.ANTHROPIC_USE_ZERO_RETENTION,
    ANTHROPIC_AGENT_TURN_CAP: process.env.ANTHROPIC_AGENT_TURN_CAP,
    WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY,
    SHUTDOWN_DRAIN_TIMEOUT_MS: process.env.SHUTDOWN_DRAIN_TIMEOUT_MS,
    MAX_DIFF_BYTES: process.env.MAX_DIFF_BYTES,
    MAX_REVIEW_DIFF_LINES: process.env.MAX_REVIEW_DIFF_LINES,
    SKIP_GITHUB_APP_PROBE: process.env.SKIP_GITHUB_APP_PROBE,
    SKIP_REDIS_PROBE: process.env.SKIP_REDIS_PROBE,
  };

  const VALID_WEBHOOK_SECRET = 'webhook-test-secret-0123456789abcdef';
  const VALID_VOYAGE_KEY = 'voyage-test-key-0123456789abcdef';
  const VALID_ANTHROPIC_KEY = 'anthropic-test-key-0123456789abcdef';
  const VALID_APP_ID = '123456';
  // Multi-line PEM stored with literal \n escape (the .env shape).
  const VALID_PEM_ESCAPED =
    '-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEAtest\\n-----END RSA PRIVATE KEY-----';
  const VALID_REDIS_URL = 'redis://:password@localhost:6379';

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
    APP_ID: VALID_APP_ID,
    APP_PRIVATE_KEY: VALID_PEM_ESCAPED,
    REDIS_URL: VALID_REDIS_URL,
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
    // The bot targets small focused diffs (MAX_REVIEW_DIFF_LINES). On
    // that surface Haiku's quality matches Sonnet's at ~⅓ the per-review
    // cost, so Haiku is the deliberate default in every environment.
    // Operators who want Sonnet on specific repos set ANTHROPIC_MODEL
    // explicitly.
    it('defaults to Haiku regardless of NODE_ENV (production)', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'production' });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('defaults to Haiku regardless of NODE_ENV (development)', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'development' });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('defaults to Haiku regardless of NODE_ENV (test)', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: 'test' });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('defaults to Haiku when NODE_ENV is unset', () => {
      setEnv({ ...HAPPY_ENV, NODE_ENV: undefined });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
    });

    it('explicit ANTHROPIC_MODEL=Sonnet overrides the Haiku default', () => {
      setEnv({
        ...HAPPY_ENV,
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      });
      expect(new ConfigService().anthropicModel).toBe('claude-sonnet-4-6');
    });

    it('explicit ANTHROPIC_MODEL=Haiku is a valid (no-op) override', () => {
      setEnv({
        ...HAPPY_ENV,
        ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
      });
      expect(new ConfigService().anthropicModel).toBe('claude-haiku-4-5-20251001');
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
      setEnv(HAPPY_ENV);

      new ConfigService();

      const resolvedLog = logSpy.mock.calls.find((args) =>
        typeof args[0] === 'string' && /^Resolved model:\s/.test(args[0] as string),
      );
      expect(resolvedLog).toBeDefined();
      expect(resolvedLog![0]).toContain('claude-haiku-4-5-20251001');
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

  // Day 5 ─ real-PR integration env surface.
  describe('GitHub App credentials', () => {
    it('exposes appId and appPrivateKey when both are set', () => {
      setEnv(HAPPY_ENV);
      const cfg = new ConfigService();
      expect(cfg.appId).toBe(VALID_APP_ID);
      // PEM stored with literal \n is normalised back to real newlines
      // so @octokit/auth-app's crypto parsing succeeds at runtime.
      expect(cfg.appPrivateKey.startsWith('-----BEGIN')).toBe(true);
      expect(cfg.appPrivateKey).toContain('\n');
      expect(cfg.appPrivateKey).not.toContain('\\n');
    });

    it('throws when APP_ID is missing', () => {
      setEnv({ ...HAPPY_ENV, APP_ID: undefined });
      expect(() => new ConfigService()).toThrow(/APP_ID/);
    });

    it('throws when APP_ID is non-numeric', () => {
      setEnv({ ...HAPPY_ENV, APP_ID: 'abc' });
      expect(() => new ConfigService()).toThrow(/APP_ID/);
    });

    it('throws when APP_ID is zero or negative', () => {
      setEnv({ ...HAPPY_ENV, APP_ID: '0' });
      expect(() => new ConfigService()).toThrow(/APP_ID/);
    });

    it('throws when APP_PRIVATE_KEY is missing', () => {
      setEnv({ ...HAPPY_ENV, APP_PRIVATE_KEY: undefined });
      expect(() => new ConfigService()).toThrow(/APP_PRIVATE_KEY/);
    });

    it('throws when APP_PRIVATE_KEY lacks the -----BEGIN prefix', () => {
      setEnv({ ...HAPPY_ENV, APP_PRIVATE_KEY: 'not-a-pem-at-all' });
      expect(() => new ConfigService()).toThrow(/APP_PRIVATE_KEY/);
    });

    it('accepts a PEM with real newlines (multi-line var)', () => {
      const realNewlinePem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
      setEnv({ ...HAPPY_ENV, APP_PRIVATE_KEY: realNewlinePem });
      const cfg = new ConfigService();
      expect(cfg.appPrivateKey).toBe(realNewlinePem);
    });
  });

  describe('Redis URL', () => {
    it('accepts a redis:// URL', () => {
      setEnv({ ...HAPPY_ENV, REDIS_URL: 'redis://localhost:6379' });
      expect(new ConfigService().redisUrl).toBe('redis://localhost:6379');
    });

    it('accepts a rediss:// (TLS) URL', () => {
      setEnv({ ...HAPPY_ENV, REDIS_URL: 'rediss://user:pw@redis.example:6379' });
      expect(new ConfigService().redisUrl).toBe('rediss://user:pw@redis.example:6379');
    });

    it('throws when REDIS_URL is missing', () => {
      setEnv({ ...HAPPY_ENV, REDIS_URL: undefined });
      expect(() => new ConfigService()).toThrow(/REDIS_URL/);
    });

    it('throws when REDIS_URL is unparseable', () => {
      setEnv({ ...HAPPY_ENV, REDIS_URL: 'not a url' });
      expect(() => new ConfigService()).toThrow(/REDIS_URL/);
    });

    it('throws when REDIS_URL uses an unsupported scheme', () => {
      setEnv({ ...HAPPY_ENV, REDIS_URL: 'http://localhost:6379' });
      expect(() => new ConfigService()).toThrow(/REDIS_URL/);
    });
  });

  describe('DOGFOOD_REPOS allowlist', () => {
    it('defaults to an empty Set when unset', () => {
      setEnv(HAPPY_ENV);
      expect(new ConfigService().dogfoodRepos.size).toBe(0);
    });

    it('defaults to an empty Set when explicitly empty (kill switch)', () => {
      setEnv({ ...HAPPY_ENV, DOGFOOD_REPOS: '' });
      expect(new ConfigService().dogfoodRepos.size).toBe(0);
    });

    it('parses a single owner/repo token', () => {
      setEnv({ ...HAPPY_ENV, DOGFOOD_REPOS: 'azaz101hassan/ai-pr-review-copilot' });
      const repos = new ConfigService().dogfoodRepos;
      expect(repos.has('azaz101hassan/ai-pr-review-copilot')).toBe(true);
      expect(repos.size).toBe(1);
    });

    it('parses comma-separated tokens and trims whitespace', () => {
      setEnv({
        ...HAPPY_ENV,
        DOGFOOD_REPOS: ' foo/bar , baz/qux ,, foo/bar ',
      });
      const repos = new ConfigService().dogfoodRepos;
      expect(repos.size).toBe(2);
      expect(repos.has('foo/bar')).toBe(true);
      expect(repos.has('baz/qux')).toBe(true);
    });

    it('throws when a token contains embedded whitespace', () => {
      setEnv({ ...HAPPY_ENV, DOGFOOD_REPOS: 'foo / bar' });
      expect(() => new ConfigService()).toThrow(/DOGFOOD_REPOS/);
    });

    it('throws when a token is not in owner/repo form', () => {
      setEnv({ ...HAPPY_ENV, DOGFOOD_REPOS: 'just-a-name' });
      expect(() => new ConfigService()).toThrow(/DOGFOOD_REPOS/);
    });
  });

  describe('Worker / drain / diff-cap integers', () => {
    it('applies documented defaults when all are unset', () => {
      setEnv(HAPPY_ENV);
      const cfg = new ConfigService();
      expect(cfg.workerConcurrency).toBe(1);
      // F14 closure — default lowered to 15s for 15s margin under
      // k8s default terminationGracePeriodSeconds: 30.
      expect(cfg.shutdownDrainTimeoutMs).toBe(15_000);
      expect(cfg.maxDiffBytes).toBe(256 * 1024);
    });

    it('honours explicit values', () => {
      setEnv({
        ...HAPPY_ENV,
        WORKER_CONCURRENCY: '4',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '5000',
        MAX_DIFF_BYTES: '1048576',
      });
      const cfg = new ConfigService();
      expect(cfg.workerConcurrency).toBe(4);
      expect(cfg.shutdownDrainTimeoutMs).toBe(5000);
      expect(cfg.maxDiffBytes).toBe(1_048_576);
    });

    it('throws when WORKER_CONCURRENCY is zero', () => {
      setEnv({ ...HAPPY_ENV, WORKER_CONCURRENCY: '0' });
      expect(() => new ConfigService()).toThrow(/WORKER_CONCURRENCY/);
    });

    it('throws when WORKER_CONCURRENCY is non-numeric', () => {
      setEnv({ ...HAPPY_ENV, WORKER_CONCURRENCY: 'four' });
      expect(() => new ConfigService()).toThrow(/WORKER_CONCURRENCY/);
    });

    it('throws when SHUTDOWN_DRAIN_TIMEOUT_MS is negative-looking', () => {
      setEnv({ ...HAPPY_ENV, SHUTDOWN_DRAIN_TIMEOUT_MS: '-100' });
      expect(() => new ConfigService()).toThrow(/SHUTDOWN_DRAIN_TIMEOUT_MS/);
    });

    it('throws when MAX_DIFF_BYTES is non-numeric', () => {
      setEnv({ ...HAPPY_ENV, MAX_DIFF_BYTES: '1MB' });
      expect(() => new ConfigService()).toThrow(/MAX_DIFF_BYTES/);
    });
  });

  describe('ANTHROPIC_AGENT_TURN_CAP', () => {
    it('defaults to 6 when unset', () => {
      setEnv(HAPPY_ENV);
      expect(new ConfigService().anthropicAgentTurnCap).toBe(6);
    });

    it('honours an explicit value within bounds', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_AGENT_TURN_CAP: '15' });
      expect(new ConfigService().anthropicAgentTurnCap).toBe(15);
    });

    it('accepts the upper bound of 20', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_AGENT_TURN_CAP: '20' });
      expect(new ConfigService().anthropicAgentTurnCap).toBe(20);
    });

    it('throws when the value is zero', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_AGENT_TURN_CAP: '0' });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_AGENT_TURN_CAP/);
    });

    it('throws when the value exceeds the upper bound', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_AGENT_TURN_CAP: '21' });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_AGENT_TURN_CAP/);
    });

    it('throws when the value is non-numeric', () => {
      setEnv({ ...HAPPY_ENV, ANTHROPIC_AGENT_TURN_CAP: 'fifteen' });
      expect(() => new ConfigService()).toThrow(/ANTHROPIC_AGENT_TURN_CAP/);
    });
  });

  describe('MAX_REVIEW_DIFF_LINES', () => {
    it('defaults to 500 when unset (small-PR copilot threshold)', () => {
      setEnv(HAPPY_ENV);
      expect(new ConfigService().maxReviewDiffLines).toBe(500);
    });

    it('honours an explicit value within bounds', () => {
      setEnv({ ...HAPPY_ENV, MAX_REVIEW_DIFF_LINES: '250' });
      expect(new ConfigService().maxReviewDiffLines).toBe(250);
    });

    it('accepts the lower bound of 1', () => {
      setEnv({ ...HAPPY_ENV, MAX_REVIEW_DIFF_LINES: '1' });
      expect(new ConfigService().maxReviewDiffLines).toBe(1);
    });

    it('accepts the upper bound of 100000', () => {
      setEnv({ ...HAPPY_ENV, MAX_REVIEW_DIFF_LINES: '100000' });
      expect(new ConfigService().maxReviewDiffLines).toBe(100000);
    });

    it('throws when the value is zero', () => {
      setEnv({ ...HAPPY_ENV, MAX_REVIEW_DIFF_LINES: '0' });
      expect(() => new ConfigService()).toThrow(/MAX_REVIEW_DIFF_LINES/);
    });

    it('throws when the value exceeds the upper bound', () => {
      setEnv({ ...HAPPY_ENV, MAX_REVIEW_DIFF_LINES: '100001' });
      expect(() => new ConfigService()).toThrow(/MAX_REVIEW_DIFF_LINES/);
    });

    it('throws when the value is non-numeric', () => {
      setEnv({ ...HAPPY_ENV, MAX_REVIEW_DIFF_LINES: 'lots' });
      expect(() => new ConfigService()).toThrow(/MAX_REVIEW_DIFF_LINES/);
    });
  });

  describe('ANTHROPIC_USE_ZERO_RETENTION', () => {
    it('defaults to false when unset (operator opt-in for production)', () => {
      setEnv(HAPPY_ENV);
      expect(new ConfigService().anthropicUseZeroRetention).toBe(false);
    });

    it.each(['true', 'TRUE', '1', 'yes', 'Yes'])(
      'parses "%s" as true',
      (value) => {
        setEnv({ ...HAPPY_ENV, ANTHROPIC_USE_ZERO_RETENTION: value });
        expect(new ConfigService().anthropicUseZeroRetention).toBe(true);
      },
    );

    it.each(['false', '0', 'no', 'maybe'])(
      'parses "%s" as false',
      (value) => {
        setEnv({ ...HAPPY_ENV, ANTHROPIC_USE_ZERO_RETENTION: value });
        expect(new ConfigService().anthropicUseZeroRetention).toBe(false);
      },
    );
  });
});

// Module-level parser helpers are exported so module-definition-time
// code (analogous to parseEnableDryRun's usage in app.module.ts) can
// consult the same parse rule without constructing a full ConfigService.
describe('parseBooleanFlag', () => {
  it('returns fallback when explicit is undefined', () => {
    expect(parseBooleanFlag(undefined, true)).toBe(true);
    expect(parseBooleanFlag(undefined, false)).toBe(false);
  });

  it('returns fallback when explicit is empty', () => {
    expect(parseBooleanFlag('', true)).toBe(true);
    expect(parseBooleanFlag('', false)).toBe(false);
  });

  it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES'])(
    'parses "%s" as true ignoring fallback',
    (v) => expect(parseBooleanFlag(v, false)).toBe(true),
  );

  it.each(['false', '0', 'no', 'maybe', ' '])(
    'parses "%s" as false ignoring fallback',
    (v) => expect(parseBooleanFlag(v, true)).toBe(false),
  );
});

describe('parseDogfoodRepos', () => {
  it('returns empty set for undefined', () => {
    expect(parseDogfoodRepos(undefined).size).toBe(0);
  });

  it('returns empty set for empty / whitespace string', () => {
    expect(parseDogfoodRepos('').size).toBe(0);
    expect(parseDogfoodRepos('   ').size).toBe(0);
  });

  it('parses a single token', () => {
    const repos = parseDogfoodRepos('foo/bar');
    expect(repos.has('foo/bar')).toBe(true);
    expect(repos.size).toBe(1);
  });

  it('deduplicates repeated tokens', () => {
    const repos = parseDogfoodRepos('foo/bar,foo/bar');
    expect(repos.size).toBe(1);
  });

  it('drops empty tokens between commas', () => {
    const repos = parseDogfoodRepos(',foo/bar,,baz/qux,');
    expect(repos.size).toBe(2);
  });

  it('rejects tokens with embedded whitespace', () => {
    expect(() => parseDogfoodRepos('foo / bar')).toThrow(/DOGFOOD_REPOS/);
  });

  it('rejects tokens that are not owner/repo shaped', () => {
    expect(() => parseDogfoodRepos('orphan')).toThrow(/DOGFOOD_REPOS/);
    expect(() => parseDogfoodRepos('too/many/slashes')).toThrow(/DOGFOOD_REPOS/);
  });
});
