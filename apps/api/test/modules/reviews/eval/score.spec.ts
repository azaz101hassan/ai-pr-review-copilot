import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeRecording } from '@/modules/reviews/eval/recording';
import type {
  EmittedRecording,
  ThrewRecording,
  RecordingProvenance,
} from '@/modules/reviews/eval/recording';
import { computeExpectedSetHash } from '@/modules/reviews/eval/manifest';
import {
  strictJoin,
  ScoreJoinError,
  runScore,
  formatMarkdownSummary,
} from '@/modules/reviews/eval/score';

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
    expectedSetHash: 'will-be-set',
    // Use the latest tracked-paths SHA so recordings appear fresh.
    gitSha: getLatestTrackedSha(),
    ...overrides,
  };
}

function makeEmitted(
  fixtureId: string,
  expected: string[],
  emittedRuleIds: string[],
  overrides: Partial<EmittedRecording> = {},
): EmittedRecording {
  return {
    status: 'emitted',
    fixtureId,
    findings: emittedRuleIds.map((rule_id) => ({
      rule_id,
      title: `Title for ${rule_id}`,
      message: `Message for ${rule_id}`,
      faithfulness: {
        score: 1.0,
        claims: [
          {
            claim: `claim about ${rule_id}`,
            kind: 'diff_assertion',
            reason: 'visible',
            verdict: 'supported' as const,
          },
        ],
      },
    })),
    ruleSet: emittedRuleIds,
    provenance: makeProvenance({
      expectedSetHash: computeExpectedSetHash(expected),
    }),
    ...overrides,
  };
}

function makeThrew(
  fixtureId: string,
  expected: string[],
  errorCode: string,
): ThrewRecording {
  return {
    status: 'threw',
    fixtureId,
    error: {
      errorCode,
      turnCount: null,
      toolCalls: null,
    },
    provenance: makeProvenance({
      expectedSetHash: computeExpectedSetHash(expected),
    }),
  };
}

interface ManifestEntryJson {
  fixtureId: string;
  path: string;
  category: string;
  expected: string[];
  needsRepoContext: boolean;
  gates?: boolean;
  injectedRules?: string[];
}

function setupEvalDir(
  manifestEntries: ManifestEntryJson[],
  recordings: Array<EmittedRecording | ThrewRecording>,
  thresholds: Record<string, number> = {},
): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-score-'));

  // Write manifest.
  fs.writeFileSync(
    path.join(tmpDir, 'expectations.manifest.json'),
    JSON.stringify(manifestEntries, null, 2),
    'utf-8',
  );

  // Write recordings.
  for (const r of recordings) {
    writeRecording(tmpDir, r);
  }

  // Write thresholds.
  fs.writeFileSync(
    path.join(tmpDir, 'thresholds.json'),
    JSON.stringify(thresholds),
    'utf-8',
  );

  return tmpDir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Get the repo root for staleness checks.
// test/modules/reviews/eval/ => apps/api/test/modules/reviews/eval/
// 6 levels up: eval -> reviews -> modules -> test -> api -> apps -> repo-root
function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
}

/**
 * Get the latest commit SHA that touched the staleness-tracked paths.
 * Recordings must carry this SHA to appear fresh to the staleness check.
 */
function getLatestTrackedSha(): string {
  try {
    return require('child_process')
      .execSync(
        'git log -1 --format=%H -- ' +
          '"apps/api/src/infrastructure/anthropic/" ' +
          '"apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts" ' +
          '"apps/api/seeds/"',
        { cwd: getRepoRoot(), encoding: 'utf-8' },
      )
      .trim();
  } catch {
    return 'deadbeef';
  }
}

// ── strictJoin tests ───────────────────────────────────────────────

describe('strictJoin', () => {
  it('missing recording => hard-fail', () => {
    const entries = [
      {
        fixtureId: 'missing-rec',
        path: 'test.patch',
        category: 'violating' as const,
        expected: ['rule-a'],
        needsRepoContext: false,
        expectedSetHash: computeExpectedSetHash(['rule-a']),
        gates: true,
      },
    ];

    expect(() => strictJoin(entries, [])).toThrow(ScoreJoinError);
    expect(() => strictJoin(entries, [])).toThrow(/Missing recording/);
    expect(() => strictJoin(entries, [])).toThrow(/missing-rec/);
  });

  it('orphan recording => hard-fail', () => {
    const entries = [
      {
        fixtureId: 'valid',
        path: 'test.patch',
        category: 'violating' as const,
        expected: ['rule-a'],
        needsRepoContext: false,
        expectedSetHash: computeExpectedSetHash(['rule-a']),
        gates: true,
      },
    ];
    const recordings = [
      makeEmitted('valid', ['rule-a'], ['rule-a']),
      makeEmitted('orphan', [], []),
    ];

    expect(() => strictJoin(entries, recordings)).toThrow(ScoreJoinError);
    expect(() => strictJoin(entries, recordings)).toThrow(/Orphan recording/);
    expect(() => strictJoin(entries, recordings)).toThrow(/orphan/);
  });

  it('expectedSetHash mismatch => hard-fail', () => {
    const entries = [
      {
        fixtureId: 'hash-mismatch',
        path: 'test.patch',
        category: 'violating' as const,
        expected: ['rule-a'],
        needsRepoContext: false,
        expectedSetHash: computeExpectedSetHash(['rule-a']),
        gates: true,
      },
    ];
    const recordings = [
      makeEmitted('hash-mismatch', ['rule-a', 'rule-b'], ['rule-a']),
    ];

    expect(() => strictJoin(entries, recordings)).toThrow(ScoreJoinError);
    expect(() => strictJoin(entries, recordings)).toThrow(/expectedSetHash mismatch/);
  });

  it('valid join succeeds', () => {
    const expected = ['rule-a'];
    const entries = [
      {
        fixtureId: 'valid',
        path: 'test.patch',
        category: 'violating' as const,
        expected,
        needsRepoContext: false,
        expectedSetHash: computeExpectedSetHash(expected),
        gates: true,
      },
    ];
    const recordings = [makeEmitted('valid', expected, ['rule-a'])];

    const joined = strictJoin(entries, recordings);
    expect(joined).toHaveLength(1);
    expect(joined[0].entry.fixtureId).toBe('valid');
  });
});

// ── runScore integration tests ─────────────────────────────────────

describe('runScore', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  it('thresholds unset => report-only, allPassed = true', () => {
    const expected = ['rule-a'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'f1',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      [makeEmitted('f1', expected, ['rule-a'])],
      {}, // empty thresholds
    );

    const result = runScore(tmpDir, getRepoRoot());

    expect(result.thresholdsActive).toBe(false);
    expect(result.allPassed).toBe(true);
    expect(result.thresholdResults).toHaveLength(0);
  });

  it('F1 below threshold => allPassed = false', () => {
    const expected = ['rule-a', 'rule-b', 'rule-c'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'f1',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      // Only emits 1 of 3 expected.
      [makeEmitted('f1', expected, ['rule-a'])],
      { microF1: 0.9 },
    );

    const result = runScore(tmpDir, getRepoRoot());

    expect(result.thresholdsActive).toBe(true);
    expect(result.allPassed).toBe(false);
    expect(result.thresholdResults).toHaveLength(1);
    expect(result.thresholdResults[0].passed).toBe(false);
  });

  it('F1 above threshold => allPassed = true', () => {
    const expected = ['rule-a'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'f1',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      [makeEmitted('f1', expected, ['rule-a'])],
      { microF1: 0.5 },
    );

    const result = runScore(tmpDir, getRepoRoot());

    expect(result.thresholdsActive).toBe(true);
    expect(result.allPassed).toBe(true);
  });

  it('non-gating fixtures appear in scores but do not affect gate', () => {
    const gatingExpected = ['rule-a'];
    const nonGatingExpected = ['rule-b'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'gating',
          path: 'test1.patch',
          category: 'violating',
          expected: gatingExpected,
          needsRepoContext: false,
        },
        {
          fixtureId: 'held-out',
          path: 'test2.patch',
          category: 'violating',
          expected: nonGatingExpected,
          needsRepoContext: false,
          gates: false,
        },
      ],
      [
        makeEmitted('gating', gatingExpected, ['rule-a']),
        makeEmitted('held-out', nonGatingExpected, []), // bad, but non-gating
      ],
      { microF1: 0.5 },
    );

    const result = runScore(tmpDir, getRepoRoot());

    // Gate passes (gating fixture is perfect).
    expect(result.allPassed).toBe(true);
    // Non-gating aggregate exists.
    expect(result.nonGatingAggregate).not.toBeNull();
    // Fixture scores include both.
    expect(result.fixtureScores).toHaveLength(2);
  });

  it('staleness warning in report-only mode does not fail', () => {
    const expected = ['rule-a'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'f1',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      [
        makeEmitted('f1', expected, ['rule-a'], {
          provenance: makeProvenance({
            expectedSetHash: computeExpectedSetHash(expected),
            // Use a clearly stale sha that won't match any real commit.
            gitSha: '0000000000000000000000000000000000000000',
          }),
        }),
      ],
      {}, // no thresholds => report-only
    );

    const result = runScore(tmpDir, getRepoRoot());

    // Report-only: staleness is a warning, not a failure.
    expect(result.allPassed).toBe(true);
    // But hasStale should be true.
    expect(result.hasStale).toBe(true);
  });

  it('staleness hard-fails once thresholds are set', () => {
    const expected = ['rule-a'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'f1',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      [
        makeEmitted('f1', expected, ['rule-a'], {
          provenance: makeProvenance({
            expectedSetHash: computeExpectedSetHash(expected),
            gitSha: '0000000000000000000000000000000000000000',
          }),
        }),
      ],
      { microF1: 0.5 }, // thresholds set
    );

    const result = runScore(tmpDir, getRepoRoot());

    // Thresholds are set and recordings are stale => hard-fail.
    expect(result.thresholdsActive).toBe(true);
    expect(result.hasStale).toBe(true);
    expect(result.allPassed).toBe(false);
  });

  it('missing recording in report-only mode => graceful exit (no recordings)', () => {
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'missing',
          path: 'test.patch',
          category: 'violating',
          expected: ['rule-a'],
          needsRepoContext: false,
        },
      ],
      [], // no recordings
      {}, // no thresholds => report-only
    );

    // With no thresholds and no recordings, runScore returns
    // a report-only result (not a hard-fail).
    const result = runScore(tmpDir, getRepoRoot());
    expect(result.allPassed).toBe(true);
    expect(result.fixtureScores).toHaveLength(0);
  });

  it('missing recording with thresholds set => throws ScoreJoinError', () => {
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'missing',
          path: 'test.patch',
          category: 'violating',
          expected: ['rule-a'],
          needsRepoContext: false,
        },
      ],
      [], // no recordings
      { microF1: 0.5 }, // thresholds set => strict mode
    );

    expect(() => runScore(tmpDir, getRepoRoot())).toThrow(ScoreJoinError);
  });

  it('generates a markdown summary', () => {
    const expected = ['rule-a'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'f1',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      [makeEmitted('f1', expected, ['rule-a'])],
    );

    const result = runScore(tmpDir, getRepoRoot());
    const markdown = formatMarkdownSummary(result);

    expect(markdown).toContain('# Eval Score Summary');
    expect(markdown).toContain('Precision');
    expect(markdown).toContain('Recall');
    expect(markdown).toContain('F1');
    expect(markdown).toContain('f1');
  });

  it('runs with no env vars set (keyless guarantee)', () => {
    // This test verifies the score step's keyless invariant:
    // it reads only JSON files and git log, no API keys needed.
    // The mere fact that runScore completes without env vars proves this.
    const expected = ['rule-a'];
    tmpDir = setupEvalDir(
      [
        {
          fixtureId: 'keyless',
          path: 'test.patch',
          category: 'violating',
          expected,
          needsRepoContext: false,
        },
      ],
      [makeEmitted('keyless', expected, ['rule-a'])],
    );

    // Ensure no API keys are set for this call.
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const savedVoyageKey = process.env.VOYAGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VOYAGE_API_KEY;

    try {
      const result = runScore(tmpDir, getRepoRoot());
      expect(result).toBeDefined();
      expect(result.fixtureScores).toHaveLength(1);
    } finally {
      // Restore.
      if (savedAnthropicKey) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedVoyageKey) process.env.VOYAGE_API_KEY = savedVoyageKey;
    }
  });
});
