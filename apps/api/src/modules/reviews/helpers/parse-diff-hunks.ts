// Parses a unified diff string into a per-file map of RIGHT-side
// (post-change) line ranges. Used by anchor-findings-to-diff to
// decide whether a finding's `location_hint` lands on the diff (and
// is therefore eligible for an inline comment) or falls outside it.
//
// Only RIGHT-side ranges are emitted. Deleted files (`+++ /dev/null`)
// and binary-only headers are skipped — neither carries inline-
// commentable lines on the new tree.

export interface HunkRange {
  startLine: number;
  endLine: number;
}

// Header shape: `+++ b/path/to/file.ts` or `+++ /dev/null` for delete.
const PLUS_HEADER_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
// Hunk header shape: `@@ -A,B +C,D @@` or `@@ -A +C @@` (count omitted).
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffHunks(diff: string): Map<string, HunkRange[]> {
  const result = new Map<string, HunkRange[]>();
  if (diff.length === 0) return result;

  const lines = diff.split('\n');
  let currentFile: string | null = null;

  for (const line of lines) {
    const plusMatch = line.match(PLUS_HEADER_RE);
    if (plusMatch) {
      // capture group 1 is the path (undefined when /dev/null matched).
      currentFile = plusMatch[1] ?? null;
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (!hunkMatch) continue;

    const startLine = parseInt(hunkMatch[1], 10);
    // Count defaults to 1 when omitted by git.
    const count = hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(count) || count <= 0) {
      continue;
    }

    const range: HunkRange = {
      startLine,
      endLine: startLine + count - 1,
    };
    const list = result.get(currentFile) ?? [];
    list.push(range);
    result.set(currentFile, list);
  }

  return result;
}
