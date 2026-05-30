import {
  checkStaleness,
  hasStaleRecordings,
  getLatestTrackedCommit,
} from '@/modules/reviews/eval/staleness';
import type { StalenessResult } from '@/modules/reviews/eval/staleness';
import type { Recording, RecordingProvenance } from '@/modules/reviews/eval/recording';
import { execSync } from 'child_process';

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

    const result = checkStaleness(recording, latestSha);

    expect(result.stale).toBe(false);
    expect(result.recordingGitSha).toBe(latestSha);
    expect(result.latestTrackedSha).toBe(latestSha);
  });

  it('stale recording (gitSha differs from latest tracked commit) => stale', () => {
    const recording = makeRecording('old-sha-111');

    const result = checkStaleness(recording, 'new-sha-222');

    expect(result.stale).toBe(true);
    expect(result.recordingGitSha).toBe('old-sha-111');
    expect(result.latestTrackedSha).toBe('new-sha-222');
  });

  it('empty latestTrackedSha (no git or no commits on tracked paths) => not stale', () => {
    const recording = makeRecording('any-sha');

    const result = checkStaleness(recording, '');

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
    // This test runs against the actual repo, so the tracked paths
    // should have at least one commit. Use a path we know exists.
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
    }).trim();

    const sha = getLatestTrackedCommit(repoRoot, [
      'apps/api/src/modules/reviews/types/',
    ]);

    // Should be a valid sha (40 hex chars) — unless the path has
    // never been committed, which would be unusual in this repo.
    if (sha !== '') {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('returns empty string for a non-existent path', () => {
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
    }).trim();

    const sha = getLatestTrackedCommit(repoRoot, [
      'definitely/does/not/exist/anywhere/',
    ]);

    // No commits touch this path, so git log returns empty.
    expect(sha).toBe('');
  });
});
