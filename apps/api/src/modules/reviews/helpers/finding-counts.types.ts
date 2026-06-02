// Severity-rollup counts used by the two body formatters. Both
// format-review-body (the slim Review body) and
// format-walkthrough-body (the editable Walkthrough body) carry
// the same 3-column counts table, so the shape is shared.

export interface FindingCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}
