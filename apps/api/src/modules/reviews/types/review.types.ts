import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { reviews } from '@/infrastructure/db/schema';

// SELECT shape. `status` narrows to the literal union via the schema's
// enum mode; timestamps come back as Date objects.
export type ReviewRecord = InferSelectModel<typeof reviews>;

export type ReviewInsert = InferInsertModel<typeof reviews>;

// Per-turn record captured by the Day-4 agent loop. Stored as a JSON
// array on `reviews.tool_calls_json`. `input_hash` is a SHA-256 prefix
// of the canonical-JSON serialization of `tool_use.input`; the full
// input is not stored. `result_bytes` is the byte length of the
// `tool_result` content (helps Day-6 eval budget conversation growth).
// `stop_reason` is Anthropic's per-call stop_reason; useful to see why
// a turn ended (`tool_use` vs `end_turn` vs `max_tokens`).
export type ToolCallRecord = {
  turn_idx: number;
  tool_name: string;
  input_hash: string;
  result_bytes: number;
  latency_ms: number;
  stop_reason: string;
  is_error?: boolean;
};

// Patch shape passed to IReviewRepository.markCompleted — the columns
// that get populated on the successful terminal flip from `in_progress`
// to `completed`. `error_status` / `error_code` stay null on this path;
// they belong to `markFailed`. `turn_count` and `tool_calls` are
// optional so historical / dead-code callers stay valid until U5 wires
// them; once U5 lands, every completion call passes them.
export type ReviewCompletionPatch = {
  completed_at: Date;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  turn_count?: number;
  tool_calls?: ToolCallRecord[] | null;
};

// Patch shape passed to IReviewRepository.markFailed. Token columns stay
// null on failure (we never got a response); error columns get populated.
// `turn_count` is optional — `turn_cap_exceeded` carries 6, network
// failures before turn 1 carry 0 (or omit).
export type ReviewFailurePatch = {
  completed_at: Date;
  error_status: number | null;
  error_code: string;
  turn_count?: number;
  tool_calls?: ToolCallRecord[] | null;
};
