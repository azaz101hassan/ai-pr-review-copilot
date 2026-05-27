import { Inject, Injectable, Logger } from '@nestjs/common';
import { CorpusLoader, LoadedCorpus, NormalizedChunk } from './helpers/corpus-loader';
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

  // Query read path. Embed the diff once, query Chroma top-K, then
  // re-fetch the chunk rows from SQLite for canonical title + body. The
  // SQLite re-fetch is what makes the seam survive Chroma drift: if a
  // vector points at an id that no longer exists in SQLite, that hit is
  // dropped with a warning rather than returned as a fabrication.
  async search(diff: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    if (!diff || diff.trim().length === 0) {
      throw new Error('diff must be a non-empty string');
    }

    const k = options.k ?? DEFAULT_K;
    const { vector } = await this.provider.embedQuery(diff);
    const rawHits = await this.vectorStore.query({
      embedding: vector,
      k,
      where: options.where,
    });

    if (rawHits.length === 0) return [];

    const chunkRows = this.chunks.findByIds(rawHits.map((h) => h.id));
    const byId = new Map(chunkRows.map((row) => [row.id, row]));

    const hits: SearchHit[] = [];
    for (const hit of rawHits) {
      const chunk = byId.get(hit.id);
      if (!chunk) {
        // Drift between Chroma and SQLite — Chroma still has a vector
        // for an id the SQLite catalogue no longer knows. Drop and
        // warn; do NOT fabricate from the metadata in the vector store
        // (it's a denormalized copy that may be stale).
        this.logger.warn(
          `vector store returned id ${hit.id} with no SQLite chunk row — dropping`,
        );
        continue;
      }
      hits.push({
        rule_id: chunk.rule_id,
        source: chunk.source_id,
        score: hit.score,
        title: chunk.title,
        document: chunk.body,
        metadata: hit.metadata,
      });
    }
    return hits;
  }
}
