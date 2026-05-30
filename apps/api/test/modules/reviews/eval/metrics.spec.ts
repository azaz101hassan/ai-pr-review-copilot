import {
  scoreFixture,
  aggregateMetrics,
  assertThresholds,
  allThresholdsPassed,
  computeCleanABDelta,
} from '@/modules/reviews/eval/metrics';
import type {
  FixtureScore,
  Thresholds,
} from '@/modules/reviews/eval/metrics';
import type {
  Recording,
  EmittedRecording,
  ThrewRecording,
  RecordingProvenance,
  RecordedFinding,
  FaithfulnessClaim,
} from '@/modules/reviews/eval/recording';
import type { LoadedManifestEntry } from '@/modules/reviews/eval/manifest';

// ── Helpers ────────────────────────────────────────────────────────

function makeProvenance(
  overrides: Partial<RecordingProvenance> = {},
): RecordingProvenance {
  return {
    promptVersion: 'v3',
    model: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-haiku-4-5-20251001',
    judgePromptVersion: 'v1',
    seedCorpusVersion: 'v1',
    expectedSetHash: 'hash-placeholder',
    gitSha: 'deadbeef',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<RecordedFinding> = {}): RecordedFinding {
  return {
    rule_id: 'no-var',
    title: 'Avoid var',
    message: 'Use const or let.',
    faithfulness: {
      score: 1.0,
      claims: [
        {
          claim: 'The code uses var.',
          kind: 'diff_assertion',
          reason: 'Visible in diff.',
          verdict: 'supported',
        },
      ],
    },
    ...overrides,
  };
}

function makeEmitted(
  overrides: Partial<EmittedRecording> & { fixtureId?: string } = {},
): EmittedRecording {
  return {
    status: 'emitted',
    fixtureId: 'test-fixture',
    findings: [makeFinding()],
    ruleSet: ['no-var'],
    provenance: makeProvenance(),
    ...overrides,
  };
}

function makeThrew(
  overrides: Partial<ThrewRecording> & { fixtureId?: string } = {},
): ThrewRecording {
  return {
    status: 'threw',
    fixtureId: 'test-threw',
    error: {
      errorCode: 'turn_cap_exceeded',
      turnCount: 6,
      toolCalls: null,
    },
    provenance: makeProvenance(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<LoadedManifestEntry> = {}): LoadedManifestEntry {
  return {
    fixtureId: 'test-fixture',
    path: 'test/fixtures/diffs/test.patch',
    category: 'violating',
    expected: ['no-var'],
    needsRepoContext: false,
    expectedSetHash: 'hash-placeholder',
    gates: true,
    ...overrides,
  };
}

// ── Per-fixture scoring ────────────────────────────────────────────

describe('scoreFixture', () => {
  // AE1: clean fixture with 1 emitted finding => FP, lowers precision.
  it('clean fixture (expected=[]) with 1 emitted finding => FP, lowers precision', () => {
    const entry = makeEntry({
      fixtureId: 'clean-1',
      category: 'clean',
      expected: [],
    });
    const recording = makeEmitted({
      fixtureId: 'clean-1',
      findings: [makeFinding({ rule_id: 'no-var' })],
    });

    const score = scoreFixture(entry, recording);

    expect(score.tp).toBe(0);
    expect(score.fp).toBe(1);
    expect(score.fn).toBe(0);
    // Precision is 0/1 = 0.
    expect(score.precision).toBe(0);
    // Recall is undefined for empty-expected.
    expect(score.recall).toBeNull();
    // F1 is null (recall is null).
    expect(score.f1).toBeNull();
  });

  // Multi-rule: expecting 4, emits 2 expected + 1 unexpected.
  it('multi-rule: expecting 4, emits 2 expected + 1 unexpected => TP=2, FN=2, FP=1', () => {
    const entry = makeEntry({
      fixtureId: 'multi',
      expected: ['rule-a', 'rule-b', 'rule-c', 'rule-d'],
    });
    const recording = makeEmitted({
      fixtureId: 'multi',
      findings: [
        makeFinding({ rule_id: 'rule-a' }),
        makeFinding({ rule_id: 'rule-b' }),
        makeFinding({ rule_id: 'rule-x' }), // unexpected
      ],
    });

    const score = scoreFixture(entry, recording);

    expect(score.tp).toBe(2);
    expect(score.fn).toBe(2);
    expect(score.fp).toBe(1);
    expect(score.precision).toBeCloseTo(2 / 3);
    expect(score.recall).toBeCloseTo(2 / 4);
  });

  // Duplicate emitted rule_ids dedupe before counting.
  it('duplicate emitted rule_ids dedupe to set before counting', () => {
    const entry = makeEntry({
      fixtureId: 'dup',
      expected: ['no-var'],
    });
    const recording = makeEmitted({
      fixtureId: 'dup',
      findings: [
        makeFinding({ rule_id: 'no-var' }),
        makeFinding({ rule_id: 'no-var' }), // duplicate
      ],
    });

    const score = scoreFixture(entry, recording);

    // Deduped: only 1 TP, not 2.
    expect(score.tp).toBe(1);
    expect(score.fp).toBe(0);
    expect(score.fn).toBe(0);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
  });

  // AE4: zero findings across corpus => F1 0.
  it('zero findings with non-empty expected => recall 0, F1 0', () => {
    const entry = makeEntry({
      fixtureId: 'zero',
      expected: ['rule-a'],
    });
    const recording = makeEmitted({
      fixtureId: 'zero',
      findings: [],
    });

    const score = scoreFixture(entry, recording);

    expect(score.tp).toBe(0);
    expect(score.fp).toBe(0);
    expect(score.fn).toBe(1);
    expect(score.precision).toBeNull(); // no emissions
    expect(score.recall).toBe(0);
    // F1 requires both precision and recall to be non-null.
    // With precision null, F1 is null here at the per-fixture level.
    // The micro aggregate handles this correctly (see aggregate tests).
  });

  // Contract failure (malformed_emit_finding) => expected rules become FN.
  it('contract failure (malformed_emit_finding) => expected rules become FN', () => {
    const entry = makeEntry({
      fixtureId: 'contract',
      expected: ['rule-a', 'rule-b'],
    });
    const recording = makeThrew({
      fixtureId: 'contract',
      error: {
        errorCode: 'malformed_emit_finding',
        turnCount: 3,
        toolCalls: null,
      },
    });

    const score = scoreFixture(entry, recording);

    expect(score.fn).toBe(2);
    expect(score.tp).toBe(0);
    expect(score.fp).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.f1).toBe(0);
    expect(score.errorCode).toBe('malformed_emit_finding');
    expect(score.excluded).toBeUndefined();
  });

  // Cap-saturated (turn_cap_exceeded) => separate count, no F1 impact.
  it('cap-saturated (turn_cap_exceeded) => excluded, no F1 impact', () => {
    const entry = makeEntry({
      fixtureId: 'cap',
      category: 'agent-loop',
      expected: ['no-param-reassign'],
    });
    const recording = makeThrew({
      fixtureId: 'cap',
      error: {
        errorCode: 'turn_cap_exceeded',
        turnCount: 6,
        toolCalls: null,
      },
    });

    const score = scoreFixture(entry, recording);

    expect(score.excluded).toBe('cap_saturated');
    expect(score.tp).toBe(0);
    expect(score.fp).toBe(0);
    expect(score.fn).toBe(0);
    expect(score.f1).toBeNull();
    expect(score.errorCode).toBe('turn_cap_exceeded');
  });

  // Infra failure => excluded from F1.
  it('infra failure (credit_balance_too_low) => excluded from F1', () => {
    const entry = makeEntry({
      fixtureId: 'infra',
      expected: ['rule-a'],
    });
    const recording = makeThrew({
      fixtureId: 'infra',
      error: {
        errorCode: 'credit_balance_too_low',
        turnCount: null,
        toolCalls: null,
      },
    });

    const score = scoreFixture(entry, recording);

    expect(score.excluded).toBe('infra');
    expect(score.tp).toBe(0);
    expect(score.fp).toBe(0);
    expect(score.fn).toBe(0);
    expect(score.f1).toBeNull();
    expect(score.errorCode).toBe('credit_balance_too_low');
  });

  // Unclear rate: 5 of 10 claims unclear.
  it('unclear rate: 5 of 10 claims unclear => unclearRate = 0.5, score counts them as not_supported', () => {
    const claims: FaithfulnessClaim[] = [
      ...Array.from({ length: 3 }, () => ({
        claim: 'supported claim',
        kind: 'diff_assertion',
        reason: 'visible',
        verdict: 'supported' as const,
      })),
      ...Array.from({ length: 5 }, () => ({
        claim: 'unclear claim',
        kind: 'diff_assertion',
        reason: 'ambiguous',
        verdict: 'unclear' as const,
      })),
      ...Array.from({ length: 2 }, () => ({
        claim: 'not supported claim',
        kind: 'diff_assertion',
        reason: 'fabricated',
        verdict: 'not_supported' as const,
      })),
    ];

    const entry = makeEntry({ fixtureId: 'unclear-test', expected: ['rule-a'] });
    const recording = makeEmitted({
      fixtureId: 'unclear-test',
      findings: [
        makeFinding({
          rule_id: 'rule-a',
          faithfulness: { score: 0.3, claims },
        }),
      ],
    });

    const score = scoreFixture(entry, recording);

    // supported / total = 3/10 = 0.3 (unclear counts as not_supported).
    expect(score.faithfulnessScore).toBeCloseTo(0.3);
    expect(score.supportedRate).toBeCloseTo(0.3);
    expect(score.unclearRate).toBeCloseTo(0.5);
    expect(score.notSupportedRate).toBeCloseTo(0.2);
  });

  // AE2: Suppression three-part check.
  describe('suppression verification', () => {
    it('zero findings + priorReviewSnapshot with dismissed_at => verified', () => {
      const entry = makeEntry({
        fixtureId: 'supp',
        category: 'suppression',
        expected: [],
      });
      const recording = makeEmitted({
        fixtureId: 'supp',
        findings: [],
        priorReviewSnapshot: [
          { rule_id: 'eqeqeq', dismissed_at: 1717000000000 },
        ],
      });

      const score = scoreFixture(entry, recording);
      expect(score.suppressionVerified).toBe(true);
    });

    it('zero findings WITHOUT priorReviewSnapshot => not verified', () => {
      const entry = makeEntry({
        fixtureId: 'supp-no-snap',
        category: 'suppression',
        expected: [],
      });
      const recording = makeEmitted({
        fixtureId: 'supp-no-snap',
        findings: [],
      });

      const score = scoreFixture(entry, recording);
      expect(score.suppressionVerified).toBe(false);
    });

    it('findings present on suppression fixture => not verified', () => {
      const entry = makeEntry({
        fixtureId: 'supp-fp',
        category: 'suppression',
        expected: [],
      });
      const recording = makeEmitted({
        fixtureId: 'supp-fp',
        findings: [makeFinding({ rule_id: 'eqeqeq' })],
        priorReviewSnapshot: [
          { rule_id: 'eqeqeq', dismissed_at: 1717000000000 },
        ],
      });

      const score = scoreFixture(entry, recording);
      expect(score.suppressionVerified).toBe(false);
    });
  });

  // gates:false fixture excluded from gating aggregate.
  it('gates:false fixture has gates=false in score', () => {
    const entry = makeEntry({
      fixtureId: 'non-gating',
      gates: false,
      expected: ['rule-a'],
    });
    const recording = makeEmitted({
      fixtureId: 'non-gating',
      findings: [makeFinding({ rule_id: 'rule-a' })],
    });

    const score = scoreFixture(entry, recording);
    expect(score.gates).toBe(false);
  });
});

// ── Aggregate metrics ──────────────────────────────────────────────

describe('aggregateMetrics', () => {
  it('micro-aggregates TP/FP/FN across gating fixtures', () => {
    const scores: FixtureScore[] = [
      // Fixture 1: TP=2, FP=1, FN=0 (expected 2, emitted 3).
      {
        fixtureId: 'f1',
        category: 'violating',
        gates: true,
        tp: 2,
        fp: 1,
        fn: 0,
        precision: 2 / 3,
        recall: 1,
        f1: (2 * (2 / 3) * 1) / (2 / 3 + 1),
        faithfulnessScore: 1.0,
        supportedRate: 1.0,
        unclearRate: 0,
        notSupportedRate: 0,
      },
      // Fixture 2: TP=1, FP=0, FN=1 (expected 2, emitted 1).
      {
        fixtureId: 'f2',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 1,
        precision: 1,
        recall: 0.5,
        f1: (2 * 1 * 0.5) / (1 + 0.5),
        faithfulnessScore: 0.5,
        supportedRate: 0.5,
        unclearRate: 0.25,
        notSupportedRate: 0.25,
      },
    ];

    const agg = aggregateMetrics(scores);

    // Micro: TP=3, FP=1, FN=1.
    expect(agg.micro.tp).toBe(3);
    expect(agg.micro.fp).toBe(1);
    expect(agg.micro.fn).toBe(1);
    expect(agg.micro.precision).toBeCloseTo(3 / 4);
    expect(agg.micro.recall).toBeCloseTo(3 / 4);
    // F1 = 2 * 0.75 * 0.75 / (0.75 + 0.75) = 0.75.
    expect(agg.micro.f1).toBeCloseTo(0.75);
  });

  it('excludes non-gating fixtures from gating aggregate', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'gating',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
      {
        fixtureId: 'non-gating',
        category: 'violating',
        gates: false,
        tp: 0,
        fp: 5,
        fn: 3,
        precision: 0,
        recall: 0,
        f1: 0,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
    ];

    const agg = aggregateMetrics(scores, true);

    // Only the gating fixture contributes.
    expect(agg.micro.tp).toBe(1);
    expect(agg.micro.fp).toBe(0);
    expect(agg.micro.fn).toBe(0);
    expect(agg.micro.f1).toBeCloseTo(1);
  });

  it('cap-saturated fixtures excluded from F1, counted separately', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'normal',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
      {
        fixtureId: 'cap-sat',
        category: 'agent-loop',
        gates: true,
        tp: 0,
        fp: 0,
        fn: 0,
        precision: null,
        recall: null,
        f1: null,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
        excluded: 'cap_saturated',
        errorCode: 'turn_cap_exceeded',
      },
    ];

    const agg = aggregateMetrics(scores);

    // Only the normal fixture contributes to F1.
    expect(agg.micro.tp).toBe(1);
    expect(agg.micro.f1).toBeCloseTo(1);
    expect(agg.capSaturatedCount).toBe(1);
    expect(agg.incompleteCaptureCount).toBe(0);
  });

  it('infra failures excluded from F1, counted as incompleteCaptureCount', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'infra',
        category: 'violating',
        gates: true,
        tp: 0,
        fp: 0,
        fn: 0,
        precision: null,
        recall: null,
        f1: null,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
        excluded: 'infra',
        errorCode: 'credit_balance_too_low',
      },
    ];

    const agg = aggregateMetrics(scores);

    expect(agg.incompleteCaptureCount).toBe(1);
    expect(agg.capSaturatedCount).toBe(0);
    // F1 is null — no eligible fixtures.
    expect(agg.micro.f1).toBeNull();
  });

  // AE4: zero findings across corpus => F1 0.
  it('zero findings across corpus with non-empty expected => micro F1 = 0', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'empty-1',
        category: 'violating',
        gates: true,
        tp: 0,
        fp: 0,
        fn: 2,
        precision: null,
        recall: 0,
        f1: null,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
      {
        fixtureId: 'empty-2',
        category: 'violating',
        gates: true,
        tp: 0,
        fp: 0,
        fn: 1,
        precision: null,
        recall: 0,
        f1: null,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
    ];

    const agg = aggregateMetrics(scores);

    // Micro: TP=0, FP=0, FN=3.
    // Precision = null (0/0), Recall = 0/3 = 0.
    // F1 = 0 (precision null + recall non-null => 0).
    expect(agg.micro.precision).toBeNull();
    expect(agg.micro.recall).toBeCloseTo(0);
    expect(agg.micro.f1).toBe(0);
  });

  // Micro vs macro F1 diverge on uneven sizes.
  it('micro vs macro F1 diverge on uneven expected-set sizes', () => {
    const scores: FixtureScore[] = [
      // Small fixture: TP=1, FP=0, FN=0 (perfect, F1=1).
      {
        fixtureId: 'small',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
      // Large fixture: TP=1, FP=0, FN=9 (bad, F1=0.18...).
      {
        fixtureId: 'large',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 9,
        precision: 1,
        recall: 0.1,
        f1: (2 * 1 * 0.1) / (1 + 0.1),
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
    ];

    const agg = aggregateMetrics(scores);

    // Micro: TP=2, FP=0, FN=9 => P=1.0, R=2/11, F1=2*1*(2/11)/(1+2/11).
    const microR = 2 / 11;
    const expectedMicroF1 = (2 * 1 * microR) / (1 + microR);
    expect(agg.micro.f1).toBeCloseTo(expectedMicroF1);

    // Macro: mean of [1.0, 0.18...] = ~0.59...
    const perFixtureF1Large = (2 * 1 * 0.1) / (1 + 0.1);
    const expectedMacroF1 = (1 + perFixtureF1Large) / 2;
    expect(agg.macro.f1).toBeCloseTo(expectedMacroF1);

    // They should NOT be equal.
    expect(agg.micro.f1).not.toBeCloseTo(agg.macro.f1!);
  });

  it('faithfulness aggregate computes mean across fixtures', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'f1',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: 0.8,
        supportedRate: 0.8,
        unclearRate: 0.1,
        notSupportedRate: 0.1,
      },
      {
        fixtureId: 'f2',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: 0.6,
        supportedRate: 0.6,
        unclearRate: 0.2,
        notSupportedRate: 0.2,
      },
    ];

    const agg = aggregateMetrics(scores);

    expect(agg.faithfulness.meanScore).toBeCloseTo(0.7);
    expect(agg.faithfulness.supportedRate).toBeCloseTo(0.7);
    expect(agg.faithfulness.unclearRate).toBeCloseTo(0.15);
    expect(agg.faithfulness.notSupportedRate).toBeCloseTo(0.15);
  });
});

// ── Clean A/B delta ────────────────────────────────────────────────

describe('computeCleanABDelta', () => {
  it('computes delta between full-corpus and top-10 recordings', () => {
    const full = makeEmitted({
      fixtureId: 'clean-ab',
      findings: [makeFinding(), makeFinding({ rule_id: 'extra' })],
    });
    const top10 = makeEmitted({
      fixtureId: 'clean-ab',
      findings: [],
    });

    const delta = computeCleanABDelta(full, top10, 'clean-ab');

    expect(delta).not.toBeNull();
    expect(delta!.fullCorpusFindingCount).toBe(2);
    expect(delta!.top10FindingCount).toBe(0);
    expect(delta!.delta).toBe(2);
  });

  it('returns null when a recording is missing', () => {
    const full = makeEmitted({ fixtureId: 'clean-ab' });

    expect(computeCleanABDelta(full, null, 'clean-ab')).toBeNull();
    expect(computeCleanABDelta(null, full, 'clean-ab')).toBeNull();
  });
});

// ── Threshold assertion ────────────────────────────────────────────

describe('assertThresholds', () => {
  it('empty thresholds => no results (report-only)', () => {
    const agg = aggregateMetrics([]);
    const results = assertThresholds(agg, {});

    expect(results).toHaveLength(0);
    expect(allThresholdsPassed(results)).toBe(true);
  });

  it('F1 above threshold => passed', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'f1',
        category: 'violating',
        gates: true,
        tp: 3,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
    ];
    const agg = aggregateMetrics(scores);
    const results = assertThresholds(agg, { microF1: 0.8 });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(allThresholdsPassed(results)).toBe(true);
  });

  it('F1 below threshold => failed', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'f1',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 4,
        precision: 1,
        recall: 0.2,
        f1: (2 * 1 * 0.2) / (1 + 0.2),
        faithfulnessScore: null,
        supportedRate: null,
        unclearRate: null,
        notSupportedRate: null,
      },
    ];
    const agg = aggregateMetrics(scores);
    const results = assertThresholds(agg, { microF1: 0.8 });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(allThresholdsPassed(results)).toBe(false);
  });

  it('faithfulness threshold absent but F1 threshold set => faithfulness reported, F1 gated', () => {
    const scores: FixtureScore[] = [
      {
        fixtureId: 'f1',
        category: 'violating',
        gates: true,
        tp: 1,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        f1: 1,
        faithfulnessScore: 0.5,
        supportedRate: 0.5,
        unclearRate: 0.25,
        notSupportedRate: 0.25,
      },
    ];
    const agg = aggregateMetrics(scores);
    // Only microF1 threshold, no faithfulness threshold.
    const results = assertThresholds(agg, { microF1: 0.8 });

    expect(results).toHaveLength(1);
    expect(results[0].metric).toBe('micro-F1');
    expect(results[0].passed).toBe(true);
    // Faithfulness is computed in the aggregate but not gated.
    expect(agg.faithfulness.meanScore).toBeCloseTo(0.5);
  });

  it('F1 null (no eligible fixtures) with threshold set => fails', () => {
    const agg = aggregateMetrics([]);
    const results = assertThresholds(agg, { microF1: 0.5 });

    expect(results).toHaveLength(1);
    expect(results[0].actual).toBeNull();
    expect(results[0].passed).toBe(false);
  });
});
