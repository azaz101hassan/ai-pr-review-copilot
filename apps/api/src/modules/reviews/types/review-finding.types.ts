import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { reviewFindings } from '@/infrastructure/db/schema';

// SELECT shape. `severity` narrows to the literal union via the schema's
// enum mode.
export type ReviewFindingRecord = InferSelectModel<typeof reviewFindings>;

export type ReviewFindingInsert = InferInsertModel<typeof reviewFindings>;
