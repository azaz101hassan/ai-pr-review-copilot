import {
  VoyageEmbeddingProvider,
  VoyageRequestError,
} from '../../../src/infrastructure/voyage/voyage-embedding.provider';
import { ConfigService } from '@/config';

// Spec for the Voyage adapter. fetch is mocked at the transport
// boundary — the unit under test owns URL, headers, body shape,
// response parsing, and error wrapping. A real Voyage call is exercised
// manually (see the .skip block at the bottom).

interface MockResponseInit {
  status?: number;
  body?: unknown;
  bodyText?: string;
  reject?: Error;
  headers?: Record<string, string>;
}

function mockFetch(...responses: MockResponseInit[]): jest.Mock {
  const fn = jest.fn();
  for (const r of responses) {
    if (r.reject) {
      fn.mockRejectedValueOnce(r.reject);
      continue;
    }
    const status = r.status ?? 200;
    const text = r.bodyText ?? JSON.stringify(r.body ?? {});
    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      lowerHeaders[k.toLowerCase()] = v;
    }
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
      headers: { get: (name: string) => lowerHeaders[name.toLowerCase()] ?? null },
    } as unknown as Response);
  }
  return fn;
}

function makeConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    voyageApiKey: 'voyage-test-key-0123456789abcdef',
    embeddingModel: 'voyage-code-3',
    ...overrides,
  } as ConfigService;
}

function vec(fill: number, dim = 1024): number[] {
  return new Array(dim).fill(fill);
}

function voyageOkBody(vectors: number[][], totalTokens = 42) {
  return {
    data: vectors.map((embedding, index) => ({ embedding, index })),
    usage: { total_tokens: totalTokens },
  };
}

describe('VoyageEmbeddingProvider', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  function install(...responses: MockResponseInit[]) {
    fetchMock = mockFetch(...responses);
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  }

  afterEach(() => {
    (global as { fetch: typeof fetch }).fetch = originalFetch;
  });

  describe('embedDocuments', () => {
    it('posts once with input_type "document" and returns vectors in input order', async () => {
      install({ body: voyageOkBody([vec(0.1), vec(0.2), vec(0.3)], 30) });

      const provider = new VoyageEmbeddingProvider(makeConfig());
      const result = await provider.embedDocuments(['a', 'b', 'c']);

      expect(result.tokensUsed).toBe(30);
      expect(result.vectors).toHaveLength(3);
      expect(result.vectors[0][0]).toBeCloseTo(0.1);
      expect(result.vectors[2][0]).toBeCloseTo(0.3);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.voyageai.com/v1/embeddings');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer voyage-test-key-0123456789abcdef');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('voyage-code-3');
      expect(body.input_type).toBe('document');
      expect(body.input).toEqual(['a', 'b', 'c']);
    });

    it('short-circuits on empty input — no fetch call', async () => {
      install();
      const provider = new VoyageEmbeddingProvider(makeConfig());

      const result = await provider.embedDocuments([]);

      expect(result).toEqual({ vectors: [], tokensUsed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('batches inputs over 128 strings across multiple requests', async () => {
      install(
        { body: voyageOkBody(Array.from({ length: 128 }, (_, i) => vec(i / 1000)), 100) },
        { body: voyageOkBody(Array.from({ length: 72 }, (_, i) => vec(i / 1000)), 50) },
      );

      const inputs = Array.from({ length: 200 }, (_, i) => `chunk-${i}`);
      const provider = new VoyageEmbeddingProvider(makeConfig());
      const result = await provider.embedDocuments(inputs);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).input).toHaveLength(128);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).input).toHaveLength(72);
      expect(result.vectors).toHaveLength(200);
      expect(result.tokensUsed).toBe(150);
    });

    it('reassembles vectors by index even if Voyage returns them out of order', async () => {
      install({
        body: {
          data: [
            { embedding: vec(0.3), index: 2 },
            { embedding: vec(0.1), index: 0 },
            { embedding: vec(0.2), index: 1 },
          ],
          usage: { total_tokens: 10 },
        },
      });

      const provider = new VoyageEmbeddingProvider(makeConfig());
      const result = await provider.embedDocuments(['a', 'b', 'c']);

      expect(result.vectors[0][0]).toBeCloseTo(0.1);
      expect(result.vectors[1][0]).toBeCloseTo(0.2);
      expect(result.vectors[2][0]).toBeCloseTo(0.3);
    });
  });

  describe('embedQuery', () => {
    it('posts with input_type "query" and returns a single vector', async () => {
      install({ body: voyageOkBody([vec(0.5)], 5) });

      const provider = new VoyageEmbeddingProvider(makeConfig());
      const result = await provider.embedQuery('diff text');

      expect(result.vector).toHaveLength(1024);
      expect(result.vector[0]).toBeCloseTo(0.5);
      expect(result.tokensUsed).toBe(5);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.input_type).toBe('query');
      expect(body.input).toEqual(['diff text']);
    });
  });

  describe('error paths — VoyageRequestError', () => {
    it('throws on 401 with the status, NOT the raw response body', async () => {
      install({
        status: 401,
        bodyText: JSON.stringify({
          detail: 'token leaked-key-do-not-log abc123',
          error_code: 'unauthorized',
        }),
      });

      const provider = new VoyageEmbeddingProvider(makeConfig());

      await expect(provider.embedDocuments(['a'])).rejects.toMatchObject({
        name: 'VoyageRequestError',
        status: 401,
        errorCode: 'unauthorized',
      });

      // The promise above is the canonical signal. Re-await for the
      // message-content assertion so we can inspect what leaked.
      install({
        status: 401,
        bodyText: JSON.stringify({
          detail: 'token leaked-key-do-not-log abc123',
          error_code: 'unauthorized',
        }),
      });
      const provider2 = new VoyageEmbeddingProvider(makeConfig());
      let caught: VoyageRequestError | undefined;
      try {
        await provider2.embedDocuments(['a']);
      } catch (err) {
        caught = err as VoyageRequestError;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).not.toContain('leaked-key-do-not-log');
      expect(caught!.message).toContain('401');
    });

    it('throws on 429 after exhausting in-provider retries, surfacing retryAfterMs', async () => {
      // 4 total attempts (1 initial + 3 retries). Default backoff
      // (35s) applies because no Retry-After header is set.
      install(
        { status: 429, body: { error_code: 'rate_limited' } },
        { status: 429, body: { error_code: 'rate_limited' } },
        { status: 429, body: { error_code: 'rate_limited' } },
        { status: 429, body: { error_code: 'rate_limited' } },
      );

      jest.useFakeTimers();
      try {
        const provider = new VoyageEmbeddingProvider(makeConfig());
        const promise = provider.embedDocuments(['a']);
        // Suppress unhandled-rejection warnings while we advance timers.
        promise.catch(() => undefined);

        // Three 35s naps between the 4 attempts.
        await jest.advanceTimersByTimeAsync(35_000);
        await jest.advanceTimersByTimeAsync(35_000);
        await jest.advanceTimersByTimeAsync(35_000);

        await expect(promise).rejects.toMatchObject({
          name: 'VoyageRequestError',
          status: 429,
          errorCode: 'rate_limited',
          retryAfterMs: 35_000,
        });
        // 4 total attempts: 1 initial + 3 retries.
        expect(fetchMock).toHaveBeenCalledTimes(4);
      } finally {
        jest.useRealTimers();
      }
    });

    it('retries on 429 and succeeds when a later attempt returns 200', async () => {
      install(
        { status: 429, body: { error_code: 'rate_limited' } },
        { body: voyageOkBody([vec(0.5)]) },
      );

      jest.useFakeTimers();
      try {
        const provider = new VoyageEmbeddingProvider(makeConfig());
        const promise = provider.embedDocuments(['a']);
        await jest.advanceTimersByTimeAsync(35_000);
        const result = await promise;
        expect(result.vectors).toEqual([vec(0.5)]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('honours the Retry-After header on 429 (numeric seconds)', async () => {
      install(
        {
          status: 429,
          body: { error_code: 'rate_limited' },
          headers: { 'Retry-After': '5' },
        },
        { body: voyageOkBody([vec(0.7)]) },
      );

      jest.useFakeTimers();
      try {
        const provider = new VoyageEmbeddingProvider(makeConfig());
        const promise = provider.embedDocuments(['a']);

        // Not yet — should still be waiting after only 4s of the 5s window.
        await jest.advanceTimersByTimeAsync(4_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The remaining second triggers the retry; the success returns.
        await jest.advanceTimersByTimeAsync(1_000);
        const result = await promise;
        expect(result.vectors).toEqual([vec(0.7)]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('throws when response data length does not match input length', async () => {
      install({
        body: {
          data: [{ embedding: vec(0.1), index: 0 }],
          usage: { total_tokens: 5 },
        },
      });

      const provider = new VoyageEmbeddingProvider(makeConfig());

      await expect(provider.embedDocuments(['a', 'b', 'c'])).rejects.toThrow(
        /unexpected response shape/i,
      );
    });

    it('wraps fetch network errors as VoyageRequestError', async () => {
      install({ reject: new Error('ECONNRESET') });

      const provider = new VoyageEmbeddingProvider(makeConfig());

      const promise = provider.embedDocuments(['a']);
      await expect(promise).rejects.toMatchObject({ name: 'VoyageRequestError' });

      install({ reject: new Error('ECONNRESET') });
      const provider2 = new VoyageEmbeddingProvider(makeConfig());
      let caught: VoyageRequestError | undefined;
      try {
        await provider2.embedDocuments(['a']);
      } catch (err) {
        caught = err as VoyageRequestError;
      }
      expect(caught?.cause).toBeInstanceOf(Error);
      expect((caught?.cause as Error).message).toBe('ECONNRESET');
    });
  });

  describe('metadata', () => {
    it('exposes modelName and dimension for downstream provenance writes', () => {
      const provider = new VoyageEmbeddingProvider(makeConfig());
      expect(provider.modelName).toBe('voyage-code-3');
      expect(provider.dimension).toBe(1024);
    });
  });
});
