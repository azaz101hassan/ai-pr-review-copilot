import {
  checkStaleness,
  hasStaleRecordings,
  getLatestTrackedCommit,
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
    const commits = execSync('git log --oneline -3 --format=%H', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim().split('\n');

    if (commits.length < 2) return;

    const olderCommit = commits[1];
    const newerCommit = commits[0];
    const recording = makeRecording(olderCommit);

    const result = checkStaleness(recording, newerCommit, repoRoot);

    expect(result.stale).toBe(true);
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
      { fixtureId: 'a', recordingGitSha: 'sha1', latestTrackedSha: 'sha1', stale: false },
      { fixtureId: 'b', recordingGitSha: 'sha1', latestTrackedSha: 'sha1', stale: false },
    ];

    expect(hasStaleRecordings(results)).toBe(false);
  });

  it('returns true when any is stale', () => {
    const results: StalenessResult[] = [
      { fixtureId: 'a', recordingGitSha: 'sha1', latestTrackedSha: 'sha1', stale: false },
      { fixtureId: 'b', recordingGitSha: 'old', latestTrackedSha: 'new', stale: true },
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
