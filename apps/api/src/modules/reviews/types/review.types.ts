import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { reviews } from '@/infrastructure/db/schema';

// SELECT shape. `status` narrows to the literal union via the schema's
// enum mode; timestamps come back as Date objects.
export type ReviewRecord = InferSelectModel<typeof reviews>;

export type ReviewInsert = InferInsertModel<typeof reviews>;

// Patch shape passed to IReviewRepository.markCompleted — the columns
// that get populated on the successful terminal flip from `in_progress`
// to `completed`. `error_status` / `error_code` stay null on this path;
// they belong to `markFailed`.
export type ReviewCompletionPatch = {
  completed_at: Date;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
};

// Patch shape passed to IReviewRepository.markFailed. Token columns stay
// null on failure (we never got a response); error columns get populated.
export type ReviewFailurePatch = {
  completed_at: Date;
  error_status: number | null;
  error_code: string;
};
