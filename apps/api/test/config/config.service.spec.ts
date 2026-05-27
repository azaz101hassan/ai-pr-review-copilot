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
    DATABASE_PATH: process.env.DATABASE_PATH,
    PORT: process.env.PORT,
  };

  const VALID_WEBHOOK_SECRET = 'webhook-test-secret-0123456789abcdef';
  const VALID_VOYAGE_KEY = 'voyage-test-key-0123456789abcdef';

  function setEnv(overrides: Partial<Record<keyof typeof snapshot, string | undefined>>) {
    for (const key of Object.keys(snapshot) as (keyof typeof snapshot)[]) {
      const v = overrides[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('happy paths', () => {
    it('exposes all four Day-2 vars when set explicitly', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
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

    it('falls back to documented defaults when only VOYAGE_API_KEY is set', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
      });

      const cfg = new ConfigService();

      expect(cfg.chromaUrl).toBe('http://localhost:8000');
      expect(cfg.chromaCollection).toBe('code-style-rules');
      expect(cfg.embeddingModel).toBe('voyage-code-3');
    });

    it('accepts an https Chroma URL (remote-deployed scenario)', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
        CHROMA_URL: 'https://chroma.example.com',
      });

      const cfg = new ConfigService();
      expect(cfg.chromaUrl).toBe('https://chroma.example.com');
    });
  });

  describe('error paths', () => {
    it('throws when VOYAGE_API_KEY is missing', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: undefined,
      });

      expect(() => new ConfigService()).toThrow(/VOYAGE_API_KEY/);
    });

    it('throws when VOYAGE_API_KEY is the literal string "undefined"', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: 'undefined',
      });

      expect(() => new ConfigService()).toThrow(/VOYAGE_API_KEY/);
    });

    it('throws when VOYAGE_API_KEY is shorter than 16 chars', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: 'short',
      });

      expect(() => new ConfigService()).toThrow(/VOYAGE_API_KEY/);
    });

    it('throws when CHROMA_URL is not a parseable URL', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
        CHROMA_URL: 'definitely not a url',
      });

      expect(() => new ConfigService()).toThrow(/CHROMA_URL/);
    });

    it('throws when CHROMA_URL uses an unsupported protocol', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
        CHROMA_URL: 'ftp://localhost:8000',
      });

      expect(() => new ConfigService()).toThrow(/CHROMA_URL/);
    });

    it('throws when CHROMA_COLLECTION contains whitespace', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
        CHROMA_COLLECTION: 'has space',
      });

      expect(() => new ConfigService()).toThrow(/CHROMA_COLLECTION/);
    });

    it('throws when EMBEDDING_MODEL is empty', () => {
      setEnv({
        GITHUB_WEBHOOK_SECRET: VALID_WEBHOOK_SECRET,
        VOYAGE_API_KEY: VALID_VOYAGE_KEY,
        EMBEDDING_MODEL: '',
      });

      // Empty defaults to 'voyage-code-3' via `?? 'voyage-code-3'`, but a
      // literal empty string in env evaluates as falsy → default kicks
      // in. To exercise the validator, force a whitespace-only override.
      // The `??` operator only nulls/undefined, so '' DOES pass through.
      // Actually: `process.env.EMBEDDING_MODEL ?? 'voyage-code-3'` —
      // since '' is not nullish, '' passes through and the validator
      // catches it.
      expect(() => new ConfigService()).toThrow(/EMBEDDING_MODEL/);
    });
  });
});
