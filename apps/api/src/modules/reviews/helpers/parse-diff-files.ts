// Per-file +/- line counts from a unified diff. Used by the
// walkthrough summarizer to feed the LLM a compact file-level
// view of what the PR touched without re-parsing the diff inside
// the prompt.
//
// Returns one entry per `diff --git` block. The `path` is taken
// from the `b/<path>` side (the post-image), which is canonical
// for renames and deletions alike. Lines starting with `+++`,
// `---`, `@@`, `diff`, `index`, `new file mode`, etc., are not
// counted as added/removed.

export interface DiffFileEntry {
  path: string;
  added: number;
  removed: number;
  binary?: true;
}

export function parseDiffFiles(diff: string): DiffFileEntry[] {
  if (!diff) return [];
  const entries: DiffFileEntry[] = [];
  let current: DiffFileEntry | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // diff --git a/path b/path
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        if (current) entries.push(current);
        current = { path: match[2], added: 0, removed: 0 };
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }
    // Skip non-content header lines
    if (
      line.startsWith('index ') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename ')
    ) {
      continue;
    }
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  if (current) entries.push(current);
  return entries;
}
