/**
 * Provenance field maintenance for committed recordings.
 *
 * Two modes:
 *
 *   1. **Backfill (default).** Populate `provenance.trackedPathsHash`
 *      and/or `provenance.llmProvider` on recordings that were captured
 *      before those fields existed. Hash is computed at each recording's
 *      own `gitSha` so the result genuinely reflects "what the
 *      tracked-paths tree looked like when this was captured." Skips
 *      recordings whose SHA is unreachable in the local clone.
 *
 *   2. **Refresh existing (`--refresh-existing`).** Recompute the hash
 *      for every recording against the current HEAD, using the
 *      recording's provider-aware tracked-paths slice, and overwrite
 *      whatever was there. Use this when a behaviour-preserving
 *      refactor has changed the bytes of tracked files but you've
 *      verified the LLM would emit the same findings (e.g. the
 *      SYSTEM_PROMPT + REGISTERED_TOOLS hash is unchanged, the agent
 *      loop control flow is unchanged, and only the file layout /
 *      comment text moved). Lets the eval gate go green without
 *      re-capturing every recording. Use sparingly — the safest action
 *      is always to re-capture.
 *
 * The write is done as a string-level insert/replace so non-ASCII
 * escapes and any other formatting quirks in the source recording are
 * preserved byte-for-byte. This keeps PR diffs focused on the new field
 * instead of incidental JSON normalization.
 *
 * Usage:
 *   npm run eval:backfill-hash --workspace apps/api
 *   npm run eval:backfill-hash --workspace apps/api -- --refresh-existing
 *
 * Idempotent: re-running in either mode after a successful pass is a
 * no-op.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LlmProvider } from '@/infrastructure/llm';
import type { Recording } from './recording';
import {
  computeTrackedPathsHash,
  getTrackedPathsForProvider,
} from './staleness';

interface BackfillSummary {
  total: number;
  alreadyHadHash: number;
  alreadyHadProvider: number;
  backfilled: number;
  providerStamped: number;
  refreshed: number;
  skippedOrphan: number;
  skippedMissingSha: number;
}

interface BackfillOptions {
  /** If true, recompute every recording's hash at HEAD using its
   * provider-aware path slice, overwriting whatever was there. */
  refreshExisting: boolean;
  /** Default provider stamped onto pre-multi-provider recordings that
   * predate the `llmProvider` field. Anthropic was the only provider
   * before the multi-provider work landed, so 'anthropic' is the safe
   * default. */
  defaultProvider: LlmProvider;
}

function recordingsDir(evalFixturesDir: string): string {
  return path.join(evalFixturesDir, 'recordings');
}

/**
 * Insert `"trackedPathsHash": "<hash>"` immediately after the `gitSha`
 * line, preserving the source's exact bytes everywhere else. Returns
 * the new text, or null when the gitSha line cannot be located (which
 * would be a schema mismatch the caller should surface).
 */
function insertHashAfterGitSha(source: string, hash: string): string | null {
  const re = /^(\s*)"gitSha":\s*"([0-9a-f]{40})"(,?)\s*$/m;
  const match = re.exec(source);
  if (!match) return null;
  const [whole, indent, sha, trailingComma] = match;
  // We're inserting a new line that itself ends the provenance block
  // or precedes another field. Force a trailing comma on the gitSha so
  // the new line is valid in either case.
  const replacement =
    `${indent}"gitSha": "${sha}",\n` +
    `${indent}"trackedPathsHash": "${hash}"${trailingComma}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + whole.length);
}

/**
 * Overwrite the existing `"trackedPathsHash"` line in-place. Returns
 * the new text or null when the line cannot be located.
 */
function replaceExistingHash(source: string, hash: string): string | null {
  const re = /^(\s*)"trackedPathsHash":\s*"[0-9a-f]+"(,?)\s*$/m;
  const match = re.exec(source);
  if (!match) return null;
  const [whole, indent, trailingComma] = match;
  const replacement = `${indent}"trackedPathsHash": "${hash}"${trailingComma}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + whole.length);
}

/**
 * Insert `"llmProvider": "<provider>"` immediately before the closing
 * `}` of the `provenance` block. Returns the new text or null when the
 * provenance block cannot be located.
 *
 * Anchored on `trackedPathsHash` (always last before the close in
 * current recordings) when present, otherwise on `gitSha`.
 */
function insertProviderInProvenance(
  source: string,
  provider: LlmProvider,
): string | null {
  // Prefer anchoring on trackedPathsHash since it was already the last
  // line of provenance prior to this refactor. Fallback to gitSha for
  // recordings that don't carry the hash yet.
  const reHash = /^(\s*)"trackedPathsHash":\s*"[0-9a-f]+"(,?)\s*$/m;
  const reSha = /^(\s*)"gitSha":\s*"[0-9a-f]{40}"(,?)\s*$/m;
  const match = reHash.exec(source) ?? reSha.exec(source);
  if (!match) return null;
  const [whole, indent, trailingComma] = match;
  const original = match[0];
  const newAnchor = original.replace(/(,?)\s*$/, ',');
  const inserted = `${newAnchor}\n${indent}"llmProvider": "${provider}"${trailingComma}`;
  return source.slice(0, match.index) + inserted + source.slice(match.index + whole.length);
}

function backfill(
  repoRoot: string,
  evalFixturesDir: string,
  options: BackfillOptions,
): BackfillSummary {
  const dir = recordingsDir(evalFixturesDir);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.recording.json')).sort()
    : [];

  const summary: BackfillSummary = {
    total: files.length,
    alreadyHadHash: 0,
    alreadyHadProvider: 0,
    backfilled: 0,
    providerStamped: 0,
    refreshed: 0,
    skippedOrphan: 0,
    skippedMissingSha: 0,
  };

  for (const file of files) {
    const filePath = path.join(dir, file);
    let source = fs.readFileSync(filePath, 'utf-8');
    const recording = JSON.parse(source) as Recording;
    let mutated = false;

    // ── Pass 1: llmProvider ──────────────────────────────────────
    const recordingProvider = recording.provenance.llmProvider;
    if (recordingProvider) {
      summary.alreadyHadProvider += 1;
    } else {
      const updated = insertProviderInProvenance(source, options.defaultProvider);
      if (updated === null) {
        throw new Error(
          `[backfill-hash] could not locate insertion point for llmProvider in ${file} — schema mismatch?`,
        );
      }
      source = updated;
      summary.providerStamped += 1;
      mutated = true;
      // eslint-disable-next-line no-console
      console.log(
        `[backfill-hash] stamped ${recording.fixtureId} with llmProvider="${options.defaultProvider}"`,
      );
    }
    const effectiveProvider: LlmProvider =
      recordingProvider ?? options.defaultProvider;
    const providerTrackedPaths = getTrackedPathsForProvider(effectiveProvider);

    // ── Pass 2: trackedPathsHash ─────────────────────────────────
    const hadHash = Boolean(recording.provenance.trackedPathsHash);

    if (hadHash && !options.refreshExisting) {
      summary.alreadyHadHash += 1;
    } else if (options.refreshExisting) {
      const headHash = computeTrackedPathsHash(
        repoRoot,
        'HEAD',
        providerTrackedPaths,
      );
      if (headHash === '') {
        summary.skippedOrphan += 1;
        // eslint-disable-next-line no-console
        console.log(
          `[backfill-hash] skip refresh of ${recording.fixtureId} — HEAD hash unavailable`,
        );
      } else if (hadHash) {
        const updated = replaceExistingHash(source, headHash);
        if (updated === null) {
          throw new Error(
            `[backfill-hash] could not locate trackedPathsHash line in ${file} — schema mismatch?`,
          );
        }
        if (updated !== source) {
          source = updated;
          summary.refreshed += 1;
          mutated = true;
          // eslint-disable-next-line no-console
          console.log(
            `[backfill-hash] refreshed ${recording.fixtureId} hash -> ${headHash.slice(0, 12)}… (provider=${effectiveProvider})`,
          );
        } else {
          summary.alreadyHadHash += 1;
        }
      } else {
        const updated = insertHashAfterGitSha(source, headHash);
        if (updated === null) {
          throw new Error(
            `[backfill-hash] could not locate gitSha line in ${file} — schema mismatch?`,
          );
        }
        source = updated;
        summary.backfilled += 1;
        mutated = true;
        // eslint-disable-next-line no-console
        console.log(
          `[backfill-hash] wrote ${recording.fixtureId} (HEAD -> hash ${headHash.slice(0, 12)}…, provider=${effectiveProvider})`,
        );
      }
    } else {
      // Default backfill — hash at the recording's own gitSha.
      const sha = recording.provenance.gitSha;
      if (!sha || sha === 'unknown') {
        summary.skippedMissingSha += 1;
        // eslint-disable-next-line no-console
        console.log(
          `[backfill-hash] skip ${recording.fixtureId} — provenance.gitSha is "${sha || '(empty)'}"`,
        );
      } else {
        const hash = computeTrackedPathsHash(repoRoot, sha, providerTrackedPaths);
        if (hash === '') {
          summary.skippedOrphan += 1;
          // eslint-disable-next-line no-console
          console.log(
            `[backfill-hash] skip ${recording.fixtureId} — gitSha ${sha.slice(0, 8)} unreachable`,
          );
        } else {
          const updated = insertHashAfterGitSha(source, hash);
          if (updated === null) {
            throw new Error(
              `[backfill-hash] could not locate gitSha line in ${file} — schema mismatch?`,
            );
          }
          source = updated;
          summary.backfilled += 1;
          mutated = true;
          // eslint-disable-next-line no-console
          console.log(
            `[backfill-hash] wrote ${recording.fixtureId} (sha ${sha.slice(0, 8)} -> hash ${hash.slice(0, 12)}…, provider=${effectiveProvider})`,
          );
        }
      }
    }

    if (mutated) {
      fs.writeFileSync(filePath, source, 'utf-8');
    }
  }

  return summary;
}

function parseArgs(argv: string[]): BackfillOptions {
  return {
    refreshExisting: argv.includes('--refresh-existing'),
    defaultProvider: 'anthropic',
  };
}

function main(): void {
  const apiRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const repoRoot = path.resolve(apiRoot, '..', '..');
  const evalFixturesDir = path.resolve(apiRoot, 'test', 'fixtures', 'eval');
  const options = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(`[backfill-hash] repoRoot=${repoRoot}`);
  // eslint-disable-next-line no-console
  console.log(`[backfill-hash] evalFixturesDir=${evalFixturesDir}`);
  // eslint-disable-next-line no-console
  console.log(
    `[backfill-hash] mode=${options.refreshExisting ? 'refresh-existing' : 'backfill-missing'}`,
  );

  const summary = backfill(repoRoot, evalFixturesDir, options);

  // eslint-disable-next-line no-console
  console.log('\n[backfill-hash] summary:');
  // eslint-disable-next-line no-console
  console.log(`  total recordings:      ${summary.total}`);
  // eslint-disable-next-line no-console
  console.log(`  already had provider:  ${summary.alreadyHadProvider}`);
  // eslint-disable-next-line no-console
  console.log(`  provider stamped:      ${summary.providerStamped}`);
  // eslint-disable-next-line no-console
  console.log(`  already had hash:      ${summary.alreadyHadHash}`);
  // eslint-disable-next-line no-console
  console.log(`  backfilled:            ${summary.backfilled}`);
  // eslint-disable-next-line no-console
  console.log(`  refreshed:             ${summary.refreshed}`);
  // eslint-disable-next-line no-console
  console.log(`  skipped (orphan SHA):  ${summary.skippedOrphan}`);
  // eslint-disable-next-line no-console
  console.log(`  skipped (no gitSha):   ${summary.skippedMissingSha}`);
}

if (require.main === module) {
  main();
}

export { backfill };
export type { BackfillSummary, BackfillOptions };
