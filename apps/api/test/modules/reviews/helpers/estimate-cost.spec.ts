import { estimateCost } from '@/modules/reviews/helpers/estimate-cost';
import { UsageStats } from '@/modules/reviews/types/llm-reviewer';

// Pure-function helper for the running cost line at the end of every
// CLI invocation. The rates are baked in; the test pins the math so
// rate updates are deliberate.

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...overrides,
  };
}

describe('estimateCost', () => {
  describe('cold-call math (no cache)', () => {
    it('Sonnet 4-6: 1k input / 500 output → $0.003 + $0.0075 = $0.0105', () => {
      const est = estimateCost(usage(), 'claude-sonnet-4-6');
      expect(est.inputUsd).toBeCloseTo(0.003, 6);
      expect(est.outputUsd).toBeCloseTo(0.0075, 6);
      expect(est.cacheReadUsd).toBe(0);
      expect(est.cacheWriteUsd).toBe(0);
      expect(est.totalUsd).toBeCloseTo(0.0105, 6);
    });

    it('Haiku 4-5: 1k input / 500 output → $0.001 + $0.0025 = $0.0035 (≈ Sonnet / 3)', () => {
      const est = estimateCost(usage(), 'claude-haiku-4-5-20251001');
      expect(est.inputUsd).toBeCloseTo(0.001, 6);
      expect(est.outputUsd).toBeCloseTo(0.0025, 6);
      expect(est.totalUsd).toBeCloseTo(0.0035, 6);
    });

    it('Opus 4-7: 1k input / 500 output → $0.015 + $0.0375 = $0.0525 (5× Sonnet)', () => {
      const est = estimateCost(usage(), 'claude-opus-4-7');
      expect(est.totalUsd).toBeCloseTo(0.0525, 6);
    });
  });

  describe('cache token accounting', () => {
    it('cache_read tokens are charged at 0.1× the input rate', () => {
      const est = estimateCost(
        usage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }),
        'claude-sonnet-4-6',
      );
      // cache_read: 1000 tokens at 0.1 * $3/M = $0.0003
      expect(est.cacheReadUsd).toBeCloseTo(0.0003, 6);
    });

    it('cache_write tokens are charged at 1.25× the input rate', () => {
      const est = estimateCost(
        usage({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000 }),
        'claude-sonnet-4-6',
      );
      // cache_write: 1000 tokens at 1.25 * $3/M = $0.00375
      expect(est.cacheWriteUsd).toBeCloseTo(0.00375, 6);
    });

    it('breakdown buckets add up to totalUsd', () => {
      const est = estimateCost(
        usage({
          input_tokens: 2000,
          output_tokens: 1000,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 1200,
        }),
        'claude-sonnet-4-6',
      );
      expect(est.inputUsd + est.outputUsd + est.cacheReadUsd + est.cacheWriteUsd).toBeCloseTo(
        est.totalUsd,
        6,
      );
    });
  });

  describe('unknown model fallback', () => {
    it('falls back to Sonnet rates and warns once per session', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const first = estimateCost(usage(), 'claude-mystery-9-9');
      const second = estimateCost(usage(), 'claude-mystery-9-9');
      // Both calls produce Sonnet-equivalent estimates.
      expect(first.totalUsd).toBeCloseTo(0.0105, 6);
      expect(second.totalUsd).toBeCloseTo(0.0105, 6);
      // But the warning fires only once.
      const matchingWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('claude-mystery-9-9'),
      );
      expect(matchingWarns.length).toBe(1);
      expect(first.rateModel).toBe('claude-sonnet-4-6');
      warnSpy.mockRestore();
    });
  });

  describe('null tolerance', () => {
    it('treats null/undefined cache fields as zero (no charge)', () => {
      const est = estimateCost(usage(), 'claude-sonnet-4-6');
      expect(est.cacheReadUsd).toBe(0);
      expect(est.cacheWriteUsd).toBe(0);
    });
  });
});
