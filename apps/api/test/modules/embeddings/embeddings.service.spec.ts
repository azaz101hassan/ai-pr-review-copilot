import { EmbeddingsService } from '@/modules/embeddings/embeddings.service';
import {
  IEmbeddingProvider,
  EmbedDocumentsResult,
  EmbedQueryResult,
} from '@/modules/embeddings/types/embedding-provider';
import {
  IVectorStore,
  VectorStoreHit,
  VectorStoreItem,
  VectorStoreQueryOptions,
} from '@/modules/embeddings/types/vector-store';
import { IKnowledgeSourceRepository } from '@/modules/embeddings/types/knowledge-source.repository';
import {
  IKnowledgeChunkRepository,
} from '@/modules/embeddings/types/knowledge-chunk.repository';
import {
  CorpusLoader,
  LoadedCorpus,
  NormalizedChunk,
} from '@/modules/embeddings/helpers/corpus-loader';
import { KnowledgeSourceRecord } from '@/modules/embeddings/types/knowledge-source.types';
import { KnowledgeChunkRecord, KnowledgeChunkInsert } from '@/modules/embeddings/types/knowledge-chunk.types';

function vec(fill: number, dim = 1024): number[] {
  return new Array(dim).fill(fill);
}

function chunk(overrides: Partial<NormalizedChunk> = {}): NormalizedChunk {
  return {
    id: 'airbnb-eslint:eqeqeq',
    source_id: 'airbnb-eslint',
    rule_id: 'eqeqeq',
    title: 'Require ===',
    body: 'body text',
    severity: 'error',
    language: 'javascript',
    category: 'best-practices',
    ...overrides,
  };
}

function makeProvider(): jest.Mocked<IEmbeddingProvider> {
  return {
    modelName: 'voyage-code-3',
    dimension: 1024,
    embedDocuments: jest.fn(),
    embedQuery: jest.fn(),
  };
}

function makeStore(): jest.Mocked<IVectorStore> {
  return {
    ensureCollection: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    deleteAll: jest.fn().mockResolvedValue(undefined),
  };
}

function makeChunkRepo(): IKnowledgeChunkRepository & {
  upsertMany: jest.Mock;
  findById: jest.Mock;
  findByIds: jest.Mock;
  deleteBySourceId: jest.Mock;
  searchByKeyword: jest.Mock;
} {
  return {
    upsertMany: jest.fn(),
    findById: jest.fn(),
    findByIds: jest.fn().mockReturnValue([]),
    deleteBySourceId: jest.fn().mockReturnValue(0),
    searchByKeyword: jest.fn().mockReturnValue([]),
  };
}

function makeSourceRepo(): IKnowledgeSourceRepository & {
  upsert: jest.Mock;
  findById: jest.Mock;
  listAll: jest.Mock;
} {
  return {
    upsert: jest.fn(),
    findById: jest.fn(),
    listAll: jest.fn().mockReturnValue([]),
  };
}

function makeLoader(corpus: LoadedCorpus): CorpusLoader {
  return { load: jest.fn().mockReturnValue(corpus) } as unknown as CorpusLoader;
}

describe('EmbeddingsService.indexCorpus', () => {
  it('upserts sources, embeds in batches, persists SQLite first then Chroma', async () => {
    const corpus: LoadedCorpus = {
      sources: [
        { id: 'airbnb-eslint', name: 'Airbnb', description: null },
        { id: 'team-standards', name: 'Team', description: 'Internal' },
      ],
      chunks: [
        chunk({ id: 'a:1', rule_id: '1' }),
        chunk({ id: 'a:2', rule_id: '2' }),
      ],
    };
    const provider = makeProvider();
    provider.embedDocuments.mockResolvedValue({
      vectors: [vec(0.1), vec(0.2)],
      tokensUsed: 42,
    } satisfies EmbedDocumentsResult);
    const store = makeStore();
    const sources = makeSourceRepo();
    const chunks = makeChunkRepo();

    const callOrder: string[] = [];
    chunks.upsertMany.mockImplementation((records: KnowledgeChunkInsert[]) => {
      callOrder.push(`sqlite(${records.length})`);
    });
    store.upsert.mockImplementation(async (items: VectorStoreItem[]) => {
      callOrder.push(`chroma(${items.length})`);
    });

    const svc = new EmbeddingsService(
      makeLoader(corpus),
      provider,
      store,
      sources,
      chunks,
    );

    const result = await svc.indexCorpus();

    expect(result).toEqual({
      insertedSources: 2,
      upsertedChunks: 2,
      totalTokens: 42,
    });
    expect(sources.upsert).toHaveBeenCalledTimes(2);
    expect(provider.embedDocuments).toHaveBeenCalledWith(['body text', 'body text']);
    // SQLite-before-Chroma ordering invariant.
    expect(callOrder).toEqual(['sqlite(2)', 'chroma(2)']);
    // Chunk records carry model provenance from the provider.
    const upsertedRecords = chunks.upsertMany.mock.calls[0][0] as KnowledgeChunkInsert[];
    expect(upsertedRecords[0].embedding_model).toBe('voyage-code-3');
    expect(upsertedRecords[0].embedding_dim).toBe(1024);
  });

  it('batches at 128 — 200 chunks → two embed calls (128 + 72)', async () => {
    const corpus: LoadedCorpus = {
      sources: [{ id: 'airbnb-eslint', name: 'Airbnb', description: null }],
      chunks: Array.from({ length: 200 }, (_, i) =>
        chunk({ id: `a:${i}`, rule_id: `r${i}` }),
      ),
    };
    const provider = makeProvider();
    provider.embedDocuments
      .mockResolvedValueOnce({ vectors: Array.from({ length: 128 }, () => vec(0.1)), tokensUsed: 100 })
      .mockResolvedValueOnce({ vectors: Array.from({ length: 72 }, () => vec(0.1)), tokensUsed: 50 });

    const svc = new EmbeddingsService(
      makeLoader(corpus),
      provider,
      makeStore(),
      makeSourceRepo(),
      makeChunkRepo(),
    );

    const result = await svc.indexCorpus();

    expect(provider.embedDocuments).toHaveBeenCalledTimes(2);
    expect((provider.embedDocuments.mock.calls[0][0] as string[]).length).toBe(128);
    expect((provider.embedDocuments.mock.calls[1][0] as string[]).length).toBe(72);
    expect(result.upsertedChunks).toBe(200);
    expect(result.totalTokens).toBe(150);
  });

  it('handles an empty corpus without calling embed/persist', async () => {
    const corpus: LoadedCorpus = { sources: [], chunks: [] };
    const provider = makeProvider();
    const store = makeStore();
    const chunks = makeChunkRepo();

    const svc = new EmbeddingsService(
      makeLoader(corpus),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    const result = await svc.indexCorpus();

    expect(provider.embedDocuments).not.toHaveBeenCalled();
    expect(chunks.upsertMany).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ insertedSources: 0, upsertedChunks: 0, totalTokens: 0 });
  });

  it('does not write to Chroma if SQLite upsert throws (ordering invariant)', async () => {
    const corpus: LoadedCorpus = {
      sources: [{ id: 'airbnb-eslint', name: 'Airbnb', description: null }],
      chunks: [chunk()],
    };
    const provider = makeProvider();
    provider.embedDocuments.mockResolvedValue({ vectors: [vec(0.1)], tokensUsed: 10 });
    const store = makeStore();
    const chunks = makeChunkRepo();
    chunks.upsertMany.mockImplementation(() => {
      throw new Error('SQLite full');
    });

    const svc = new EmbeddingsService(
      makeLoader(corpus),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    await expect(svc.indexCorpus()).rejects.toThrow('SQLite full');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('propagates Chroma failure after SQLite succeeded (SQLite rows remain durable)', async () => {
    const corpus: LoadedCorpus = {
      sources: [{ id: 'airbnb-eslint', name: 'Airbnb', description: null }],
      chunks: [chunk()],
    };
    const provider = makeProvider();
    provider.embedDocuments.mockResolvedValue({ vectors: [vec(0.1)], tokensUsed: 10 });
    const store = makeStore();
    store.upsert.mockRejectedValueOnce(new Error('Chroma down'));
    const chunks = makeChunkRepo();

    const svc = new EmbeddingsService(
      makeLoader(corpus),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    await expect(svc.indexCorpus()).rejects.toThrow('Chroma down');
    // SQLite WAS called — that's the "SQLite remains the source of truth"
    // invariant; the next seed run replays and catches Chroma up.
    expect(chunks.upsertMany).toHaveBeenCalled();
  });
});

describe('EmbeddingsService.search', () => {
  const sampleHit: VectorStoreHit = {
    id: 'airbnb-eslint:eqeqeq',
    score: 0.9,
    document: 'body text',
    metadata: { rule_id: 'eqeqeq', source: 'airbnb-eslint' },
  };

  function sampleChunkRow(id: string, rule_id = 'eqeqeq'): KnowledgeChunkRecord {
    return {
      id,
      source_id: 'airbnb-eslint',
      rule_id,
      title: 'Require ===',
      body: 'body text',
      severity: 'error',
      language: 'javascript',
      category: 'best-practices',
      embedding_model: 'voyage-code-3',
      embedding_dim: 1024,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  it('embeds the query, queries dense + sparse retrievers, RRF-merges, joins SQLite chunks', async () => {
    const provider = makeProvider();
    provider.embedQuery.mockResolvedValue({ vector: vec(0.5), tokensUsed: 5 } satisfies EmbedQueryResult);
    const store = makeStore();
    store.query.mockResolvedValue([sampleHit]);
    const chunks = makeChunkRepo();
    chunks.findByIds.mockReturnValue([sampleChunkRow(sampleHit.id)]);
    // Sparse retriever returns nothing for this test — the dense leg
    // is the only contributor, but RRF still runs.
    chunks.searchByKeyword.mockReturnValue([]);

    const svc = new EmbeddingsService(
      makeLoader({ sources: [], chunks: [] }),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    const hits = await svc.search('some diff', { k: 5 });

    expect(provider.embedQuery).toHaveBeenCalledWith('some diff');
    // Each retriever is queried at HYBRID_CANDIDATE_MULTIPLIER × k so
    // RRF has a wider candidate pool than the final cut. With the
    // 73-chunk corpus and a 200-token diff producing dozens of chunks
    // tied at per-token-rank 1, the multiplier is 8 — k=5 → candidateK=40.
    expect(store.query).toHaveBeenCalledWith(
      expect.objectContaining({ k: 40, embedding: expect.any(Array) }),
    );
    expect(chunks.searchByKeyword).toHaveBeenCalledWith('some diff', 40);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule_id: 'eqeqeq',
      source: 'airbnb-eslint',
      title: 'Require ===',
      document: 'body text',
      // Metadata is now sourced from the canonical SQLite chunk row,
      // not the (denormalized, drift-prone) vector-store metadata.
      metadata: {
        severity: 'error',
        language: 'javascript',
        category: 'best-practices',
      },
    });
    // RRF score for a single rank-1 contributor at kFusion=10 (the
    // EmbeddingsService override for this small corpus): 1 / (10 + 1).
    expect(hits[0].score).toBeCloseTo(1 / 11, 6);
  });

  it('defaults k to 10; each retriever sees k × candidate multiplier', async () => {
    const provider = makeProvider();
    provider.embedQuery.mockResolvedValue({ vector: vec(0.1), tokensUsed: 1 });
    const store = makeStore();
    store.query.mockResolvedValue([]);
    const chunks = makeChunkRepo();
    chunks.searchByKeyword.mockReturnValue([]);

    const svc = new EmbeddingsService(
      makeLoader({ sources: [], chunks: [] }),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    await svc.search('diff');

    const opts = store.query.mock.calls[0][0] as VectorStoreQueryOptions;
    expect(opts.k).toBe(80);
    expect(chunks.searchByKeyword).toHaveBeenCalledWith('diff', 80);
  });

  it('combines dense and sparse hits — items in both rank higher than items in only one', async () => {
    const provider = makeProvider();
    provider.embedQuery.mockResolvedValue({ vector: vec(0.1), tokensUsed: 1 });
    const store = makeStore();
    // Dense ranks: in-both at #1, dense-only at #2.
    store.query.mockResolvedValue([
      { id: 'in-both', score: 0.9, document: 'd1', metadata: {} },
      { id: 'dense-only', score: 0.8, document: 'd2', metadata: {} },
    ]);
    const chunks = makeChunkRepo();
    // Sparse ranks: sparse-only at #1, in-both at #2.
    chunks.searchByKeyword.mockReturnValue([
      { id: 'sparse-only', bm25Score: -2.5 },
      { id: 'in-both', bm25Score: -1.8 },
    ]);
    chunks.findByIds.mockReturnValue([
      { ...sampleChunkRow('in-both', 'rule-both'), id: 'in-both', rule_id: 'rule-both' },
      { ...sampleChunkRow('dense-only', 'rule-dense'), id: 'dense-only', rule_id: 'rule-dense' },
      { ...sampleChunkRow('sparse-only', 'rule-sparse'), id: 'sparse-only', rule_id: 'rule-sparse' },
    ]);

    const svc = new EmbeddingsService(
      makeLoader({ sources: [], chunks: [] }),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    const hits = await svc.search('diff', { k: 3 });
    expect(hits[0].rule_id).toBe('rule-both');
    expect(hits.map((h) => h.rule_id)).toEqual(
      expect.arrayContaining(['rule-both', 'rule-dense', 'rule-sparse']),
    );
  });

  it('throws on empty diff before calling provider or store', async () => {
    const provider = makeProvider();
    const store = makeStore();

    const svc = new EmbeddingsService(
      makeLoader({ sources: [], chunks: [] }),
      provider,
      store,
      makeSourceRepo(),
      makeChunkRepo(),
    );

    await expect(svc.search('')).rejects.toThrow();
    await expect(svc.search('   ')).rejects.toThrow();
    expect(provider.embedQuery).not.toHaveBeenCalled();
    expect(store.query).not.toHaveBeenCalled();
  });

  it('returns [] when the vector store has no hits — no SQLite lookup', async () => {
    const provider = makeProvider();
    provider.embedQuery.mockResolvedValue({ vector: vec(0.1), tokensUsed: 1 });
    const store = makeStore();
    store.query.mockResolvedValue([]);
    const chunks = makeChunkRepo();

    const svc = new EmbeddingsService(
      makeLoader({ sources: [], chunks: [] }),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    const hits = await svc.search('diff');
    expect(hits).toEqual([]);
    expect(chunks.findByIds).not.toHaveBeenCalled();
  });

  it('drops hits whose ids are unknown to SQLite (drift tolerance)', async () => {
    const provider = makeProvider();
    provider.embedQuery.mockResolvedValue({ vector: vec(0.1), tokensUsed: 1 });
    const store = makeStore();
    store.query.mockResolvedValue([
      { id: 'a', score: 0.9, document: 'doc-a', metadata: {} },
      { id: 'b', score: 0.8, document: 'doc-b', metadata: {} },
      { id: 'c', score: 0.7, document: 'doc-c', metadata: {} },
    ]);
    const chunks = makeChunkRepo();
    // SQLite only knows 'a' and 'c' — 'b' is drift from a deleted chunk.
    chunks.findByIds.mockReturnValue([
      { ...sampleChunkRow('a', 'rule-a'), id: 'a', rule_id: 'rule-a' },
      { ...sampleChunkRow('c', 'rule-c'), id: 'c', rule_id: 'rule-c' },
    ]);

    const svc = new EmbeddingsService(
      makeLoader({ sources: [], chunks: [] }),
      provider,
      store,
      makeSourceRepo(),
      chunks,
    );

    const hits = await svc.search('diff');
    expect(hits.map((h) => h.rule_id)).toEqual(['rule-a', 'rule-c']);
  });
});
