/**
 * Staleness checker — compares each recording's tracked-paths content
 * against the current repo state.
 *
 * Pure utility, NO Nest/ConfigService imports.
 *
 * Tracked paths (changes to any of these make recordings stale):
 *   - apps/api/src/infrastructure/llm/**
 *   - apps/api/src/infrastructure/anthropic/**
 *   - apps/api/src/infrastructure/openrouter/**
 *   - apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts
 *   - apps/api/seeds/**
 *
 * Comparison strategy, in order of preference:
 *
 *   1. `trackedPathsHash` equality. The recording stores a deterministic
 *      hash of the tracked-paths tree at capture time; the checker
 *      computes the same hash at HEAD and compares. This works even when
 *      the recording's gitSha is unreachable in a fresh clone, which is
 *      the common case after a feature branch gets squash-merged and
 *      deleted on the remote.
 *
 *   2. Legacy gitSha path — used when the recording predates the hash
 *      field. Layered as:
 *         a. SHA equality — trivially fresh.
 *         b. SHA ancestry (latest tracked SHA is an ancestor of the
 *            recording) — fresh, recording was captured at or after the
 *            latest tracked change.
 *         c. Content equality via `git diff <a> <b>` on tracked paths —
 *            fresh when the tree is identical despite different SHAs.
 *
 * If neither path can prove freshness, the recording is stale.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import type { Recording } from '@/modules/reviews/eval/recording';

// ── Tracked paths ──────────────────────────────────────────────────

export const STALENESS_TRACKED_PATHS = [
  'apps/api/src/infrastructure/llm/',
  'apps/api/src/infrastructure/anthropic/',
  'apps/api/src/infrastructure/openrouter/',
  'apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts',
  'apps/api/seeds/',
];

// ── Types ──────────────────────────────────────────────────────────

export interface StalenessResult {
  fixtureId: string;
  recordingGitSha: string;
  latestTrackedSha: string;
  stale: boolean;
  /**
   * How freshness was decided. `hash-equal` and `hash-differs` mean the
   * recording carried a `trackedPathsHash` and was compared directly.
   * `sha-*` cases are the legacy SHA-based fallback. Useful for reports.
   */
  reason:
    | 'hash-equal'
    | 'hash-differs'
    | 'sha-equal'
    | 'sha-ancestor'
    | 'sha-content-equal'
    | 'sha-content-differs'
    | 'sha-unreachable'
    | 'unknown';
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
 * Compute a deterministic hash of the tracked-paths tree at `ref`.
 *
 * Uses `git ls-tree -r <ref> -- <paths>` so the result depends only on
 * file content and path (not on commit metadata, parents, or history).
 * Two refs that point at identical tracked-path content produce
 * identical hashes — which is exactly what staleness wants to detect.
 *
 * Returns an empty string if `ref` is unreachable, git is unavailable,
 * or the tracked paths produce no tree entries. Callers treat empty as
 * "unknown" and fall back to gitSha-based logic.
 *
 * @param repoRoot - Absolute path to the git repo root.
 * @param ref - Commit, tag, branch, or `HEAD` (default).
 * @param trackedPaths - Paths to hash (defaults to STALENESS_TRACKED_PATHS).
 */
export function computeTrackedPathsHash(
  repoRoot: string,
  ref: string = 'HEAD',
  trackedPaths: string[] = STALENESS_TRACKED_PATHS,
): string {
  if (ref === '') return '';
  try {
    const lsTree = execSync(
      `git ls-tree -r ${ref} -- ${trackedPaths.map((p) => `"${p}"`).join(' ')}`,
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const entries = lsTree
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    if (entries.length === 0) return '';
    return createHash('sha256').update(entries.join('\n')).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Check staleness of a single recording.
 *
 * Prefers the recording's `trackedPathsHash` when present (commit-graph-
 * independent), and otherwise falls back to the legacy gitSha path.
 *
 * @param recording - The recording to check.
 * @param latestTrackedSha - Latest commit touching tracked paths (legacy fallback).
 * @param repoRoot - Absolute path to the git repo root.
 * @param trackedPaths - Override tracked paths (for testing).
 * @param currentTrackedPathsHash - Optional pre-computed HEAD hash. When
 *   omitted, computed lazily — pass it in `checkAllStaleness` to avoid
 *   per-recording recomputation.
 */
export function checkStaleness(
  recording: Recording,
  latestTrackedSha: string,
  repoRoot: string,
  trackedPaths: string[] = STALENESS_TRACKED_PATHS,
  currentTrackedPathsHash?: string,
): StalenessResult {
  const recordingSha = recording.provenance.gitSha;
  const recordingHash = recording.provenance.trackedPathsHash;
  const currentHash =
    currentTrackedPathsHash ??
    computeTrackedPathsHash(repoRoot, 'HEAD', trackedPaths);

  let stale: boolean;
  let reason: StalenessResult['reason'];

  if (recordingHash && currentHash) {
    if (recordingHash === currentHash) {
      stale = false;
      reason = 'hash-equal';
    } else {
      stale = true;
      reason = 'hash-differs';
    }
  } else if (latestTrackedSha === '' || recordingSha === '') {
    stale = false;
    reason = 'unknown';
  } else if (recordingSha === latestTrackedSha) {
    stale = false;
    reason = 'sha-equal';
  } else if (isAncestor(latestTrackedSha, recordingSha, repoRoot)) {
    stale = false;
    reason = 'sha-ancestor';
  } else {
    const contentEqual = trackedPathsContentEqual(
      recordingSha,
      latestTrackedSha,
      repoRoot,
      trackedPaths,
    );
    if (contentEqual === true) {
      stale = false;
      reason = 'sha-content-equal';
    } else if (contentEqual === false) {
      stale = true;
      reason = 'sha-content-differs';
    } else {
      stale = true;
      reason = 'sha-unreachable';
    }
  }

  return {
    fixtureId: recording.fixtureId,
    recordingGitSha: recordingSha,
    latestTrackedSha,
    stale,
    reason,
  };
}

function isAncestor(ancestor: string, descendant: string, repoRoot: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Three-valued: `true` (byte-identical), `false` (real diff), or `null`
 * (one or both SHAs unreachable). The null case lets the caller
 * distinguish a genuine content drift from a tooling failure — important
 * because the latter must NOT be silently swallowed as fresh.
 */
function trackedPathsContentEqual(
  a: string,
  b: string,
  repoRoot: string,
  trackedPaths: string[],
): boolean | null {
  try {
    const diff = execSync(
      `git diff ${a} ${b} -- ${trackedPaths.map((p) => `"${p}"`).join(' ')}`,
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return diff.trim() === '';
  } catch {
    return null;
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
  const currentHash = computeTrackedPathsHash(repoRoot, 'HEAD', paths);

  return recordings.map((r) =>
    checkStaleness(r, latestSha, repoRoot, paths, currentHash),
  );
}

/**
 * Returns true if any recording is stale.
 */
export function hasStaleRecordings(results: StalenessResult[]): boolean {
  return results.some((r) => r.stale);
}
