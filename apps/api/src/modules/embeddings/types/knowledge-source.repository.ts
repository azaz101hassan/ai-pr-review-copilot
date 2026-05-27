import { KnowledgeSourceRecord, KnowledgeSourceInsert } from './knowledge-source.types';

export const KNOWLEDGE_SOURCE_REPOSITORY = Symbol('KnowledgeSourceRepository');

export interface IKnowledgeSourceRepository {
  upsert(record: KnowledgeSourceInsert): void;
  findById(id: string): KnowledgeSourceRecord | undefined;
  listAll(): KnowledgeSourceRecord[];
}
