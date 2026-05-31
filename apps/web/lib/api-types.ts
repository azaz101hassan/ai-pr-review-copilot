// boundary: see CLAUDE.md — apps/web MUST NOT import from apps/api/src/.
// These types mirror the actual response shapes emitted by the dashboard
// REST surface (apps/api/src/modules/dashboard/...). The backend's
// DashboardService returns AnalyticsAggregate / ReviewListEntry directly
// out of the repository, which means the wire shape carries:
//   - camelCase top-level fields on the response envelopes
//     (statusBreakdown, severityRollup, topRules, tokenTotals,
//     recentPrs, embeddingModel, ...);
//   - snake_case nested fields where they come straight from Drizzle's
//     InferSelectModel of the SQLite schema (column names);
//   - timestamps as ISO strings (JSON-stringified Date instances from
//     Drizzle `mode: 'timestamp_ms'`).
// Keep them in sync with the backend by hand; future days can codegen.
// Interfaces only — no runtime code.

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

export type ReviewStatus = 'completed' | 'failed' | 'in_progress';

export type SeverityLevel = 'error' | 'warning' | 'info';

// One row in the reviews list. The base columns mirror the Drizzle
// schema for the `reviews` table; the four trailing columns are joined
// from `pull_requests` (LEFT JOIN — null when pr_node_id is null).
export interface ReviewListEntry {
  id: string;
  pr_node_id: string | null;
  created_by: string | null;
  diff_length: number;
  model: string;
  prompt_version: string;
  top_k: number;
  /** JSON-encoded array of chunk IDs. Parse with JSON.parse on demand. */
  retrieved_chunk_ids: string;
  retrieved_chunk_ids_hash: string;
  status: ReviewStatus;
  error_status: number | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  turn_count: number;
  tool_calls_json: unknown;
  /** ISO 8601 string (Drizzle Date → JSON.stringify) */
  created_at: string;
  /** ISO 8601 string or null */
  completed_at: string | null;
  // Joined from pull_requests
  repo_full_name: string | null;
  pr_number: number | null;
  pr_title: string | null;
  author_login: string | null;
}

export interface ReviewFindingRecord {
  id: number;
  review_id: string;
  severity: SeverityLevel;
  rule_id: string;
  message: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  /** ISO 8601 string */
  created_at: string;
}

// Discriminated union — present when the chunk_id still exists in
// knowledge_chunks; otherwise the placeholder branch with missing: true.
export type HydratedChunk =
  | {
      id: string;
      missing: false;
      source_id: string;
      rule_id: string;
      title: string;
      body: string;
    }
  | {
      id: string;
      missing: true;
    };

// ---------------------------------------------------------------------------
// /dashboard/reviews
// ---------------------------------------------------------------------------

export interface ReviewListResponse {
  items: ReviewListEntry[];
  total: number;
  offset: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// /dashboard/reviews/:id
// Three siblings (review / findings / retrievedChunks), NOT a flattened
// detail object. Note retrievedChunks is camelCase.
// ---------------------------------------------------------------------------

// The single review row in a detail response carries the base reviews-table
// columns; PR join fields ship as a separate `pr` sibling on the response
// envelope (see ReviewDetailPrSummary below), not flattened onto the row.
export interface ReviewDetailRecord {
  id: string;
  pr_node_id: string | null;
  created_by: string | null;
  diff_length: number;
  model: string;
  prompt_version: string;
  top_k: number;
  retrieved_chunk_ids: string;
  retrieved_chunk_ids_hash: string;
  status: ReviewStatus;
  error_status: number | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  turn_count: number;
  tool_calls_json: unknown;
  created_at: string;
  completed_at: string | null;
}

// PR-side metadata anchored to the detail view. Mirrors the backend's
// PullRequestSummary; ships as a separate sibling on ReviewDetailResponse
// rather than flattened onto the review row, so consumers can distinguish
// "the review record" from "the PR it was run against." Null for
// standalone reviews (no pr_node_id) or when the PR row has been purged.
export interface ReviewDetailPrSummary {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string;
  author_login: string;
  /** ISO 8601 string (Drizzle Date → JSON.stringify) */
  created_at: string;
}

export interface ReviewDetailResponse {
  review: ReviewDetailRecord;
  findings: ReviewFindingRecord[];
  retrievedChunks: HydratedChunk[];
  pr: ReviewDetailPrSummary | null;
}

// ---------------------------------------------------------------------------
// /dashboard/analytics
// ---------------------------------------------------------------------------

export interface StatusBreakdown {
  completed: number;
  failed: number;
  in_progress: number;
}

export interface SeverityRollup {
  error: number;
  warning: number;
  info: number;
}

export interface TopRuleEntry {
  rule_id: string;
  count: number;
}

export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
}

// Token aggregates use Anthropic's column names (input_tokens /
// output_tokens / cache_creation / cache_read), summed across the
// matching review rows.
export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AnalyticsResponse {
  statusBreakdown: StatusBreakdown;
  severityRollup: SeverityRollup;
  topRules: TopRuleEntry[];
  tokenTotals: TokenTotals;
  latency: LatencyPercentiles;
}

// Derived totals for tile rendering. Volume is not returned by the API;
// it's the sum of the status breakdown.
export function analyticsVolume(a: AnalyticsResponse): number {
  return (
    a.statusBreakdown.completed +
    a.statusBreakdown.failed +
    a.statusBreakdown.in_progress
  );
}

// ---------------------------------------------------------------------------
// /dashboard/filters
// ---------------------------------------------------------------------------

export interface PullRequestSummary {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string | null;
  author_login: string | null;
  /** ISO 8601 string */
  created_at: string;
}

export interface FilterOptionsResponse {
  repos: string[];
  authors: string[];
  recentPrs: PullRequestSummary[];
}

// ---------------------------------------------------------------------------
// /dashboard/settings (positive allowlist — no secrets)
// ---------------------------------------------------------------------------

export interface KnowledgeSourceSummary {
  id: string;
  name: string;
  description: string | null;
}

export interface SeverityGate {
  allowed: SeverityLevel[];
  default: SeverityLevel;
}

export interface SettingsResponseDto {
  model: string;
  embeddingModel: string;
  chromaCollection: string;
  knowledgeSources: KnowledgeSourceSummary[];
  severityGate: SeverityGate;
}

// ---------------------------------------------------------------------------
// SSE terminal event (mirrors TerminalReviewEvent from the events service)
// ---------------------------------------------------------------------------

export interface TerminalReviewEvent {
  review_id: string;
  pr_node_id: string | null;
  repo_full_name: string | null;
  author_login: string | null;
  status: 'completed' | 'failed';
  prompt_version: string;
  finding_counts: SeverityRollup;
  token_totals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  } | null;
  /** epoch ms */
  completed_at: number;
}
