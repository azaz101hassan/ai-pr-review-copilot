/**
 * Staleness checker — compares each recording's `gitSha` against
 * the latest commit touching the tracked paths.
 *
 * Pure utility, NO Nest/ConfigService imports.
 *
 * Tracked paths (changes to any of these make recordings stale):
 *   - apps/api/src/infrastructure/anthropic/**
 *   - apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts
 *   - apps/api/seeds/**
 */

import { execSync } from 'child_process';
import type { Recording } from '@/modules/reviews/eval/recording';

// ── Tracked paths ──────────────────────────────────────────────────

export const STALENESS_TRACKED_PATHS = [
  'apps/api/src/infrastructure/anthropic/',
  'apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts',
  'apps/api/seeds/',
];

// ── Types ──────────────────────────────────────────────────────────

export interface StalenessResult {
  fixtureId: string;
  recordingGitSha: string;
  latestTrackedSha: string;
  stale: boolean;
}

// ── Core ───────────────────────────────────────────────────────────

/**
 * Get the latest commit SHA that touched any of the tracked paths.
 *
 * @param repoRoot - Absolute path to the git repo root.
 * @param trackedPaths - Paths to check (defaults to STALENESS_TRACKED_PATHS).
 */
export function getLatestTrackedCommit(
  repoRoot: string,
  trackedPaths: string[] = STALENESS_TRACKED_PATHS,
): string {
  try {
    const sha = execSync(
      `git log -1 --format=%H -- ${trackedPaths.map((p) => `"${p}"`).join(' ')}`,
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim();
    return sha;
  } catch {
    // If git is not available or the paths have no commits,
    // return empty string (treated as "unknown").
    return '';
  }
}

/**
 * Check staleness of a single recording against the latest tracked commit.
 */
export function checkStaleness(
  recording: Recording,
  latestTrackedSha: string,
): StalenessResult {
  const recordingSha = recording.provenance.gitSha;

  return {
    fixtureId: recording.fixtureId,
    recordingGitSha: recordingSha,
    latestTrackedSha,
    stale: latestTrackedSha !== '' && recordingSha !== latestTrackedSha,
  };
}

/**
 * Check staleness of all recordings against the latest tracked commit.
 *
 * @param recordings - All recordings to check.
 * @param repoRoot - Absolute path to the git repo root.
 * @param trackedPaths - Override tracked paths (for testing).
 */
export function checkAllStaleness(
  recordings: Recording[],
  repoRoot: string,
  trackedPaths?: string[],
): StalenessResult[] {
  const latestSha = getLatestTrackedCommit(repoRoot, trackedPaths);

  return recordings.map((r) => checkStaleness(r, latestSha));
}

/**
 * Returns true if any recording is stale.
 */
export function hasStaleRecordings(results: StalenessResult[]): boolean {
  return results.some((r) => r.stale);
}
