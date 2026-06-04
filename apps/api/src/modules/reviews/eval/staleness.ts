/**
 * Staleness checker — compares each recording's tracked-paths content
 * against the current repo state.
 *
 * Pure utility, NO Nest/ConfigService imports.
 *
 * Provider-aware tracked paths (changes to any of these mark the
 * corresponding recordings stale):
 *
 *   Shared baseline (every recording tracks these):
 *     - apps/api/src/infrastructure/llm/**
 *     - apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts
 *     - apps/api/seeds/**
 *
 *   Anthropic recordings additionally track:
 *     - apps/api/src/infrastructure/anthropic/**
 *
 *   OpenRouter recordings additionally track:
 *     - apps/api/src/infrastructure/openrouter/**
 *
 * Recordings without an explicit `provenance.llmProvider` are treated
 * as Anthropic (every recording captured before multi-provider support
 * existed ran against Anthropic).
 *
 * Comparison strategy, in order of preference:
 *
 *   1. `trackedPathsHash` equality. The recording stores a deterministic
 *      hash of the tracked-paths tree at capture time; the checker
 *      computes the same hash at HEAD using the SAME provider-aware
 *      path slice and compares. This works even when the recording's
 *      gitSha is unreachable in a fresh clone.
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
import type { LlmProvider } from '@/infrastructure/llm';
import type { Recording } from '@/modules/reviews/eval/recording';

// ── Tracked paths ──────────────────────────────────────────────────

/**
 * Paths every recording tracks regardless of provider. The shared LLM
 * surface lives here (system prompt, tool schemas, agent-loop helpers,
 * constants); a change to any of these affects every provider's
 * recordings equally.
 */
export const SHARED_TRACKED_PATHS = [
  'apps/api/src/infrastructure/llm/',
  'apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts',
  'apps/api/seeds/',
];

/**
 * Per-provider supplemental paths. A recording captured with provider
 * X invalidates only when the shared paths OR `PROVIDER_TRACKED_PATHS[X]`
 * change. A change to the unused provider's folder is irrelevant to
 * recordings from the active one.
 */
export const PROVIDER_TRACKED_PATHS: Record<LlmProvider, string[]> = {
  anthropic: ['apps/api/src/infrastructure/anthropic/'],
  openrouter: ['apps/api/src/infrastructure/openrouter/'],
};

/**
 * Resolve the full tracked-paths set for a given provider. Anthropic is
 * the default fallback for pre-multi-provider recordings.
 */
export function getTrackedPathsForProvider(
  provider: LlmProvider | undefined,
): string[] {
  const effective = provider ?? 'anthropic';
  return [...SHARED_TRACKED_PATHS, ...PROVIDER_TRACKED_PATHS[effective]];
}

/**
 * Back-compat union — every path that any recording could track. The
 * backfill / capture scripts use this when they need to scan everything
 * regardless of which provider's recording they're handling. Avoid in
 * staleness comparison logic; use the provider-aware resolver instead.
 */
export const STALENESS_TRACKED_PATHS = [
  ...SHARED_TRACKED_PATHS,
  ...PROVIDER_TRACKED_PATHS.anthropic,
  ...PROVIDER_TRACKED_PATHS.openrouter,
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
 * @param trackedPaths - Paths to check.
 */
export function getLatestTrackedCommit(
  repoRoot: string,
  trackedPaths: string[],
): string {
  if (trackedPaths.length === 0) return '';
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
 * @param trackedPaths - Paths to hash.
 */
export function computeTrackedPathsHash(
  repoRoot: string,
  ref: string = 'HEAD',
  trackedPaths: string[] = STALENESS_TRACKED_PATHS,
): string {
  if (ref === '' || trackedPaths.length === 0) return '';
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
 * Uses the recording's provider to pick the right tracked-paths slice,
 * then prefers `trackedPathsHash` when present (commit-graph-
 * independent) and falls back to the legacy gitSha path.
 *
 * @param recording - The recording to check.
 * @param latestTrackedSha - Latest commit touching the recording's
 *   provider's tracked paths.
 * @param repoRoot - Absolute path to the git repo root.
 * @param trackedPathsOverride - Override tracked paths (testing only).
 *   When omitted the recording's provider determines the path slice.
 * @param currentTrackedPathsHash - Optional pre-computed HEAD hash for
 *   the recording's provider's path slice. When omitted, computed
 *   lazily — pass it in `checkAllStaleness` to avoid per-recording
 *   recomputation.
 */
export function checkStaleness(
  recording: Recording,
  latestTrackedSha: string,
  repoRoot: string,
  trackedPathsOverride?: string[],
  currentTrackedPathsHash?: string,
): StalenessResult {
  const trackedPaths =
    trackedPathsOverride ??
    getTrackedPathsForProvider(recording.provenance.llmProvider);
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
 * Check staleness of all recordings against the latest tracked commit
 * for each recording's provider. Pre-computes per-provider HEAD hashes
 * and latest-SHA lookups once and reuses them across recordings sharing
 * a provider.
 *
 * @param recordings - All recordings to check.
 * @param repoRoot - Absolute path to the git repo root.
 * @param trackedPathsOverride - Optional override for ALL recordings
 *   (testing only). When omitted the provider-aware slice is used per
 *   recording.
 */
export function checkAllStaleness(
  recordings: Recording[],
  repoRoot: string,
  trackedPathsOverride?: string[],
): StalenessResult[] {
  // Per-provider memoisation. When an override is passed (specs do
  // this), every recording uses the same slice — keyed under a sentinel.
  const overrideKey = '__override__';
  const headHashByKey = new Map<string, string>();
  const latestShaByKey = new Map<string, string>();

  function pathsForRecording(r: Recording): { key: string; paths: string[] } {
    if (trackedPathsOverride) {
      return { key: overrideKey, paths: trackedPathsOverride };
    }
    const provider = r.provenance.llmProvider ?? 'anthropic';
    return { key: provider, paths: getTrackedPathsForProvider(provider) };
  }

  return recordings.map((r) => {
    const { key, paths } = pathsForRecording(r);
    if (!headHashByKey.has(key)) {
      headHashByKey.set(key, computeTrackedPathsHash(repoRoot, 'HEAD', paths));
      latestShaByKey.set(key, getLatestTrackedCommit(repoRoot, paths));
    }
    return checkStaleness(
      r,
      latestShaByKey.get(key) ?? '',
      repoRoot,
      trackedPathsOverride,
      headHashByKey.get(key),
    );
  });
}

/**
 * Returns true if any recording is stale.
 */
export function hasStaleRecordings(results: StalenessResult[]): boolean {
  return results.some((r) => r.stale);
}
