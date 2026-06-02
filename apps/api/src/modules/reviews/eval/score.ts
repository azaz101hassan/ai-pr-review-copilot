/**
 * Offline eval score entry point.
 *
 * Reads committed recordings + manifest, computes metrics, gates on
 * thresholds, and runs in CI with no API keys.
 *
 * NO AppModule, NO ConfigService, NO dotenv — completely keyless.
 *
 * Usage:
 *   ts-node -r tsconfig-paths/register src/modules/reviews/eval/score.ts
 *
 * Exit codes:
 *   0 — all gated metrics pass (or thresholds unset / report-only)
 *   1 — a gated metric failed, or a structural error (missing recording, etc.)
 */

import * as fs from 'fs';
import * as path from 'path';

import { loadManifest } from '@/modules/reviews/eval/manifest';
import type { LoadedManifestEntry } from '@/modules/reviews/eval/manifest';
import { readAllRecordings } from '@/modules/reviews/eval/recording';
import type { Recording } from '@/modules/reviews/eval/recording';
import {
  scoreFixture,
  aggregateMetrics,
  assertThresholds,
  allThresholdsPassed,
  computeCleanABDelta,
} from '@/modules/reviews/eval/metrics';
import type {
  FixtureScore,
  AggregateMetrics,
  Thresholds,
  ThresholdResult,
  CleanABDelta,
} from '@/modules/reviews/eval/metrics';
import type { EmittedRecording } from '@/modules/reviews/eval/recording';
import { isEmittedRecording } from '@/modules/reviews/eval/recording';
import {
  checkAllStaleness,
  hasStaleRecordings,
} from '@/modules/reviews/eval/staleness';
import type { StalenessResult } from '@/modules/reviews/eval/staleness';

// ── Paths ──────────────────────────────────────────────────────────

/** Resolve the eval fixtures base directory relative to this file. */
export function resolveEvalDir(): string {
  // score.ts lives at apps/api/src/modules/reviews/eval/score.ts
  // fixtures at apps/api/test/fixtures/eval/
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'eval');
}

/** Resolve the git repo root relative to this file. */
export function resolveRepoRoot(): string {
  // apps/api/src/modules/reviews/eval/ => repo root is 6 levels up.
  return path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
}

// ── Strict join ────────────────────────────────────────────────────

export class ScoreJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreJoinError';
  }
}

export interface JoinedFixture {
  entry: LoadedManifestEntry;
  recording: Recording;
}

/**
 * Strict join manifest entries against recordings.
 *
 * - Missing recording for a manifest entry => hard-fail.
 * - Orphan recording (no manifest entry) => hard-fail.
 * - expectedSetHash mismatch => hard-fail.
 */
export function strictJoin(
  entries: LoadedManifestEntry[],
  recordings: Recording[],
): JoinedFixture[] {
  const recordingMap = new Map<string, Recording>();
  for (const r of recordings) {
    recordingMap.set(r.fixtureId, r);
  }

  const manifestIds = new Set(entries.map((e) => e.fixtureId));

  // Check for orphan recordings.
  for (const r of recordings) {
    if (!manifestIds.has(r.fixtureId)) {
      throw new ScoreJoinError(
        `Orphan recording: fixture "${r.fixtureId}" has a recording but no manifest entry. ` +
          `Remove the recording or add a manifest entry.`,
      );
    }
  }

  const joined: JoinedFixture[] = [];

  for (const entry of entries) {
    const recording = recordingMap.get(entry.fixtureId);

    // Missing recording.
    if (!recording) {
      if (!entry.gates) {
        console.warn(
          `[score] skipping non-gating fixture "${entry.fixtureId}" — no recording found`,
        );
        continue;
      }
      throw new ScoreJoinError(
        `Missing recording: fixture "${entry.fixtureId}" has a manifest entry but no recording. ` +
          `Run eval:capture to generate recordings.`,
      );
    }

    // Hash mismatch.
    if (recording.provenance.expectedSetHash !== entry.expectedSetHash) {
      throw new ScoreJoinError(
        `expectedSetHash mismatch for fixture "${entry.fixtureId}": ` +
          `manifest hash=${entry.expectedSetHash.slice(0, 12)}..., ` +
          `recording hash=${recording.provenance.expectedSetHash.slice(0, 12)}... ` +
          `The manifest was edited after the recording was captured. Re-run eval:capture.`,
      );
    }

    joined.push({ entry, recording });
  }

  return joined;
}

// ── Score result ───────────────────────────────────────────────────

export interface ScoreResult {
  fixtureScores: FixtureScore[];
  gatingAggregate: AggregateMetrics;
  nonGatingAggregate: AggregateMetrics | null;
  thresholdResults: ThresholdResult[];
  stalenessResults: StalenessResult[];
  cleanABDeltas: CleanABDelta[];
  allPassed: boolean;
  /** Whether any recordings are stale. */
  hasStale: boolean;
  /** Whether thresholds are set (non-empty). */
  thresholdsActive: boolean;
}

// ── Markdown formatting ────────────────────────────────────────────

function fmt(value: number | null, decimals = 4): string {
  if (value === null) return 'N/A';
  return value.toFixed(decimals);
}

function pct(value: number | null): string {
  if (value === null) return 'N/A';
  return (value * 100).toFixed(1) + '%';
}

export function formatMarkdownSummary(result: ScoreResult): string {
  const lines: string[] = [];

  lines.push('# Eval Score Summary');
  lines.push('');

  // ── Gate status ──────────────────────────────────────────────
  if (!result.thresholdsActive) {
    lines.push('> **Mode: report-only** (no thresholds set in thresholds.json)');
  } else if (result.allPassed) {
    lines.push('> **Gate: PASSED** - all thresholds met');
  } else {
    lines.push('> **Gate: FAILED** - one or more thresholds not met');
  }
  lines.push('');

  // ── No recordings yet ────────────────────────────────────────
  if (result.fixtureScores.length === 0) {
    lines.push('_No recordings found. Run `eval:capture` to generate recordings._');
    lines.push('');
    return lines.join('\n');
  }

  // ── Staleness ────────────────────────────────────────────────
  if (result.hasStale) {
    lines.push('## Staleness Warning');
    lines.push('');
    lines.push(
      'The following recordings are stale (tracked paths changed since capture):',
    );
    lines.push('');
    for (const s of result.stalenessResults.filter((s) => s.stale)) {
      lines.push(
        `- **${s.fixtureId}**: recording sha \`${s.recordingGitSha.slice(0, 8)}\` vs latest \`${s.latestTrackedSha.slice(0, 8)}\` (reason: ${s.reason})`,
      );
    }
    lines.push('');
    if (result.thresholdsActive) {
      lines.push(
        '**Staleness is a hard failure when thresholds are set.** Re-run `eval:capture`.',
      );
    } else {
      lines.push(
        '_Staleness is a warning in report-only mode. Re-run `eval:capture` before setting thresholds._',
      );
    }
    lines.push('');
  }

  // ── Micro aggregate ──────────────────────────────────────────
  const g = result.gatingAggregate;
  lines.push('## Gating Metrics (micro-aggregated)');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Precision | ${pct(g.micro.precision)} |`);
  lines.push(`| Recall | ${pct(g.micro.recall)} |`);
  lines.push(`| **F1** | **${pct(g.micro.f1)}** |`);
  lines.push(`| TP / FP / FN | ${g.micro.tp} / ${g.micro.fp} / ${g.micro.fn} |`);
  lines.push('');

  // ── Macro ────────────────────────────────────────────────────
  lines.push(`| Macro F1 | ${pct(g.macro.f1)} (over ${g.macro.fixtureCount} fixtures) |`);
  lines.push('');

  // ── Faithfulness ─────────────────────────────────────────────
  lines.push('## Faithfulness');
  lines.push('');
  lines.push(`| Rate | Value |`);
  lines.push(`|------|-------|`);
  lines.push(`| Supported | ${pct(g.faithfulness.supportedRate)} |`);
  lines.push(`| Unclear | ${pct(g.faithfulness.unclearRate)} |`);
  lines.push(`| Not Supported | ${pct(g.faithfulness.notSupportedRate)} |`);
  lines.push(`| **Mean Score** | **${fmt(g.faithfulness.meanScore)}** |`);
  lines.push('');

  // ── Cap-saturated / infra ────────────────────────────────────
  if (g.capSaturatedCount > 0 || g.incompleteCaptureCount > 0) {
    lines.push('## Exclusions');
    lines.push('');
    if (g.capSaturatedCount > 0) {
      lines.push(
        `- Cap-saturated (turn_cap_exceeded): ${g.capSaturatedCount} fixture(s) - excluded from F1`,
      );
    }
    if (g.incompleteCaptureCount > 0) {
      lines.push(
        `- Infra failures: ${g.incompleteCaptureCount} fixture(s) - excluded from F1`,
      );
    }
    lines.push('');
  }

  // ── Per-fixture breakdown ────────────────────────────────────
  lines.push('## Per-Fixture Breakdown');
  lines.push('');
  lines.push(
    '| Fixture | Category | TP | FP | FN | P | R | F1 | Faith. |',
  );
  lines.push(
    '|---------|----------|----|----|----|----|----|----|--------|',
  );
  for (const s of result.fixtureScores) {
    const label = s.gates ? s.fixtureId : `${s.fixtureId} (non-gating)`;
    const ex = s.excluded ? ` [${s.excluded}]` : '';
    lines.push(
      `| ${label}${ex} | ${s.category} | ${s.tp} | ${s.fp} | ${s.fn} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} | ${fmt(s.faithfulnessScore)} |`,
    );
  }
  lines.push('');

  // ── Threshold results ────────────────────────────────────────
  if (result.thresholdResults.length > 0) {
    lines.push('## Threshold Assertions');
    lines.push('');
    lines.push('| Metric | Threshold | Actual | Status |');
    lines.push('|--------|-----------|--------|--------|');
    for (const t of result.thresholdResults) {
      const status = t.passed ? 'PASS' : '**FAIL**';
      lines.push(
        `| ${t.metric} | ${fmt(t.threshold)} | ${fmt(t.actual)} | ${status} |`,
      );
    }
    lines.push('');
  }

  // ── Clean A/B delta ──────────────────────────────────────────
  if (result.cleanABDeltas.length > 0) {
    lines.push('## Clean Fixture A/B (full-corpus vs top-10 retrieval)');
    lines.push('');
    lines.push('| Fixture | Full-Corpus Findings | Top-10 Findings | Delta |');
    lines.push('|---------|---------------------|-----------------|-------|');
    for (const d of result.cleanABDeltas) {
      lines.push(
        `| ${d.fixtureId} | ${d.fullCorpusFindingCount} | ${d.top10FindingCount} | ${d.delta > 0 ? '+' : ''}${d.delta} |`,
      );
    }
    lines.push('');
  }

  // ── Non-gating (held-out) ────────────────────────────────────
  if (result.nonGatingAggregate) {
    const ng = result.nonGatingAggregate;
    lines.push('## External-Validity Sample (non-gating)');
    lines.push('');
    lines.push(
      '_These fixtures are report-only and do not affect the gate._',
    );
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Precision | ${pct(ng.micro.precision)} |`);
    lines.push(`| Recall | ${pct(ng.micro.recall)} |`);
    lines.push(`| F1 | ${pct(ng.micro.f1)} |`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main score pipeline ────────────────────────────────────────────

export function runScore(
  evalDir: string,
  repoRoot: string,
): ScoreResult {
  // 1. Load thresholds early — needed to decide strictness.
  const thresholdsPath = path.join(evalDir, 'thresholds.json');
  let thresholds: Thresholds = {};
  if (fs.existsSync(thresholdsPath)) {
    const raw = fs.readFileSync(thresholdsPath, 'utf-8');
    thresholds = JSON.parse(raw) as Thresholds;
  }
  const thresholdsActive = Object.keys(thresholds).length > 0;

  // 2. Load manifest.
  const manifestPath = path.join(evalDir, 'expectations.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new ScoreJoinError(
      `Manifest not found at ${manifestPath}. Expected at test/fixtures/eval/expectations.manifest.json`,
    );
  }
  const manifest = loadManifest(manifestPath);

  // 3. Load recordings.
  const recordings = readAllRecordings(evalDir);

  // 3b. Separate A/B sidecar recordings (clean __top10) from primary recordings.
  const AB_SUFFIX = '__top10';
  const abRecordings = recordings.filter((r) => r.fixtureId.endsWith(AB_SUFFIX));
  const primaryRecordings = recordings.filter((r) => !r.fixtureId.endsWith(AB_SUFFIX));

  // 4. Handle the pre-capture state: no recordings exist yet.
  //    When thresholds are unset (report-only mode), this is not
  //    an error — the step exits 0 so CI is never blocked before
  //    baseline recordings are committed. With thresholds active,
  //    missing recordings is always a hard failure.
  if (primaryRecordings.length === 0 && !thresholdsActive) {
    const empty = aggregateMetrics([], true);
    return {
      fixtureScores: [],
      gatingAggregate: empty,
      nonGatingAggregate: null,
      thresholdResults: [],
      stalenessResults: [],
      cleanABDeltas: [],
      allPassed: true,
      hasStale: false,
      thresholdsActive: false,
    };
  }

  // 5. Strict join (primary recordings only; A/B sidecars excluded).
  const joined = strictJoin(manifest.entries, primaryRecordings);

  // 6. Score each fixture.
  const fixtureScores = joined.map(({ entry, recording }) =>
    scoreFixture(entry, recording),
  );

  // 7. Aggregate gating metrics.
  const gatingAggregate = aggregateMetrics(fixtureScores, true);

  // 8. Aggregate non-gating metrics (if any).
  const nonGatingFixtures = fixtureScores.filter((s) => !s.gates);
  const nonGatingAggregate =
    nonGatingFixtures.length > 0
      ? aggregateMetrics(nonGatingFixtures, false)
      : null;

  // 9. Assert thresholds.
  const thresholdResults = assertThresholds(gatingAggregate, thresholds);
  const gatesPassed = allThresholdsPassed(thresholdResults);

  // 10. Check staleness (primary recordings only).
  const stalenessResults = checkAllStaleness(
    primaryRecordings,
    repoRoot,
  );
  const hasStale = hasStaleRecordings(stalenessResults);

  // 11. Clean A/B deltas.
  const abMap = new Map<string, Recording>();
  for (const r of abRecordings) abMap.set(r.fixtureId, r);
  const cleanABDeltas: CleanABDelta[] = [];
  for (const { entry, recording } of joined) {
    if (entry.category !== 'clean') continue;
    const abId = `${entry.fixtureId}${AB_SUFFIX}`;
    const abRec = abMap.get(abId);
    const fullCorpus = isEmittedRecording(recording) ? recording as EmittedRecording : null;
    const top10 = abRec && isEmittedRecording(abRec) ? abRec as EmittedRecording : null;
    const delta = computeCleanABDelta(fullCorpus, top10, entry.fixtureId);
    if (delta) cleanABDeltas.push(delta);
  }

  // 12. Determine overall pass/fail.
  // Stale recordings are a hard failure when thresholds are set.
  const allPassed = gatesPassed && !(thresholdsActive && hasStale);

  return {
    fixtureScores,
    gatingAggregate,
    nonGatingAggregate,
    thresholdResults,
    stalenessResults,
    cleanABDeltas,
    allPassed,
    hasStale,
    thresholdsActive,
  };
}

// ── CLI entry point ────────────────────────────────────────────────

function main(): void {
  const evalDir = resolveEvalDir();
  const repoRoot = resolveRepoRoot();

  try {
    const result = runScore(evalDir, repoRoot);

    // Write JSON result.
    const resultPath = path.join(evalDir, 'results.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify(result, null, 2) + '\n',
      'utf-8',
    );

    // Print markdown summary to stdout.
    const markdown = formatMarkdownSummary(result);
    console.log(markdown);

    // Exit code.
    if (!result.allPassed) {
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof ScoreJoinError) {
      console.error(`SCORE ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) {
  main();
}
