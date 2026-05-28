// Day-4 seam between the agent loop and "where the code lives". The
// adapter (`AnthropicLlmReviewer`) consumes this through
// `AnalyzeDiffInput.repoContext` rather than constructor injection so
// the same adapter instance can serve CLI runs (filesystem-backed),
// HTTP smoke runs (null-backed), and eventually Day-5 real PRs
// (GitHub-API-backed) without per-call mutation.
//
// All three methods return a discriminated union. Success carries
// `content`; failure carries a structured `reason` enum so Claude can
// reason about whether a different tool or input would succeed. Day-4's
// `FilesystemRepoContextProvider` only ever emits `not_found`,
// `invalid_input`, and `parse_error` — the wider vocabulary
// (`forbidden | rate_limited | network`) is contracted up front so
// Day-5's `GitHubRepoContextProvider` doesn't renegotiate the
// interface (404 / 403 / 429 / connection errors map cleanly).

export const REPO_CONTEXT_PROVIDER = Symbol('RepoContextProvider');

export type RepoContextErrorReason =
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'network'
  | 'invalid_input'
  | 'parse_error';

export interface RepoContextError {
  ok: false;
  reason: RepoContextErrorReason;
  message: string;
  retryAfterMs?: number;
}

export interface RepoFileSuccess {
  ok: true;
  content: string;
  path: string;
}

export type RepoFileResult = RepoFileSuccess | RepoContextError;

export interface RepoFunctionSuccess {
  ok: true;
  content: string;
  path: string;
  startLine: number;
  endLine: number;
}

export type RepoFunctionResult = RepoFunctionSuccess | RepoContextError;

// Prior-review entry shape. Both Day-4's filesystem provider (reads
// from a JSON file) and Day-5's DB-backed sibling (reads from
// `review_findings`) produce this exact shape. `dismissed_at` is
// epoch ms (CLAUDE.md timestamp_ms convention) so JSON fixtures and
// SQL rows never drift on representation. `null` means "not
// dismissed"; a number means "dismissed at this instant".
export interface PriorReviewEntry {
  review_id: string;
  finding_id: string;
  rule_id: string;
  file_path: string;
  location_hint: string;
  dismissed_at: number | null;
  message: string;
}

export interface PriorReviewQuery {
  pr_node_id?: string;
  file_path?: string;
  rule_id?: string;
}

export interface RepoPriorReviewSuccess {
  ok: true;
  content: PriorReviewEntry[];
}

export type RepoPriorReviewResult = RepoPriorReviewSuccess | RepoContextError;

export interface IRepoContextProvider {
  // Fetch the full text of a file at the given repo-relative path.
  // Missing path → `not_found`. Path traversal (`..` escapes) →
  // `invalid_input`. Day-5's GitHub sibling may additionally emit
  // `forbidden` / `rate_limited` / `network`.
  fetchFile(path: string): Promise<RepoFileResult>;

  // Locate a function or method definition by name. When `file` is
  // provided, search only that file; otherwise walk the repo. Returns
  // the matched block plus surrounding context. Heuristic-based — see
  // `docs/setup/claude.md` for the documented limitations.
  fetchFunctionDefinition(
    name: string,
    file?: string,
  ): Promise<RepoFunctionResult>;

  // Fetch prior findings for the contextual PR / file / rule. Missing
  // data is NOT an error — returns `{ ok: true, content: [] }`. This
  // is a deliberate asymmetry with `fetchFile`: a specific file is
  // expected to exist; prior-review data is optional context that may
  // simply not exist yet (Day-4 cold-start). Only structural failures
  // (malformed JSON) emit `parse_error`.
  fetchPriorReview(query: PriorReviewQuery): Promise<RepoPriorReviewResult>;
}
