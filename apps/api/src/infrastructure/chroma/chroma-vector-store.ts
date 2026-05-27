import { Injectable, Logger } from '@nestjs/common';
import { ChromaClient } from 'chromadb';
import { ConfigService } from '@/config';
import {
  IVectorStore,
  VectorStoreHit,
  VectorStoreItem,
  VectorStoreQueryOptions,
} from '@/modules/embeddings/types/vector-store';

// Loose alias for the chromadb client surface this adapter uses.
// Tests provide a stub via the protected createClient() seam below;
// keeping the type loose lets stubs implement only the subset of
// methods the adapter actually calls without satisfying every
// signature on the real ChromaClient class.
type ChromaClientLike = {
  getOrCreateCollection: (args: {
    name: string;
    configuration?: { hnsw?: { space?: 'l2' | 'cosine' | 'ip' } };
    // `null` opts out of Chroma's default embedding function — we
    // pre-compute embeddings via Voyage and pass vectors directly to
    // `upsert`, so the collection has no need for a server-side
    // embedder. Omitting this is what triggers the noisy
    // "Cannot instantiate a collection with the DefaultEmbeddingFunction"
    // warnings from the chromadb client at first-call time.
    embeddingFunction?: unknown;
  }) => Promise<ChromaCollectionLike>;
};

type ChromaCollectionLike = {
  upsert: (args: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: Array<Record<string, string | number | boolean>>;
  }) => Promise<void>;
  query: (args: {
    queryEmbeddings: number[][];
    nResults: number;
    where?: Record<string, unknown>;
    include: string[];
  }) => Promise<{
    ids: string[][];
    distances: number[][];
    documents: (string | null)[][];
    metadatas: Record<string, unknown>[][];
  }>;
  get: (args: Record<string, unknown>) => Promise<{ ids: string[] }>;
  delete: (args: Record<string, unknown>) => Promise<unknown>;
};

export class ChromaRequestError extends Error {
  readonly name = 'ChromaRequestError';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

@Injectable()
export class ChromaVectorStore implements IVectorStore {
  private readonly logger = new Logger(ChromaVectorStore.name);

  // `client` and `collection` are both lazy. The constructor only reads
  // config and computes connection args — it never opens a connection.
  // This keeps DI bootstrap (and every spec that loads AppModule)
  // network-free; the first upsert/query call is what actually talks to
  // Chroma. Decided in the Day-2 plan's P0 doc-review finding (see
  // docs/plans/03-day2-rag-foundation.md).
  private client: ChromaClientLike | undefined;
  private collection: ChromaCollectionLike | undefined;
  private ensurePromise: Promise<ChromaCollectionLike> | undefined;

  constructor(private readonly config: ConfigService) {}

  async ensureCollection(): Promise<void> {
    await this.resolveCollection();
  }

  async upsert(items: VectorStoreItem[]): Promise<void> {
    if (items.length === 0) return;
    const collection = await this.resolveCollection();
    try {
      await collection.upsert({
        ids: items.map((i) => i.id),
        embeddings: items.map((i) => i.embedding),
        documents: items.map((i) => i.document),
        metadatas: items.map((i) => i.metadata),
      });
    } catch (err) {
      throw new ChromaRequestError(
        `Chroma upsert failed (${items.length} items): ${describeError(err)}`,
        err,
      );
    }
  }

  async query(options: VectorStoreQueryOptions): Promise<VectorStoreHit[]> {
    const collection = await this.resolveCollection();
    let result: Awaited<ReturnType<ChromaCollectionLike['query']>>;
    try {
      result = await collection.query({
        queryEmbeddings: [options.embedding],
        nResults: options.k,
        where: options.where,
        include: ['documents', 'metadatas', 'distances'],
      });
    } catch (err) {
      throw new ChromaRequestError(`Chroma query failed: ${describeError(err)}`, err);
    }

    // Chroma nests results by query (one outer array per
    // queryEmbedding). We only ever pass one, so unwrap [0].
    const ids = result.ids[0] ?? [];
    const distances = result.distances[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];

    return ids.map((id, i) => ({
      id,
      // For cosine space, Chroma returns 1 - similarity. Flip it so a
      // higher score means a closer match — easier for downstream
      // ranking and printable tables.
      score: 1 - (distances[i] ?? 1),
      document: documents[i] ?? null,
      metadata: metadatas[i] ?? {},
    }));
  }

  async deleteAll(): Promise<void> {
    const collection = await this.resolveCollection();
    try {
      // Chroma's server-side `delete` is a safety no-op when called
      // with no `ids` / `where` / `whereDocument` filter — that's not
      // the "drop everything" behavior the name suggests. So we do
      // it in two steps: enumerate ids via `get({})`, then `delete`
      // by that id list. Skips the second round-trip when the
      // collection is already empty.
      const all = await collection.get({});
      if (all.ids.length === 0) return;
      await collection.delete({ ids: all.ids });
    } catch (err) {
      throw new ChromaRequestError(`Chroma deleteAll failed: ${describeError(err)}`, err);
    }
  }

  // Test seam — overridden in spec to substitute a mock client without
  // jest.mock() on the chromadb module. Production path builds a real
  // ChromaClient from {host, port, ssl}.
  protected createClient(args: {
    host: string;
    port: number;
    ssl: boolean;
  }): unknown {
    return new ChromaClient(args);
  }

  private parseChromaArgs(): { host: string; port: number; ssl: boolean } {
    const url = new URL(this.config.chromaUrl);
    const ssl = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : ssl ? 443 : 80;
    return { host: url.hostname, port, ssl };
  }

  private async resolveCollection(): Promise<ChromaCollectionLike> {
    if (this.collection) return this.collection;
    // De-dupe concurrent first-callers. Without this, two parallel
    // upserts during a seed batch could each try to getOrCreate the
    // collection, racing on the Chroma side.
    if (!this.ensurePromise) {
      this.ensurePromise = this.openCollection();
    }
    this.collection = await this.ensurePromise;
    return this.collection;
  }

  private async openCollection(): Promise<ChromaCollectionLike> {
    if (!this.client) {
      this.client = this.createClient(this.parseChromaArgs()) as ChromaClientLike;
    }
    try {
      const collection = await this.client.getOrCreateCollection({
        name: this.config.chromaCollection,
        configuration: { hnsw: { space: 'cosine' } },
        // Opt out of @chroma-core/default-embed. We pre-compute vectors
        // via Voyage and pass them directly to upsert; the chromadb
        // client otherwise tries to lazy-load the default embedder
        // (which we don't install) and logs four error lines per call
        // before falling back to vector-only mode.
        embeddingFunction: null,
      });
      this.logger.log(
        `Chroma collection "${this.config.chromaCollection}" ready at ${this.config.chromaUrl}`,
      );
      return collection;
    } catch (err) {
      // Reset so the next caller can try again with a fresh promise —
      // otherwise a transient failure during seed-up would poison every
      // later call until the process restarts.
      this.ensurePromise = undefined;
      throw new ChromaRequestError(
        `Chroma getOrCreateCollection failed for "${this.config.chromaCollection}" at ${this.config.chromaUrl}: ${describeError(err)}`,
        err,
      );
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
