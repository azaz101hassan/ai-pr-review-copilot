import {
  checkStaleness,
  checkAllStaleness,
  hasStaleRecordings,
  getLatestTrackedCommit,
  computeTrackedPathsHash,
} from '@/modules/reviews/eval/staleness';
import type { StalenessResult } from '@/modules/reviews/eval/staleness';
import type { Recording, RecordingProvenance } from '@/modules/reviews/eval/recording';
import { execSync } from 'child_process';

// ── Helpers ────────────────────────────────────────────────────────

const repoRoot = execSync('git rev-parse --show-toplevel', {
  encoding: 'utf-8',
}).trim();

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

function makeRecording(gitSha: string, fixtureId = 'test-fixture'): Recording {
  return {
    status: 'emitted',
    fixtureId,
    findings: [],
    ruleSet: [],
    provenance: makeProvenance({ gitSha }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('checkStaleness', () => {
  it('fresh recording (gitSha matches latest tracked commit) => not stale', () => {
    const latestSha = 'abc123def456';
    const recording = makeRecording(latestSha);

    const result = checkStaleness(recording, latestSha, repoRoot);

    expect(result.stale).toBe(false);
    expect(result.recordingGitSha).toBe(latestSha);
    expect(result.latestTrackedSha).toBe(latestSha);
  });

  it('recording captured after tracked-path change => not stale (ancestor check)', () => {
    const commits = execSync('git log --oneline -3 --format=%H', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim().split('\n');

    if (commits.length < 2) return;

    const olderCommit = commits[1];
    const newerCommit = commits[0];
    const recording = makeRecording(newerCommit);

    const result = checkStaleness(recording, olderCommit, repoRoot);

    expect(result.stale).toBe(false);
  });

  it('tracked-path change after recording capture => stale', () => {
    // Use two consecutive commits that both touched apps/api/src/ so the
    // content-equality fallback in checkStaleness sees a real diff. Without
    // this scoping, recent doc-only or web-only commits would produce an
    // empty diff against the default STALENESS_TRACKED_PATHS and the
    // recording would (correctly, per the new semantic) be flagged fresh.
    const probePath = 'apps/api/src/';
    const commits = execSync(
      `git log -2 --format=%H -- ${probePath}`,
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim().split('\n');

    if (commits.length < 2) return;

    const olderCommit = commits[1];
    const newerCommit = commits[0];
    const recording = makeRecording(olderCommit);

    const result = checkStaleness(recording, newerCommit, repoRoot, [probePath]);

    expect(result.stale).toBe(true);
  });

  it('content-equal across squash-merge or merge commit => not stale', () => {
    // Regression: when the recording was captured on a side-branch that
    // got squash-merged, the recording's gitSha is NOT an ancestor of the
    // post-merge latest-tracked SHA, but the tracked-path tree content is
    // identical. The content-equality fallback must rescue this case.
    //
    // Pick a tracked path that has had NO commits between two real,
    // reachable SHAs. The simplest construction: probe with a path that
    // doesn't exist in the repo, so the diff is trivially empty.
    const commits = execSync('git log --oneline -2 --format=%H', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim().split('\n');

    if (commits.length < 2) return;

    const recording = makeRecording(commits[1]);
    const result = checkStaleness(recording, commits[0], repoRoot, [
      'definitely/does/not/exist/anywhere/',
    ]);

    expect(result.stale).toBe(false);
  });

  it('empty latestTrackedSha (no git or no commits on tracked paths) => not stale', () => {
    const recording = makeRecording('any-sha');

    const result = checkStaleness(recording, '', repoRoot);

    expect(result.stale).toBe(false);
  });
});

describe('hasStaleRecordings', () => {
  it('returns false when all are fresh', () => {
    const results: StalenessResult[] = [
      { fixtureId: 'a', recordingGitSha: 'sha1', latestTrackedSha: 'sha1', stale: false, reason: 'sha-equal' },
      { fixtureId: 'b', recordingGitSha: 'sha1', latestTrackedSha: 'sha1', stale: false, reason: 'sha-equal' },
    ];

    expect(hasStaleRecordings(results)).toBe(false);
  });

  it('returns true when any is stale', () => {
    const results: StalenessResult[] = [
      { fixtureId: 'a', recordingGitSha: 'sha1', latestTrackedSha: 'sha1', stale: false, reason: 'sha-equal' },
      { fixtureId: 'b', recordingGitSha: 'old', latestTrackedSha: 'new', stale: true, reason: 'sha-content-differs' },
    ];

    expect(hasStaleRecordings(results)).toBe(true);
  });
});

describe('getLatestTrackedCommit', () => {
  it('returns a 40-char hex sha from the real repo', () => {
    const sha = getLatestTrackedCommit(repoRoot, [
      'apps/api/src/modules/reviews/types/',
    ]);

    if (sha !== '') {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('returns empty string for a non-existent path', () => {
    const sha = getLatestTrackedCommit(repoRoot, [
      'definitely/does/not/exist/anywhere/',
    ]);

    expect(sha).toBe('');
  });
});

describe('computeTrackedPathsHash', () => {
  it('returns a stable sha-256 hex string for a real tracked path', () => {
    const hash = computeTrackedPathsHash(repoRoot, 'HEAD', [
      'apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts',
    ]);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent on the same ref + paths.
    const second = computeTrackedPathsHash(repoRoot, 'HEAD', [
      'apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts',
    ]);
    expect(second).toBe(hash);
  });

  it('returns empty string when the ref is unreachable', () => {
    const hash = computeTrackedPathsHash(
      repoRoot,
      '0000000000000000000000000000000000000000',
      ['apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts'],
    );

    expect(hash).toBe('');
  });

  it('returns empty string when tracked paths produce no tree entries', () => {
    const hash = computeTrackedPathsHash(repoRoot, 'HEAD', [
      'definitely/does/not/exist/anywhere/',
    ]);

    expect(hash).toBe('');
  });

  it('returns empty string when ref is empty', () => {
    const hash = computeTrackedPathsHash(repoRoot, '', [
      'apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts',
    ]);

    expect(hash).toBe('');
  });
});

describe('checkStaleness — trackedPathsHash path', () => {
  it('hash equality => fresh, reason=hash-equal', () => {
    const recording = makeRecording('orphan-sha-that-does-not-exist', 'fix-a');
    recording.provenance.trackedPathsHash = 'abc123';

    const result = checkStaleness(
      recording,
      'unrelated-latest-sha',
      repoRoot,
      ['definitely/does/not/exist/'],
      'abc123',
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toBe('hash-equal');
  });

  it('hash differs => stale, reason=hash-differs', () => {
    const recording = makeRecording('any-sha', 'fix-b');
    recording.provenance.trackedPathsHash = 'old-hash';

    const result = checkStaleness(
      recording,
      'unrelated-latest-sha',
      repoRoot,
      ['definitely/does/not/exist/'],
      'new-hash',
    );

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('hash-differs');
  });

  it('hash present on recording but currentHash empty => falls back to gitSha logic', () => {
    // gitSha equality fresh-path still works when current hash is unavailable.
    const sha = 'abc123def456';
    const recording = makeRecording(sha, 'fix-c');
    recording.provenance.trackedPathsHash = 'unused-because-current-is-empty';

    const result = checkStaleness(
      recording,
      sha,
      repoRoot,
      ['definitely/does/not/exist/'],
      '',
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toBe('sha-equal');
  });

  it('recording lacks hash, SHA orphan => stale, reason=sha-unreachable', () => {
    // Simulate the pre-fix CI failure: orphan SHA, no hash to rescue.
    // Use a syntactically valid but unreachable SHA so isAncestor and
    // git diff both throw.
    const orphan = '0000000000000000000000000000000000000000';
    const recording = makeRecording(orphan, 'fix-d');
    delete recording.provenance.trackedPathsHash;

    const latestSha = execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim();

    const result = checkStaleness(
      recording,
      latestSha,
      repoRoot,
      // Pick a path with real history so getLatestTrackedCommit returns
      // a real SHA, forcing the function past the equality and ancestry
      // checks into the content-diff fallback (which fails on orphan).
      ['apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts'],
      // currentHash empty so the hash short-circuit doesn't fire.
      '',
    );

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('sha-unreachable');
  });

  it('recording with hash recovers the orphan-SHA case that previously failed', () => {
    // The regression: pre-fix, an orphan SHA + identical content was flagged
    // stale because git diff threw. With the hash present, the check
    // short-circuits to fresh regardless of SHA reachability.
    const orphan = '0000000000000000000000000000000000000000';
    const realHash = computeTrackedPathsHash(repoRoot, 'HEAD');
    if (realHash === '') return; // skip if HEAD has no tracked content

    const recording = makeRecording(orphan, 'fix-e');
    recording.provenance.trackedPathsHash = realHash;

    const results = checkAllStaleness([recording], repoRoot);

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(false);
    expect(results[0].reason).toBe('hash-equal');
  });
});
