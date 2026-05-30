/**
 * Pure metrics engine for the offline eval scorer.
 *
 * NO Nest/ConfigService imports — this must run keyless in CI.
 *
 * Computes:
 *   - Per-fixture TP/FP/FN via rule_id set-matching
 *   - Micro/macro precision, recall, F1
 *   - Three-bucket errorCode triage on threw recordings
 *   - Faithfulness aggregate (supported/unclear/not-supported rates)
 *   - Threshold assertion (report-only when unset)
 */

import type {
  Recording,
  EmittedRecording,
  ThrewRecording,
  FaithfulnessVerdict,
} from '@/modules/reviews/eval/recording';
import { isEmittedRecording, isThrewRecording } from '@/modules/reviews/eval/recording';
import type { LoadedManifestEntry } from '@/modules/reviews/eval/manifest';

// ── Error-code classification ──────────────────────────────────────

const CONTRACT_FAILURE_CODES = new Set([
  'malformed_emit_finding',
  'unexpected_response_shape',
]);

const CAP_SATURATED_CODES = new Set(['turn_cap_exceeded']);

/**
 * Infra codes — excluded from F1, counted under incompleteCaptureCount.
 * Anything that is NOT a contract failure and NOT cap-saturated is infra.
 */
function isInfraError(errorCode: string): boolean {
  return !CONTRACT_FAILURE_CODES.has(errorCode) && !CAP_SATURATED_CODES.has(errorCode);
}

// ── Per-fixture scoring ────────────────────────────────────────────

export interface FixtureScore {
  fixtureId: string;
  category: string;
  gates: boolean;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null; // null when tp + fp = 0
  recall: number | null; // null when expected is empty (clean/suppression)
  f1: number | null;
  /** Faithfulness score (supported / total); null when no claims. */
  faithfulnessScore: number | null;
  supportedRate: number | null;
  unclearRate: number | null;
  notSupportedRate: number | null;
  /** For threw recordings. */
  errorCode?: string;
  excluded?: 'cap_saturated' | 'infra';
  /** Suppression: whether the prior-review snapshot was present. */
  suppressionVerified?: boolean;
}

/**
 * Score a single fixture's recording against its manifest entry.
 *
 * - Emitted recordings: set-reduce emitted rule_ids (dedupe), classify TP/FP/FN.
 * - Threw recordings: three-bucket triage by errorCode.
 * - Empty-expected (clean/suppression): any finding is FP; recall is undefined.
 */
export function scoreFixture(
  entry: LoadedManifestEntry,
  recording: Recording,
): FixtureScore {
  const base = {
    fixtureId: entry.fixtureId,
    category: entry.category,
    gates: entry.gates,
  };

  // ── Threw recordings ─────────────────────────────────────────
  if (isThrewRecording(recording)) {
    return scoreThrewFixture(entry, recording, base);
  }

  // ── Emitted recordings ───────────────────────────────────────
  return scoreEmittedFixture(entry, recording, base);
}

function scoreThrewFixture(
  entry: LoadedManifestEntry,
  recording: ThrewRecording,
  base: { fixtureId: string; category: string; gates: boolean },
): FixtureScore {
  const { errorCode } = recording.error;

  // Cap-saturated: separate count, no F1 impact.
  if (CAP_SATURATED_CODES.has(errorCode)) {
    return {
      ...base,
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
      errorCode,
      excluded: 'cap_saturated',
    };
  }

  // Infra failure: excluded from F1.
  if (isInfraError(errorCode)) {
    return {
      ...base,
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
      errorCode,
      excluded: 'infra',
    };
  }

  // Contract failure: expected rules become FN, depressing F1.
  const fn = entry.expected.length;
  return {
    ...base,
    tp: 0,
    fp: 0,
    fn,
    precision: null, // no emissions
    recall: fn > 0 ? 0 : null,
    f1: fn > 0 ? 0 : null,
    faithfulnessScore: null,
    supportedRate: null,
    unclearRate: null,
    notSupportedRate: null,
    errorCode,
  };
}

function scoreEmittedFixture(
  entry: LoadedManifestEntry,
  recording: EmittedRecording,
  base: { fixtureId: string; category: string; gates: boolean },
): FixtureScore {
  const expectedSet = new Set(entry.expected);
  // Dedupe emitted rule_ids.
  const emittedSet = new Set(recording.findings.map((f) => f.rule_id));

  let tp = 0;
  let fp = 0;
  let fn = 0;

  // True positives: emitted AND expected.
  for (const ruleId of emittedSet) {
    if (expectedSet.has(ruleId)) {
      tp++;
    } else {
      fp++;
    }
  }

  // False negatives: expected but not emitted.
  for (const ruleId of expectedSet) {
    if (!emittedSet.has(ruleId)) {
      fn++;
    }
  }

  // Precision: tp / (tp + fp). Undefined when no emissions.
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;

  // Recall: undefined for empty-expected fixtures (clean/suppression).
  const recall = expectedSet.size > 0 ? tp / (tp + fn) : null;

  // F1: harmonic mean. Undefined when both precision and recall are null.
  let f1: number | null = null;
  if (precision !== null && recall !== null) {
    f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  }

  // Faithfulness.
  const { faithfulnessScore, supportedRate, unclearRate, notSupportedRate } =
    computeFaithfulnessForRecording(recording);

  // Suppression verification.
  const suppressionVerified =
    entry.category === 'suppression'
      ? verifySuppressionFixture(recording)
      : undefined;

  return {
    ...base,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    faithfulnessScore,
    supportedRate,
    unclearRate,
    notSupportedRate,
    suppressionVerified,
  };
}

// ── Faithfulness aggregation ───────────────────────────────────────

function computeFaithfulnessForRecording(recording: EmittedRecording): {
  faithfulnessScore: number | null;
  supportedRate: number | null;
  unclearRate: number | null;
  notSupportedRate: number | null;
} {
  const allClaims = recording.findings.flatMap((f) => f.faithfulness.claims);
  if (allClaims.length === 0) {
    return {
      faithfulnessScore: null,
      supportedRate: null,
      unclearRate: null,
      notSupportedRate: null,
    };
  }

  const counts = countVerdicts(allClaims.map((c) => c.verdict));
  const total = counts.supported + counts.unclear + counts.not_supported;

  return {
    faithfulnessScore: counts.supported / total,
    supportedRate: counts.supported / total,
    unclearRate: counts.unclear / total,
    notSupportedRate: counts.not_supported / total,
  };
}

function countVerdicts(verdicts: FaithfulnessVerdict[]): {
  supported: number;
  unclear: number;
  not_supported: number;
} {
  let supported = 0;
  let unclear = 0;
  let not_supported = 0;

  for (const v of verdicts) {
    switch (v) {
      case 'supported':
        supported++;
        break;
      case 'unclear':
        unclear++;
        break;
      case 'not_supported':
        not_supported++;
        break;
    }
  }

  return { supported, unclear, not_supported };
}

// ── Suppression verification ───────────────────────────────────────

/**
 * AE2: Suppression is verified if zero findings AND a priorReviewSnapshot
 * exists with at least one entry that has `dismissed_at != null`.
 */
function verifySuppressionFixture(recording: EmittedRecording): boolean {
  if (recording.findings.length > 0) return false;
  if (!recording.priorReviewSnapshot) return false;
  if (!Array.isArray(recording.priorReviewSnapshot)) return false;

  return (recording.priorReviewSnapshot as Array<{ dismissed_at?: unknown }>).some(
    (entry) => entry.dismissed_at != null,
  );
}

// ── Aggregate metrics ──────────────────────────────────────────────

export interface AggregateMetrics {
  // Micro-aggregated across gating fixtures (excludes cap-saturated and infra).
  micro: {
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  // Macro: mean of per-fixture F1s (only fixtures with defined F1).
  macro: {
    f1: number | null;
    /** Number of fixtures included in the macro average. */
    fixtureCount: number;
  };
  // Faithfulness: mean across all gating fixtures with recorded verdicts.
  faithfulness: {
    meanScore: number | null;
    supportedRate: number | null;
    unclearRate: number | null;
    notSupportedRate: number | null;
  };
  /** Cap-saturated agent-loop fixture count. */
  capSaturatedCount: number;
  /** Infra-failure count (excluded from F1). */
  incompleteCaptureCount: number;
}

/**
 * Aggregate metrics across scored fixtures.
 *
 * @param scores - Per-fixture scores (all fixtures, including non-gating).
 * @param gatingOnly - If true, only include gating fixtures in the aggregate.
 */
export function aggregateMetrics(
  scores: FixtureScore[],
  gatingOnly = true,
): AggregateMetrics {
  const filtered = gatingOnly ? scores.filter((s) => s.gates) : scores;

  // Exclude cap-saturated and infra from F1 aggregate.
  const f1Eligible = filtered.filter((s) => !s.excluded);

  // Micro aggregate.
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  for (const s of f1Eligible) {
    totalTp += s.tp;
    totalFp += s.fp;
    totalFn += s.fn;
  }

  const microPrecision = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : null;
  const microRecall = totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : null;
  let microF1: number | null = null;
  if (microPrecision !== null && microRecall !== null) {
    microF1 =
      microPrecision + microRecall > 0
        ? (2 * microPrecision * microRecall) / (microPrecision + microRecall)
        : 0;
  } else if (microPrecision === null && microRecall !== null) {
    // No emissions at all but expected rules exist => F1 = 0.
    microF1 = 0;
  }

  // Macro aggregate: mean of per-fixture F1 (only those with defined F1).
  const f1Values = f1Eligible.map((s) => s.f1).filter((f): f is number => f !== null);
  const macroF1 =
    f1Values.length > 0
      ? f1Values.reduce((a, b) => a + b, 0) / f1Values.length
      : null;

  // Faithfulness aggregate: mean of per-fixture scores.
  const faithScores = filtered
    .map((s) => s.faithfulnessScore)
    .filter((f): f is number => f !== null);
  const meanFaithfulness =
    faithScores.length > 0
      ? faithScores.reduce((a, b) => a + b, 0) / faithScores.length
      : null;

  // Overall verdict rates across all gating emitted fixtures.
  const allFaithRates = filtered.filter(
    (s) => s.supportedRate !== null,
  );
  const overallSupported =
    allFaithRates.length > 0
      ? allFaithRates.reduce((a, s) => a + s.supportedRate!, 0) / allFaithRates.length
      : null;
  const overallUnclear =
    allFaithRates.length > 0
      ? allFaithRates.reduce((a, s) => a + s.unclearRate!, 0) / allFaithRates.length
      : null;
  const overallNotSupported =
    allFaithRates.length > 0
      ? allFaithRates.reduce((a, s) => a + s.notSupportedRate!, 0) / allFaithRates.length
      : null;

  // Cap-saturated and infra counts.
  const capSaturatedCount = filtered.filter(
    (s) => s.excluded === 'cap_saturated',
  ).length;
  const incompleteCaptureCount = filtered.filter(
    (s) => s.excluded === 'infra',
  ).length;

  return {
    micro: {
      tp: totalTp,
      fp: totalFp,
      fn: totalFn,
      precision: microPrecision,
      recall: microRecall,
      f1: microF1,
    },
    macro: {
      f1: macroF1,
      fixtureCount: f1Values.length,
    },
    faithfulness: {
      meanScore: meanFaithfulness,
      supportedRate: overallSupported,
      unclearRate: overallUnclear,
      notSupportedRate: overallNotSupported,
    },
    capSaturatedCount,
    incompleteCaptureCount,
  };
}

// ── Clean A/B reporting ────────────────────────────────────────────

export interface CleanABDelta {
  fixtureId: string;
  fullCorpusFindingCount: number;
  top10FindingCount: number;
  delta: number;
}

/**
 * Compare finding counts between full-corpus and top-10 recordings for
 * a clean fixture. Returns null if one of the recordings is missing.
 */
export function computeCleanABDelta(
  fullCorpusRecording: EmittedRecording | null,
  top10Recording: EmittedRecording | null,
  fixtureId: string,
): CleanABDelta | null {
  if (!fullCorpusRecording || !top10Recording) return null;

  return {
    fixtureId,
    fullCorpusFindingCount: fullCorpusRecording.findings.length,
    top10FindingCount: top10Recording.findings.length,
    delta: fullCorpusRecording.findings.length - top10Recording.findings.length,
  };
}

// ── Threshold assertion ────────────────────────────────────────────

export interface Thresholds {
  microF1?: number;
  macroF1?: number;
  precision?: number;
  recall?: number;
  faithfulness?: number;
  capSaturatedMax?: number;
}

export interface ThresholdResult {
  metric: string;
  threshold: number;
  actual: number | null;
  passed: boolean;
}

/**
 * Assert metric values against configured thresholds.
 *
 * - Unset threshold => report-only (always passes).
 * - Set threshold + actual null => fails (metric could not be computed).
 */
export function assertThresholds(
  aggregate: AggregateMetrics,
  thresholds: Thresholds,
): ThresholdResult[] {
  const results: ThresholdResult[] = [];

  if (thresholds.microF1 !== undefined) {
    results.push({
      metric: 'micro-F1',
      threshold: thresholds.microF1,
      actual: aggregate.micro.f1,
      passed: aggregate.micro.f1 !== null && aggregate.micro.f1 >= thresholds.microF1,
    });
  }

  if (thresholds.macroF1 !== undefined) {
    results.push({
      metric: 'macro-F1',
      threshold: thresholds.macroF1,
      actual: aggregate.macro.f1,
      passed: aggregate.macro.f1 !== null && aggregate.macro.f1 >= thresholds.macroF1,
    });
  }

  if (thresholds.precision !== undefined) {
    results.push({
      metric: 'precision',
      threshold: thresholds.precision,
      actual: aggregate.micro.precision,
      passed:
        aggregate.micro.precision !== null &&
        aggregate.micro.precision >= thresholds.precision,
    });
  }

  if (thresholds.recall !== undefined) {
    results.push({
      metric: 'recall',
      threshold: thresholds.recall,
      actual: aggregate.micro.recall,
      passed:
        aggregate.micro.recall !== null && aggregate.micro.recall >= thresholds.recall,
    });
  }

  if (thresholds.faithfulness !== undefined) {
    results.push({
      metric: 'faithfulness',
      threshold: thresholds.faithfulness,
      actual: aggregate.faithfulness.meanScore,
      passed:
        aggregate.faithfulness.meanScore !== null &&
        aggregate.faithfulness.meanScore >= thresholds.faithfulness,
    });
  }

  if (thresholds.capSaturatedMax !== undefined) {
    results.push({
      metric: 'cap-saturated-count',
      threshold: thresholds.capSaturatedMax,
      actual: aggregate.capSaturatedCount,
      passed: aggregate.capSaturatedCount <= thresholds.capSaturatedMax,
    });
  }

  return results;
}

/**
 * Returns true if all threshold assertions passed (or no thresholds set).
 */
export function allThresholdsPassed(results: ThresholdResult[]): boolean {
  return results.every((r) => r.passed);
}
