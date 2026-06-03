import {
  ReviewCompletionPatch,
  ReviewFailurePatch,
  ReviewInsert,
  ReviewRecord,
} from './review.types';
import { ReviewFindingRecord } from './review-finding.types';

// Dashboard read-side types.

// Filter spec used by the dashboard endpoints. All fields are optional;
// the time bounds are inclusive. The controller maps validated query DTOs
// to this shape before calling repository methods.
export interface ReviewFilterSpec {
  repo?: string;
  author?: string;
  prNodeId?: string;
  sinceMs?: number;
  untilMs?: number;
}

// Single row returned by findFiltered. The LEFT JOIN over pull_requests
// surfaces PR metadata; all PR columns are null when pr_node_id is null.
export interface ReviewListEntry {
  // All columns from reviews
  id: string;
  pr_node_id: string | null;
  created_by: string | null;
  diff_length: number;
  model: string;
  prompt_version: string;
  top_k: number;
  retrieved_chunk_ids: string;
  retrieved_chunk_ids_hash: string;
  status: 'completed' | 'failed' | 'in_progress';
  error_status: number | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  turn_count: number;
  tool_calls_json: unknown;
  created_at: Date;
  completed_at: Date | null;
  // LEFT JOIN from pull_requests
  repo_full_name: string | null;
  pr_number: number | null;
  pr_title: string | null;
  author_login: string | null;
  // Correlated subquery — number of review_findings rows for this review.
  // 0 for reviews that have no findings (clean or failed-before-findings).
  finding_count: number;
}

// Severity breakdown: how many findings per severity level across matched reviews.
export interface SeverityRollup {
  error: number;
  warning: number;
  info: number;
}

// Status breakdown: count per terminal status across matched reviews.
export interface StatusBreakdown {
  completed: number;
  failed: number;
  in_progress: number;
}

// Top-N rule breakdown entry.
export interface TopRuleEntry {
  rule_id: string;
  count: number;
}

// Top-N error-code breakdown entry. Surfaced by the dashboard so the
// operator can see which reviewer-loop failure modes dominate the
// time-window slice. Excludes POST-side / orchestration codes (see
// `aggregateByFilter` for the deny-list) so the chip's meaning stays
// scoped to reviewer behavior, not GitHub-post or worker-lifecycle
// failures.
export interface ErrorCodeEntry {
  error_code: string;
  count: number;
}

// Token totals summed over matched reviews.
export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

// Latency percentiles, computed in TS from raw durations.
export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
}

// Aggregate return shape from aggregateByFilter.
// All six aggregate queries run inside one read transaction.
//
// Standalone rows (prompt_version IN ('standalone-failure',
// 'standalone-empty-diff', 'standalone-skipped-too-large')) are
// excluded from every "main" aggregate query because they have no
// findings, zero or null token fields, and would distort metrics.
//
// `skippedCount` is the one exception — a dedicated count of
// `standalone-skipped-too-large` rows so the dashboard can surface
// how often the size gate is firing.
export interface AnalyticsAggregate {
  statusBreakdown: StatusBreakdown;
  severityRollup: SeverityRollup;
  topRules: TopRuleEntry[];
  tokenTotals: TokenTotals;
  latency: LatencyPercentiles;
  /** Count of size-gate skips matching the filter (separate from statusBreakdown). */
  skippedCount: number;
  /**
   * Sum of `hallucinated_finding_count` across matching non-standalone
   * reviews. Surfaces how often the reviewer emits findings that the
   * hallucination filter has to drop (unknown rule_id or wrong
   * `source:rule_id` composite). Standalone synthetic rows carry 0
   * so the `baseWhere` exclusion has no effect on the sum.
   */
  hallucinatedTotal: number;
  /**
   * Top-N error-code breakdown for failed reviews. Scoped to
   * reviewer-loop failure modes only — POST-side and orchestration
   * codes (comment_post_failed, inline_post_failed, pr_closed_during_review,
   * process_terminated) are excluded so the chip's signal stays scoped to
   * reviewer behavior rather than worker/GitHub-post lifecycle. Top-10
   * by count from the aggregator; renderers may subset further.
   */
  errorCodeBreakdown: ErrorCodeEntry[];
  /**
   * Sum of `cache_hit_count` across matching non-standalone reviews —
   * the number of tool-call invocations the per-review dedup cache
   * short-circuited instead of re-invoking the tool. Useful for
   * confirming the dedup work is actually saving turns.
   */
  cacheHitTotal: number;
}

export const REVIEW_REPOSITORY = Symbol('ReviewRepository');

export interface IReviewRepository {
  // Inserts a new review row. The 3-step lifecycle (see ReviewsService)
  // calls this with status='in_progress' BEFORE the Claude call so a
  // process death doesn't leak an unfinalised attempt — the startup
  // sweep then finalises it as 'failed'/'process_terminated'.
  insert(record: ReviewInsert): void;

  findById(id: string): ReviewRecord | undefined;

  // Listing API. Capped at 100 rows by default to keep the response
  // bounded — replaced by `findFiltered` (offset-based) for the
  // dashboard. Retained for internal/debug callers.
  findAll(limit?: number): ReviewRecord[];

  // Flips an `in_progress` row to `completed` with the usage stats. Used
  // inside ReviewsService's transaction so completion + finding inserts
  // commit atomically.
  markCompleted(id: string, patch: ReviewCompletionPatch): void;

  // Flips an `in_progress` row to `failed` with the error fields. Used
  // on the Anthropic-error catch path; no transaction needed because
  // there are no findings to coordinate with. Also used by the
  // comment_post_failed path to flip a 'completed' row to 'failed'
  // when the Review POST didn't land — that's a legitimate
  // completed→failed semantic transition (analysis succeeded, POST
  // did not), which is why this version isn't guarded on status.
  markFailed(id: string, patch: ReviewFailurePatch): void;

  // Same as markFailed BUT only fires when the row's status is still
  // 'in_progress'. The SIGTERM drain uses this so a row that finished
  // completing milliseconds before the drain inspected its in-flight
  // Set doesn't get flipped from 'completed' to 'failed'. Returns the
  // number of rows actually updated.
  markFailedIfInProgress(id: string, patch: ReviewFailurePatch): number;

  // Startup sweep. Marks any `in_progress` row whose `created_at` is
  // older than the cutoff as `failed` with the given error_code (e.g.,
  // 'process_terminated'). Returns the number of rows updated.
  sweepStaleInProgress(opts: { olderThanMs: number; errorCode: string }): number;

  // Worker guard. Returns the most-recent in_progress row for the
  // given pr_node_id whose created_at is within the lookback window,
  // or undefined when no such row exists. ReviewsProcessor consults
  // this at job entry — when a row is already running for the same
  // PR (BullMQ stalled-job replay; double-delivery race) the
  // processor exits clean rather than starting a parallel Anthropic
  // call.
  findRecentInProgressForPr(
    prNodeId: string,
    withinMs: number,
  ): ReviewRecord | undefined;

  // Dashboard read-side methods.

  // Returns reviews matching the filter spec, joined with pull_requests
  // via LEFT JOIN so PR metadata is available (NULL when pr_node_id is
  // null). Ordered by created_at DESC. Offset-based pagination; defaults
  // to offset=0. Does NOT exclude standalone rows — the list page shows
  // all reviews so the UI row count matches the DB count.
  findFiltered(
    spec: ReviewFilterSpec,
    opts: { limit: number; offset?: number },
  ): ReviewListEntry[];

  // Returns the total count of rows matching the filter, used by the
  // frontend for "showing N–M of TOTAL" and next-page disabling.
  // Does NOT exclude standalone rows (same scope as findFiltered).
  countFiltered(spec: ReviewFilterSpec): number;

  // Returns a single review and its findings, or null when the id
  // does not exist. Findings are ordered by created_at ASC.
  findByIdWithFindings(id: string): { review: ReviewRecord; findings: ReviewFindingRecord[] } | null;

  // Runs nine queries inside a single read transaction and returns
  // the aggregated analytics for the matched filter window. The five
  // "main" queries and the three observability queries exclude
  // standalone rows via baseWhere; the sixth (size-gate skip count)
  // and the error-code breakdown narrow further by additional
  // predicates. See the implementation for the per-query details.
  aggregateByFilter(spec: ReviewFilterSpec): AnalyticsAggregate;

  // Returns sorted distinct repo_full_name values from the joined
  // pull_requests table for reviews matching the filter. Bounded by limit.
  distinctRepos(spec: ReviewFilterSpec, limit: number): string[];

  // Returns sorted distinct author_login values from the joined
  // pull_requests table for reviews matching the filter. Reviews with
  // null pr_node_id do not surface a null entry in the result.
  // Bounded by limit.
  distinctAuthors(spec: ReviewFilterSpec, limit: number): string[];
}
