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
 *
 * A recording is stale when the tracked paths' CONTENT differs between the
 * recording's gitSha and the latest tracked SHA. The check is layered:
 *
 *   1. SHA equality — trivially fresh.
 *   2. SHA ancestry (latest is ancestor of recording) — fresh, recording was
 *      captured at or after the latest tracked change.
 *   3. Content equality (`git diff` on tracked paths is empty) — fresh.
 *      Handles squash-merges (recording captured on a now-orphaned branch
 *      that integrated into the trunk with identical tree content) and
 *      merge commits that the topology check would otherwise flag.
 *
 * If both reachable SHAs disagree on content, the recording is stale.
 * If a SHA is unreachable (shallow clone of an orphan branch), we fall
 * through to "stale" — safer to over-fail than to under-fail.
 */
export function checkStaleness(
  recording: Recording,
  latestTrackedSha: string,
  repoRoot: string,
  trackedPaths: string[] = STALENESS_TRACKED_PATHS,
): StalenessResult {
  const recordingSha = recording.provenance.gitSha;

  let stale: boolean;
  if (latestTrackedSha === '' || recordingSha === '') {
    stale = false;
  } else if (recordingSha === latestTrackedSha) {
    stale = false;
  } else if (isAncestor(latestTrackedSha, recordingSha, repoRoot)) {
    stale = false;
  } else {
    stale = !trackedPathsContentEqual(
      recordingSha,
      latestTrackedSha,
      repoRoot,
      trackedPaths,
    );
  }

  return {
    fixtureId: recording.fixtureId,
    recordingGitSha: recordingSha,
    latestTrackedSha,
    stale,
  };
}

function isAncestor(ancestor: string, descendant: string, repoRoot: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the tracked paths have byte-identical content at both SHAs.
 * Returns false on any error (unreachable SHA, no git, etc.) so the
 * caller treats the recording as stale rather than silently fresh.
 */
function trackedPathsContentEqual(
  a: string,
  b: string,
  repoRoot: string,
  trackedPaths: string[],
): boolean {
  try {
    const diff = execSync(
      `git diff ${a} ${b} -- ${trackedPaths.map((p) => `"${p}"`).join(' ')}`,
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    return diff.trim() === '';
  } catch {
    return false;
  }
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
  const paths = trackedPaths ?? STALENESS_TRACKED_PATHS;
  const latestSha = getLatestTrackedCommit(repoRoot, paths);

  return recordings.map((r) => checkStaleness(r, latestSha, repoRoot, paths));
}

/**
 * Returns true if any recording is stale.
 */
export function hasStaleRecordings(results: StalenessResult[]): boolean {
  return results.some((r) => r.stale);
}
