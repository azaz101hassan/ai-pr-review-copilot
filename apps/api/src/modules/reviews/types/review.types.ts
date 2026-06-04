import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { reviews } from '@/infrastructure/db/schema';

// Catalog of every concrete `error_code:` / `errorCode:` literal
// currently written to a `reviews` row across the worker, the
// service, the Anthropic adapter, and the boot probes. Eval reads
// this column heavily and benefits from a typed surface so an
// unknown code is a compile error rather than a silent
// classifier-miss.
//
// `string & {}` keeps the union *open* — the SQLite column is plain
// TEXT and we accept whatever lands there at runtime (never let
// type tightening on a string column corrupt prod data). Callers
// that want strict membership can use a `ReviewErrorCode extends
// KnownReviewErrorCode` check at the boundary.
//
// Categories (kept as one flat union — narrowing happens at the
// catch site, not in the type):
//   Worker / pre-runRealReview:
//     - pr_closed_during_review
//     - diff_too_large
//     - github_api_error
//     - comment_post_failed
//   Lifecycle / process:
//     - process_terminated   (drain timeout, startup sweep)
//     - internal_error       (defensive — see processor UUID drift)
//   Anthropic-classified (rawErrorCode passed through, plus our synth):
//     - rate_limit_error
//     - invalid_request_error
//     - authentication_error
//     - permission_error
//     - not_found_error
//     - credit_balance_too_low
//     - anthropic_error      (catchall when raw was unknown)
//   Agent-loop terminal:
//     - turn_cap_exceeded
//     - malformed_emit_finding
//     - unexpected_response_shape
//   Boot probes:
//     - app_probe_failed
export type KnownReviewErrorCode =
  | 'pr_closed_during_review'
  | 'diff_too_large'
  | 'github_api_error'
  | 'comment_post_failed'
  | 'process_terminated'
  | 'internal_error'
  | 'rate_limit_error'
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'credit_balance_too_low'
  | 'anthropic_error'
  | 'turn_cap_exceeded'
  | 'malformed_emit_finding'
  | 'unexpected_response_shape'
  | 'app_probe_failed';

export type ReviewErrorCode = KnownReviewErrorCode | (string & {});

// Membership check for runtime narrowing — eval treats unknown
// codes as "needs investigation". Sourced from the same literal
// list as KnownReviewErrorCode — keep both in sync when adding a
// new code.
const KNOWN_REVIEW_ERROR_CODES = new Set<KnownReviewErrorCode>([
  'pr_closed_during_review',
  'diff_too_large',
  'github_api_error',
  'comment_post_failed',
  'process_terminated',
  'internal_error',
  'rate_limit_error',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'credit_balance_too_low',
  'anthropic_error',
  'turn_cap_exceeded',
  'malformed_emit_finding',
  'unexpected_response_shape',
  'app_probe_failed',
]);

export function isKnownReviewErrorCode(
  value: unknown,
): value is KnownReviewErrorCode {
  return (
    typeof value === 'string' &&
    KNOWN_REVIEW_ERROR_CODES.has(value as KnownReviewErrorCode)
  );
}

// SELECT shape. `status` narrows to the literal union via the schema's
// enum mode; timestamps come back as Date objects.
export type ReviewRecord = InferSelectModel<typeof reviews>;

export type ReviewInsert = InferInsertModel<typeof reviews>;

// Per-turn record captured by the agent loop. Stored as a JSON array
// on `reviews.tool_calls_json`. `input_hash` is a SHA-256 prefix of
// the canonical-JSON serialization of `tool_use.input`; the full
// input is not stored. `result_bytes` is the byte length of the
// `tool_result` content (helps eval budget conversation growth).
// `stop_reason` is Anthropic's per-call stop_reason; useful to see
// why a turn ended (`tool_use` vs `end_turn` vs `max_tokens`).
export type ToolCallRecord = {
  turn_idx: number;
  tool_name: string;
  input_hash: string;
  result_bytes: number;
  latency_ms: number;
  stop_reason: string;
  is_error?: boolean;
  /**
   * True when this call returned a cached result from a prior turn
   * within the same review. The model invoked the same (tool, input)
   * pair again, the agent loop short-circuited the provider call, and
   * the response carried a steering hint encouraging the model to emit
   * findings instead of re-fetching. Useful for quantifying how often
   * the dedup cache saves a turn.
   */
  cache_hit?: boolean;
};

// Patch shape passed to IReviewRepository.markCompleted — the columns
// that get populated on the successful terminal flip from `in_progress`
// to `completed`. `error_status` / `error_code` stay null on this path;
// they belong to `markFailed`. `turn_count`, `tool_calls`, and `model`
// are optional so historical / partial callers stay valid; the typical
// path populates them from the reviewer's AnalyzeDiffResult.
export type ReviewCompletionPatch = {
  completed_at: Date;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  turn_count?: number;
  tool_calls?: ToolCallRecord[] | null;
  // Observability counters. Both are optional so historical / partial
  // callers default to 0 (matches the column default); typical path
  // populates them from the reviewer's AnalyzeDiffResult.
  hallucinated_finding_count?: number;
  cache_hit_count?: number;
  // The actual model id echoed back by the provider SDK. When set,
  // markCompleted overwrites the placeholder inserted before the
  // analyzeDiff call. Optional for backward-compat with callers
  // that pre-date the multi-provider switch.
  model?: string;
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
