// Severity-rollup counts used across the body/check-run formatters —
// the slim Review body (format-review-body) and the terminal check-run
// output (format-check-run-output) both carry the same 3-column rollup,
// so the shape is shared.

export interface FindingCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}
