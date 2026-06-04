import { KnowledgeChunkRecord, KnowledgeChunkInsert } from './knowledge-chunk.types';

export const KNOWLEDGE_CHUNK_REPOSITORY = Symbol('KnowledgeChunkRepository');

// A single keyword-search hit. Returned in ranked order (best first) by
// `searchByKeyword`. The `bm25Score` is whatever the underlying engine
// scores it as — for SQLite FTS5 that's a NEGATIVE float (more negative
// = better), but consumers should only rely on the ordering, not the
// absolute value.
export interface KeywordSearchHit {
  id: string;
  bm25Score: number;
}

export interface IKnowledgeChunkRepository {
  // Bulk write path for seeding — single transaction keeps the table in
  // a coherent state if a batch is interrupted mid-flight.
  upsertMany(records: KnowledgeChunkInsert[]): void;
  findById(id: string): KnowledgeChunkRecord | undefined;
  // Bulk read for query enrichment: a vector-store result hands back a
  // list of chunk ids, and the search path joins those against SQLite
  // for the canonical chunk text + source provenance. Returns rows in
  // the SAME order as `ids` (drops unknown ids) so the caller can zip
  // with the ranked hit list positionally.
  findByIds(ids: string[]): KnowledgeChunkRecord[];
  // Used by future "rebuild this source" flows — remove all chunks for
  // a single source before re-seeding to clear stale rules. Returns the
  // count deleted so callers can report progress.
  deleteBySourceId(sourceId: string): number;
  // Keyword (lexical) search over chunk bodies via the FTS5 index. The
  // engine ranks by BM25. Returns up to `k` ids in best-first order, or
  // an empty array when the query reduces to no usable tokens (e.g. a
  // diff that's only punctuation). This is the sparse-retrieval leg of
  // the hybrid search seam — the dense (Voyage+Chroma) leg handles
  // semantic matches that share no surface tokens.
  searchByKeyword(query: string, k: number): KeywordSearchHit[];
}
