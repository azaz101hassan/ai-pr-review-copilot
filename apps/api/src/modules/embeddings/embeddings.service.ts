import { Inject, Injectable, Logger } from '@nestjs/common';
import { CorpusLoader, LoadedCorpus, NormalizedChunk } from './helpers/corpus-loader';
import { rrfMerge } from './helpers/reciprocal-rank-fusion';
import {
  EMBEDDING_PROVIDER,
  IEmbeddingProvider,
} from './types/embedding-provider';
import { VECTOR_STORE, IVectorStore } from './types/vector-store';
import {
  KNOWLEDGE_SOURCE_REPOSITORY,
  IKnowledgeSourceRepository,
} from './types/knowledge-source.repository';
import {
  KNOWLEDGE_CHUNK_REPOSITORY,
  IKnowledgeChunkRepository,
} from './types/knowledge-chunk.repository';
import { KnowledgeChunkInsert } from './types/knowledge-chunk.types';

// Multiply the requested `k` by this when querying each retriever
// individually, so the RRF merge has a wider candidate pool than the
// final result size. The multiplier needs to be high enough that the
// sparse leg can return every chunk tied at per-token-rank-1 — with
// ~200 unique diff tokens and a 73-rule corpus, that's typically
// 40-60 chunks. `8` keeps the pool comfortably above that ceiling at
// the typical k=25 (candidate=200), and the FTS5 cost stays
// sub-millisecond per query at this corpus size.
const HYBRID_CANDIDATE_MULTIPLIER = 8;

// Voyage's per-request cap is 1000 inputs; we batch at 128 to stay well
// clear and keep each request small enough that a single rate-limit
// stall costs little (the seed corpus fits in a single batch today, but
// the loop guards future growth).
const EMBED_BATCH_SIZE = 128;

const DEFAULT_K = 10;

export interface IndexCorpusResult {
  insertedSources: number;
  upsertedChunks: number;
  totalTokens: number;
}

export interface SearchOptions {
  k?: number;
  where?: Record<string, unknown>;
}

export interface SearchHit {
  rule_id: string;
  source: string;
  score: number;
  title: string;
  document: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    private readonly corpusLoader: CorpusLoader,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: IEmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly vectorStore: IVectorStore,
    @Inject(KNOWLEDGE_SOURCE_REPOSITORY)
    private readonly sources: IKnowledgeSourceRepository,
    @Inject(KNOWLEDGE_CHUNK_REPOSITORY)
    private readonly chunks: IKnowledgeChunkRepository,
  ) {}

  // Seed write path. Reads seeds → upserts sources → batches embed →
  // upserts chunks to SQLite → upserts vectors to Chroma. SQLite is
  // authoritative; if Chroma upsert fails the SQLite row stays and the
  // next seed run will catch up.
  async indexCorpus(corpus?: LoadedCorpus): Promise<IndexCorpusResult> {
    const loaded = corpus ?? this.corpusLoader.load();

    for (const source of loaded.sources) {
      this.sources.upsert({
        id: source.id,
        name: source.name,
        description: source.description,
        created_at: new Date(),
      });
    }

    let upsertedChunks = 0;
    let totalTokens = 0;

    for (let i = 0; i < loaded.chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = loaded.chunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.body);
      const { vectors, tokensUsed } = await this.provider.embedDocuments(texts);
      totalTokens += tokensUsed;

      const now = new Date();
      const records: KnowledgeChunkInsert[] = batch.map((chunk) => ({
        id: chunk.id,
        source_id: chunk.source_id,
        rule_id: chunk.rule_id,
        title: chunk.title,
        body: chunk.body,
        severity: chunk.severity ?? null,
        language: chunk.language ?? null,
        category: chunk.category ?? null,
        embedding_model: this.provider.modelName,
        embedding_dim: this.provider.dimension,
        created_at: now,
        updated_at: now,
      }));

      // Order discipline: persist to SQLite first (authoritative source
      // of truth for chunk text), then push vectors into Chroma. If
      // Chroma is down the SQLite rows are durable and the next seed
      // run will catch up the index.
      this.chunks.upsertMany(records);

      await this.vectorStore.upsert(
        batch.map((chunk, idx) => ({
          id: chunk.id,
          embedding: vectors[idx],
          document: chunk.body,
          metadata: {
            source: chunk.source_id,
            rule_id: chunk.rule_id,
            ...(chunk.severity ? { severity: chunk.severity } : {}),
            ...(chunk.language ? { language: chunk.language } : {}),
            ...(chunk.category ? { category: chunk.category } : {}),
          },
        })),
      );

      upsertedChunks += batch.length;
    }

    this.logger.log(
      `indexCorpus: ${loaded.sources.length} sources, ${upsertedChunks} chunks, ${totalTokens} embedding tokens`,
    );

    return {
      insertedSources: loaded.sources.length,
      upsertedChunks,
      totalTokens,
    };
  }

  // Hybrid query read path. Embed the diff once and query Chroma for
  // dense (semantic) neighbours; in parallel, ask the SQLite FTS5 index
  // for sparse (BM25) keyword hits. Merge the two ranked lists via
  // Reciprocal Rank Fusion, then re-fetch chunk rows from SQLite for
  // canonical title + body. The SQLite re-fetch is what makes the seam
  // survive Chroma drift: if a vector points at an id that no longer
  // exists in SQLite, that hit is dropped with a warning rather than
  // returned as a fabrication.
  //
  // The dense leg catches semantic matches (a project-flavoured diff
  // vs an abstract rule description). The sparse leg catches
  // surface-token matches the embedding miss-rates on — classic ESLint
  // rules like `no-var` whose distinguishing signal is the literal
  // token `var` appearing in the diff.
  async search(diff: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    if (!diff || diff.trim().length === 0) {
      throw new Error('diff must be a non-empty string');
    }

    const k = options.k ?? DEFAULT_K;
    const candidateK = k * HYBRID_CANDIDATE_MULTIPLIER;

    const denseHitsPromise = this.provider.embedQuery(diff).then(({ vector }) =>
      this.vectorStore.query({
        embedding: vector,
        k: candidateK,
        where: options.where,
      }),
    );
    // FTS5 search is synchronous (better-sqlite3 is sync) but we wrap
    // in a resolved Promise so the two retrievers can be Promise.all'd.
    const sparseHitsPromise = Promise.resolve(
      this.chunks.searchByKeyword(diff, candidateK),
    );

    const [denseHits, sparseHits] = await Promise.all([
      denseHitsPromise,
      sparseHitsPromise,
    ]);

    // Apply optional `where` filter to sparse hits too — FTS5 doesn't
    // know about Chroma's metadata, but the caller may have used
    // `where` to scope retrieval to (say) one language. Drop sparse
    // candidates whose chunk row doesn't satisfy the filter.
    const filteredSparse = options.where
      ? this.filterSparseByWhere(sparseHits, options.where)
      : sparseHits;

    if (denseHits.length === 0 && filteredSparse.length === 0) return [];

    // Annotate sparse hits with their explicit per-token rank — the
    // repo returns rank directly via `bm25Score` (positive, smaller =
    // better), so multiple chunks can share a tied rank (every chunk
    // that was top-1 for ANY single diff token has rank 1). Without
    // this explicit field, RRF would treat each sparse-list position
    // as a serial rank and unfairly demote the tied chunks past the
    // first few positions.
    const sparseWithRank = filteredSparse.map((h) => ({
      id: h.id,
      rank: h.bm25Score,
    }));

    // kFusion=10 (vs the Cormack default of 60) intentionally amplifies
    // top-rank contributions. The default is calibrated for million-doc
    // retrieval where rank 1 and rank 10 are both noisy positives; our
    // 73-chunk corpus is the opposite regime — rank 1 in either leg is
    // a strong signal that should clearly outrank a both-lists rank 20
    // consensus item. Lowering kFusion makes top hits in one leg able
    // to stand against weaker consensus matches.
    const merged = rrfMerge<{ id: string; rank?: number }>(
      [denseHits, sparseWithRank],
      { finalK: k, kFusion: 10 },
    );

    const chunkRows = this.chunks.findByIds(merged.map((h) => h.id));
    const byId = new Map(chunkRows.map((row) => [row.id, row]));

    const hits: SearchHit[] = [];
    for (const hit of merged) {
      const chunk = byId.get(hit.id);
      if (!chunk) {
        // Drift between Chroma and SQLite — a Chroma vector or an FTS5
        // entry points at an id the SQLite catalogue no longer knows.
        // Drop and warn; do NOT fabricate from the metadata in the
        // vector store (it's a denormalized copy that may be stale).
        this.logger.warn(
          `retrieval returned id ${hit.id} with no SQLite chunk row — dropping`,
        );
        continue;
      }
      hits.push({
        rule_id: chunk.rule_id,
        source: chunk.source_id,
        score: hit.rrfScore,
        title: chunk.title,
        document: chunk.body,
        metadata: {
          severity: chunk.severity,
          language: chunk.language,
          category: chunk.category,
        },
      });
    }
    return hits;
  }

  // Apply a Chroma-style `where` filter to FTS5 hits. We re-fetch each
  // candidate's chunk row and keep only those whose metadata satisfies
  // every key in the filter. This duplicates the post-FTS join below
  // (and pays a small read cost twice) but keeps the `where` semantics
  // identical between the two retrievers, which matters for tests that
  // scope retrieval by language or severity.
  private filterSparseByWhere<H extends { id: string }>(
    sparseHits: H[],
    where: Record<string, unknown>,
  ): H[] {
    if (sparseHits.length === 0) return sparseHits;
    const rows = this.chunks.findByIds(sparseHits.map((h) => h.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return sparseHits.filter((hit) => {
      const row = byId.get(hit.id);
      if (!row) return false;
      for (const [key, expected] of Object.entries(where)) {
        const actual = (row as unknown as Record<string, unknown>)[key];
        if (actual !== expected) return false;
      }
      return true;
    });
  }
}
