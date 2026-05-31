import { computeLatencyPercentiles } from '@/modules/dashboard/helpers/latency-percentile';

describe('computeLatencyPercentiles', () => {
  describe('edge cases', () => {
    it('returns { p50: null, p95: null } for empty input', () => {
      expect(computeLatencyPercentiles([])).toEqual({ p50: null, p95: null });
    });

    it('returns the single value for both p50 and p95 when input has one element', () => {
      expect(computeLatencyPercentiles([42])).toEqual({ p50: 42, p95: 42 });
    });

    it('handles two elements', () => {
      // h_p50 = 0.50 * 1 = 0.5 → interp between sorted[0]=10 and sorted[1]=20 = 15
      // h_p95 = 0.95 * 1 = 0.95 → interp between sorted[0]=10 and sorted[1]=20 = 19.5
      const result = computeLatencyPercentiles([20, 10]);
      expect(result.p50).toBeCloseTo(15, 5);
      expect(result.p95).toBeCloseTo(19.5, 5);
    });
  });

  describe('small N (1–9 elements) — linear interpolation', () => {
    it('[10, 20, 30, 40, 50] (N=5) — plan example: p50=30, p95=50', () => {
      // h_p50 = 0.50 * 4 = 2.0 → sorted[2] = 30
      // h_p95 = 0.95 * 4 = 3.8 → interp sorted[3]=40 and sorted[4]=50 → 40 + 0.8*10 = 48
      const result = computeLatencyPercentiles([10, 20, 30, 40, 50]);
      expect(result.p50).toBe(30);
      // p95 for N=5 uses interpolation: 40 + 0.8 * (50 - 40) = 48
      expect(result.p95).toBeCloseTo(48, 5);
    });

    it('unsorted input is sorted before computation', () => {
      // Same values as above but shuffled
      const result = computeLatencyPercentiles([50, 10, 30, 40, 20]);
      expect(result.p50).toBe(30);
    });

    it('all-same values returns that value for both percentiles', () => {
      const result = computeLatencyPercentiles([100, 100, 100]);
      expect(result.p50).toBe(100);
      expect(result.p95).toBe(100);
    });

    it('9-element array uses interpolation (still < 10)', () => {
      const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const result = computeLatencyPercentiles(vals);
      // h_p50 = 0.50 * 8 = 4.0 → sorted[4] = 5
      expect(result.p50).toBe(5);
      // h_p95 = 0.95 * 8 = 7.6 → interp sorted[7]=8 and sorted[8]=9 → 8 + 0.6 = 8.6
      expect(result.p95).toBeCloseTo(8.6, 5);
    });
  });

  describe('N >= 10 elements — floor-index method', () => {
    it('10-element array: p50 at index 5, p95 at index 9', () => {
      // sorted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      // p50: floor(0.50 * 10) = 5 → sorted[5] = 6
      // p95: floor(0.95 * 10) = 9 → sorted[9] = 10
      const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = computeLatencyPercentiles(vals);
      expect(result.p50).toBe(6);
      expect(result.p95).toBe(10);
    });

    it('20-element uniform array', () => {
      // sorted: 1..20
      // p50: floor(0.50 * 20) = 10 → sorted[10] = 11
      // p95: floor(0.95 * 20) = 19 → sorted[19] = 20
      const vals = Array.from({ length: 20 }, (_, i) => i + 1);
      const result = computeLatencyPercentiles(vals);
      expect(result.p50).toBe(11);
      expect(result.p95).toBe(20);
    });

    it('all-same values (N=10) returns that value', () => {
      const vals = new Array(10).fill(500);
      const result = computeLatencyPercentiles(vals);
      expect(result.p50).toBe(500);
      expect(result.p95).toBe(500);
    });

    it('does not mutate the original array', () => {
      const original = [3, 1, 2];
      computeLatencyPercentiles(original);
      expect(original).toEqual([3, 1, 2]);
    });
  });
});
