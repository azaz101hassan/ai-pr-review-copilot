/**
 * One-off backfill: populate `provenance.trackedPathsHash` on existing
 * recordings that were captured before the field was added.
 *
 * For each recording without the field, attempt to compute the hash at
 * the recording's `gitSha`. If the SHA is reachable, write the hash
 * back. If it's an orphan (e.g. captured on a now-deleted feature
 * branch and not present in the local clone), skip — those recordings
 * will continue to use the legacy SHA-based staleness fallback.
 *
 * The write is done as a string-level insert so non-ASCII escapes and
 * any other formatting quirks in the source recording are preserved
 * byte-for-byte. This keeps the PR diff focused on the new field
 * instead of incidental JSON normalization.
 *
 * Usage:
 *   npm run eval:backfill-hash --workspace apps/api
 *
 * Idempotent: re-running after a successful backfill is a no-op.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Recording } from './recording';
import { computeTrackedPathsHash, STALENESS_TRACKED_PATHS } from './staleness';

interface BackfillSummary {
  total: number;
  alreadyHadHash: number;
  backfilled: number;
  skippedOrphan: number;
  skippedMissingSha: number;
}

function recordingsDir(evalFixturesDir: string): string {
  return path.join(evalFixturesDir, 'recordings');
}

/**
 * Insert `"trackedPathsHash": "<hash>"` right after the `gitSha` line,
 * preserving the source's exact bytes everywhere else. Returns the new
 * text, or null when the gitSha line cannot be located (which would be
 * a schema mismatch the caller should surface).
 */
function insertHashAfterGitSha(source: string, hash: string): string | null {
  // Match the gitSha line, capturing leading whitespace so the inserted
  // line uses the same indentation. The gitSha is a 40-char hex string.
  const re = /^(\s*)"gitSha":\s*"([0-9a-f]{40})"(,?)\s*$/m;
  const match = re.exec(source);
  if (!match) return null;
  const [whole, indent, sha, trailingComma] = match;
  const replacement =
    `${indent}"gitSha": "${sha}",\n` +
    `${indent}"trackedPathsHash": "${hash}"${trailingComma}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + whole.length);
}

function backfill(repoRoot: string, evalFixturesDir: string): BackfillSummary {
  const dir = recordingsDir(evalFixturesDir);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.recording.json')).sort()
    : [];

  const summary: BackfillSummary = {
    total: files.length,
    alreadyHadHash: 0,
    backfilled: 0,
    skippedOrphan: 0,
    skippedMissingSha: 0,
  };

  for (const file of files) {
    const filePath = path.join(dir, file);
    const source = fs.readFileSync(filePath, 'utf-8');
    const recording = JSON.parse(source) as Recording;

    if (recording.provenance.trackedPathsHash) {
      summary.alreadyHadHash += 1;
      continue;
    }

    const sha = recording.provenance.gitSha;
    if (!sha || sha === 'unknown') {
      summary.skippedMissingSha += 1;
      // eslint-disable-next-line no-console
      console.log(
        `[backfill-hash] skip ${recording.fixtureId} — provenance.gitSha is "${sha || '(empty)'}"`,
      );
      continue;
    }

    const hash = computeTrackedPathsHash(repoRoot, sha, STALENESS_TRACKED_PATHS);
    if (hash === '') {
      summary.skippedOrphan += 1;
      // eslint-disable-next-line no-console
      console.log(
        `[backfill-hash] skip ${recording.fixtureId} — gitSha ${sha.slice(0, 8)} unreachable`,
      );
      continue;
    }

    const updated = insertHashAfterGitSha(source, hash);
    if (updated === null) {
      throw new Error(
        `[backfill-hash] could not locate gitSha line in ${file} — schema mismatch?`,
      );
    }
    fs.writeFileSync(filePath, updated, 'utf-8');
    summary.backfilled += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[backfill-hash] wrote ${recording.fixtureId} (sha ${sha.slice(0, 8)} -> hash ${hash.slice(0, 12)}…)`,
    );
  }

  return summary;
}

function main(): void {
  const apiRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const repoRoot = path.resolve(apiRoot, '..', '..');
  const evalFixturesDir = path.resolve(apiRoot, 'test', 'fixtures', 'eval');

  // eslint-disable-next-line no-console
  console.log(`[backfill-hash] repoRoot=${repoRoot}`);
  // eslint-disable-next-line no-console
  console.log(`[backfill-hash] evalFixturesDir=${evalFixturesDir}`);

  const summary = backfill(repoRoot, evalFixturesDir);

  // eslint-disable-next-line no-console
  console.log('\n[backfill-hash] summary:');
  // eslint-disable-next-line no-console
  console.log(`  total recordings:      ${summary.total}`);
  // eslint-disable-next-line no-console
  console.log(`  already had hash:      ${summary.alreadyHadHash}`);
  // eslint-disable-next-line no-console
  console.log(`  backfilled:            ${summary.backfilled}`);
  // eslint-disable-next-line no-console
  console.log(`  skipped (orphan SHA):  ${summary.skippedOrphan}`);
  // eslint-disable-next-line no-console
  console.log(`  skipped (no gitSha):   ${summary.skippedMissingSha}`);
}

if (require.main === module) {
  main();
}

export { backfill };
export type { BackfillSummary };
