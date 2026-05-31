// boundary: see CLAUDE.md — apps/web MUST NOT import from apps/api/src/.
// These types duplicate apps/api/src/modules/dashboard/types/dashboard-response.types.ts
// one-to-one. Keep them in sync with U4 by hand; future days can codegen.
// Interfaces only — no runtime code.

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

export type ReviewStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type SeverityLevel = 'error' | 'warning' | 'info';

export interface ReviewFindingSummary {
  id: number;
  severity: SeverityLevel;
  rule_id: string;
  message: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  created_at: number; // epoch ms
}

export interface ReviewListItem {
  id: number;
  status: ReviewStatus;
  pr_node_id: string | null;
  /** Joined from pull_requests — null when pr_node_id is null */
  repo_full_name: string | null;
  pr_number: number | null;
  pr_title: string | null;
  author_login: string | null;
  prompt_version: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  created_at: number; // epoch ms
  completed_at: number | null; // epoch ms
}

export interface RetrievedChunk {
  id: string;
  missing: boolean;
  rule_id?: string;
  source_path?: string;
  text_preview?: string;
}

export interface ReviewDetailItem extends ReviewListItem {
  findings: ReviewFindingSummary[];
  retrieved_chunks: RetrievedChunk[];
  turn_count: number | null;
  cached_input_tokens: number | null;
}

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export interface ReviewListResponse {
  items: ReviewListItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface ReviewDetailResponse {
  review: ReviewDetailItem;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface SeverityRollup {
  error: number;
  warning: number;
  info: number;
}

export interface TopRule {
  rule_id: string;
  count: number;
}

export interface LatencySnapshot {
  p50: number | null;
  p95: number | null;
}

export interface TokenTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  cached_input_tokens: number;
}

export interface AnalyticsResponse {
  /** Total review count matching the filter (excludes standalone rows) */
  volume: number;
  status_breakdown: {
    completed: number;
    failed: number;
    pending: number;
    in_progress: number;
  };
  severity_rollup: SeverityRollup;
  top_rules: TopRule[];
  latency: LatencySnapshot;
  token_totals: TokenTotals;
}

// ---------------------------------------------------------------------------
// Filter options (for populating dropdowns)
// ---------------------------------------------------------------------------

export interface PullRequestSummary {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string | null;
  author_login: string | null;
}

export interface FilterOptionsResponse {
  repos: string[];
  authors: string[];
  recent_prs: PullRequestSummary[];
}

// ---------------------------------------------------------------------------
// Settings (positive allowlist — no secrets)
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
  embedding_model: string;
  chroma_collection: string;
  knowledge_sources: KnowledgeSourceSummary[];
  severity_gate: SeverityGate;
}

// ---------------------------------------------------------------------------
// SSE terminal event (mirrors TerminalReviewEvent from U2)
// ---------------------------------------------------------------------------

export interface TerminalReviewEvent {
  review_id: number;
  pr_node_id: string | null;
  repo_full_name: string | null;
  author_login: string | null;
  status: 'completed' | 'failed';
  prompt_version: string | null;
  severity_counts: SeverityRollup;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  completed_at: number; // epoch ms
}
