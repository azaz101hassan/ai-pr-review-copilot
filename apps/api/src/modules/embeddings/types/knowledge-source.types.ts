import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { knowledgeSources } from '@/infrastructure/db/schema';

// SELECT shape. `created_at` is a Date because the schema declares it as
// timestamp_ms; `description` is nullable.
export type KnowledgeSourceRecord = InferSelectModel<typeof knowledgeSources>;

export type KnowledgeSourceInsert = InferInsertModel<typeof knowledgeSources>;
