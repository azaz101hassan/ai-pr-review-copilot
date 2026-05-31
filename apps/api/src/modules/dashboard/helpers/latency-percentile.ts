// Pure function — no framework dependencies.
// Computes p50 and p95 from a list of raw duration values (milliseconds).
//
// Algorithm:
//   - Empty input → { p50: null, p95: null }
//   - Sort ascending, then:
//     - For N >= 10: use floor-index method (index = Math.floor(p / 100 * N))
//       clamped to [0, N-1].
//     - For N 1–9: linear interpolation so a single value returns itself
//       and small arrays behave sensibly. Interpolation formula:
//         h = p / 100 * (N - 1)
//         lo = Math.floor(h), hi = Math.ceil(h)
//         result = sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
//
// SQLite has no `percentile_cont` function, so latency rows are fetched
// into Node and processed here. Acceptable at local-first scale where
// row counts are tens-to-hundreds.

export interface LatencyResult {
  p50: number | null;
  p95: number | null;
}

export function computeLatencyPercentiles(durations: number[]): LatencyResult {
  if (durations.length === 0) {
    return { p50: null, p95: null };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;

  return {
    p50: percentile(sorted, n, 50),
    p95: percentile(sorted, n, 95),
  };
}

function percentile(sorted: number[], n: number, p: number): number {
  if (n >= 10) {
    // Floor-index method: consistent with most monitoring tools at
    // meaningful sample sizes.
    const idx = Math.min(Math.floor((p / 100) * n), n - 1);
    return sorted[idx];
  }

  // Linear interpolation for small N (1–9).
  const h = (p / 100) * (n - 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) {
    return sorted[lo];
  }
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
