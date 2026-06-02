// Counts the number of changed lines in a unified diff — additions plus
// deletions, excluding file headers (+++/---) and hunk headers (@@).
// Used by the worker's soft size gate to decide whether a PR is small
// enough to review (vs posting a "PR too big, skipping" comment).
//
// "Changed lines" is the same definition GitHub uses for its
// additions+deletions display, so a 500-line cap intuitively matches
// what an operator sees on the PR page.

export function countChangedLines(diff: string): number {
  if (!diff) return 0;
  let count = 0;
  // Support CRLF (GitHub diffs sometimes carry Windows endings when
  // the source files use them). Split on LF after stripping any CR.
  const lines = diff.split('\n');
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // Order matters: check the 3-char file-header prefixes BEFORE the
    // single-char content prefix, otherwise "+++ b/x.js" counts as an
    // addition.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) count += 1;
  }
  return count;
}
