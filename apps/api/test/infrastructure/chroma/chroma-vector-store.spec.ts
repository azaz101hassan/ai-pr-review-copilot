import {
  ChromaVectorStore,
  ChromaRequestError,
} from '../../../src/infrastructure/chroma/chroma-vector-store';
import { ConfigService } from '@/config';

// Spec for the Chroma adapter. The `chromadb` client is mocked at the
// boundary — these tests own URL parsing, lazy ensureCollection,
// argument shape (cosine space, parallel arrays in upsert), the
// distance→score conversion, and error wrapping. The integration spec
// in modules/embeddings exercises real orchestration via an in-memory
// stub of this interface.

interface MockCollection {
  upsert: jest.Mock;
  query: jest.Mock;
  get: jest.Mock;
  delete: jest.Mock;
}

interface MockClient {
  getOrCreateCollection: jest.Mock;
}

function makeMockCollection(): MockCollection {
  return {
    upsert: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      ids: [[]],
      distances: [[]],
      documents: [[]],
      metadatas: [[]],
    }),
    get: jest.fn().mockResolvedValue({ ids: [] }),
    delete: jest.fn().mockResolvedValue({ deleted_count: 0 }),
  };
}

function makeMockClient(collection: MockCollection): MockClient {
  return {
    getOrCreateCollection: jest.fn().mockResolvedValue(collection),
  };
}

function makeConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    chromaUrl: 'http://localhost:8000',
    chromaCollection: 'code-style-rules',
    ...overrides,
  } as ConfigService;
}

// Test seam: subclass that lets us substitute the chromadb client.
class TestableChromaVectorStore extends ChromaVectorStore {
  public clientArgs: unknown = null;
  constructor(
    config: ConfigService,
    private readonly stubClient: MockClient,
  ) {
    super(config);
  }
  protected override createClient(args: {
    host: string;
    port: number;
    ssl: boolean;
  }): unknown {
    this.clientArgs = args;
    return this.stubClient as unknown;
  }
}

describe('ChromaVectorStore', () => {
  describe('lazy ensureCollection', () => {
    it('does not call getOrCreateCollection on construction (DI bootstrap stays network-free)', () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      new TestableChromaVectorStore(makeConfig(), client);

      expect(client.getOrCreateCollection).not.toHaveBeenCalled();
    });

    it('calls getOrCreateCollection on first ensureCollection with cosine space', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.ensureCollection();

      expect(client.getOrCreateCollection).toHaveBeenCalledTimes(1);
      const args = client.getOrCreateCollection.mock.calls[0][0];
      expect(args.name).toBe('code-style-rules');
      expect(args.configuration?.hnsw?.space).toBe('cosine');
    });

    it('opts out of the server-side default embedder (we pre-compute via Voyage)', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.ensureCollection();

      const args = client.getOrCreateCollection.mock.calls[0][0];
      // Passing `null` — not undefined — is the explicit opt-out
      // signal in the chromadb v3 client. Omitting the field would
      // trigger the noisy DefaultEmbeddingFunction lazy-load.
      expect(args.embeddingFunction).toBeNull();
    });

    it('is idempotent — calling twice does NOT re-call getOrCreateCollection', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.ensureCollection();
      await store.ensureCollection();

      expect(client.getOrCreateCollection).toHaveBeenCalledTimes(1);
    });

    it('parses CHROMA_URL into {host, port, ssl}', () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);

      const store = new TestableChromaVectorStore(
        makeConfig({ chromaUrl: 'http://localhost:8000' } as Partial<ConfigService>),
        client,
      );
      void store.ensureCollection();
      expect(store.clientArgs).toEqual({ host: 'localhost', port: 8000, ssl: false });
    });

    it('parses an https URL without an explicit port as ssl=true, port=443', () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);

      const store = new TestableChromaVectorStore(
        makeConfig({ chromaUrl: 'https://chroma.example.com' } as Partial<ConfigService>),
        client,
      );
      void store.ensureCollection();
      expect(store.clientArgs).toEqual({
        host: 'chroma.example.com',
        port: 443,
        ssl: true,
      });
    });

    it('parses an http URL with trailing slash and custom port', () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);

      const store = new TestableChromaVectorStore(
        makeConfig({ chromaUrl: 'http://host:1234/' } as Partial<ConfigService>),
        client,
      );
      void store.ensureCollection();
      expect(store.clientArgs).toEqual({ host: 'host', port: 1234, ssl: false });
    });
  });

  describe('upsert', () => {
    it('passes parallel arrays in matching order', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.upsert([
        {
          id: 'a',
          embedding: [0.1],
          document: 'doc-a',
          metadata: { rule_id: 'a', severity: 'error' },
        },
        {
          id: 'b',
          embedding: [0.2],
          document: 'doc-b',
          metadata: { rule_id: 'b', severity: 'warning' },
        },
      ]);

      expect(collection.upsert).toHaveBeenCalledTimes(1);
      const args = collection.upsert.mock.calls[0][0];
      expect(args.ids).toEqual(['a', 'b']);
      expect(args.embeddings).toEqual([[0.1], [0.2]]);
      expect(args.documents).toEqual(['doc-a', 'doc-b']);
      expect(args.metadatas).toEqual([
        { rule_id: 'a', severity: 'error' },
        { rule_id: 'b', severity: 'warning' },
      ]);
    });

    it('triggers ensureCollection on first call (lazy init)', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.upsert([
        { id: 'x', embedding: [0.1], document: 'doc', metadata: {} },
      ]);

      expect(client.getOrCreateCollection).toHaveBeenCalledTimes(1);
    });

    it('short-circuits on empty input — no client call', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.upsert([]);

      expect(collection.upsert).not.toHaveBeenCalled();
    });
  });

  describe('query', () => {
    it('passes queryEmbeddings and nResults and unwraps nested-by-query results', async () => {
      const collection = makeMockCollection();
      collection.query.mockResolvedValueOnce({
        ids: [['a', 'b']],
        distances: [[0.1, 0.4]],
        documents: [['doc-a', 'doc-b']],
        metadatas: [[{ rule_id: 'a' }, { rule_id: 'b' }]],
      });
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      const hits = await store.query({ embedding: [0.5], k: 10 });

      expect(collection.query).toHaveBeenCalledWith({
        queryEmbeddings: [[0.5]],
        nResults: 10,
        where: undefined,
        include: ['documents', 'metadatas', 'distances'],
      });
      expect(hits).toEqual([
        { id: 'a', score: 0.9, document: 'doc-a', metadata: { rule_id: 'a' } },
        { id: 'b', score: 0.6, document: 'doc-b', metadata: { rule_id: 'b' } },
      ]);
    });

    it('passes a where filter through verbatim', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.query({
        embedding: [0.1],
        k: 5,
        where: { source: { $eq: 'airbnb-eslint' } },
      });

      expect(collection.query).toHaveBeenCalledWith(
        expect.objectContaining({ where: { source: { $eq: 'airbnb-eslint' } } }),
      );
    });

    it('returns [] when Chroma returns zero hits', async () => {
      const collection = makeMockCollection();
      collection.query.mockResolvedValueOnce({
        ids: [[]],
        distances: [[]],
        documents: [[]],
        metadatas: [[]],
      });
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      const hits = await store.query({ embedding: [0.5], k: 10 });
      expect(hits).toEqual([]);
    });
  });

  describe('deleteAll', () => {
    it('enumerates ids via get then deletes by that list (Chroma delete is a no-op without filters)', async () => {
      const collection = makeMockCollection();
      collection.get.mockResolvedValueOnce({ ids: ['a', 'b', 'c'] });
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.deleteAll();

      expect(collection.get).toHaveBeenCalledWith({});
      expect(collection.delete).toHaveBeenCalledWith({ ids: ['a', 'b', 'c'] });
    });

    it('skips the delete round-trip when the collection is already empty', async () => {
      const collection = makeMockCollection();
      collection.get.mockResolvedValueOnce({ ids: [] });
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await store.deleteAll();

      expect(collection.delete).not.toHaveBeenCalled();
    });
  });

  describe('error wrapping', () => {
    it('wraps a getOrCreateCollection failure as ChromaRequestError with original cause', async () => {
      const collection = makeMockCollection();
      const client = makeMockClient(collection);
      const underlying = new Error('connection refused');
      client.getOrCreateCollection.mockRejectedValueOnce(underlying);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      const promise = store.ensureCollection();

      await expect(promise).rejects.toMatchObject({ name: 'ChromaRequestError' });
      try {
        await store.ensureCollection();
      } catch (err) {
        const e = err as ChromaRequestError;
        expect(e.cause).toBe(underlying);
      }
    });

    it('wraps an upsert failure as ChromaRequestError', async () => {
      const collection = makeMockCollection();
      collection.upsert.mockRejectedValueOnce(new Error('boom'));
      const client = makeMockClient(collection);
      const store = new TestableChromaVectorStore(makeConfig(), client);

      await expect(
        store.upsert([
          { id: 'a', embedding: [0.1], document: 'd', metadata: {} },
        ]),
      ).rejects.toMatchObject({ name: 'ChromaRequestError' });
    });
  });
});
