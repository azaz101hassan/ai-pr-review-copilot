import { KnowledgeChunkRecord, KnowledgeChunkInsert } from './knowledge-chunk.types';

export const KNOWLEDGE_CHUNK_REPOSITORY = Symbol('KnowledgeChunkRepository');

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
}
