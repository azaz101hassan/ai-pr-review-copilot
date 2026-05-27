import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { knowledgeChunks } from '@/infrastructure/db/schema';

// SELECT shape. `severity` narrows to `'error' | 'warning' | 'info' | null`
// via the schema's enum mode; `language` narrows likewise. Timestamps are
// Date objects.
export type KnowledgeChunkRecord = InferSelectModel<typeof knowledgeChunks>;

export type KnowledgeChunkInsert = InferInsertModel<typeof knowledgeChunks>;
