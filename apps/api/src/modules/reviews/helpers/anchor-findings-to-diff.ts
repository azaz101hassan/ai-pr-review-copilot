import { parseLocationHint, ParsedAnchor } from './parse-location-hint';
import type { HunkRange } from './parse-diff-hunks';
import type { FindingWithSeverity } from './format-review-body';

// Partitions findings into:
//   anchorable    — has a parseable path:line(:end), file is in the
//                   diff, AND the line range intersects at least one
//                   RIGHT-side hunk on that file. `line` is clamped to the
//                   in-hunk maximum when a range overlaps the end of
//                   a hunk; `startLine` keeps the original start
//                   when it differs from `line`.
//   outsideDiff   — everything else: null hint, unparseable hint,
//                   path-only hint (no line), file not in diff, or
//                   line range fully outside every hunk on that file.

export interface AnchorableFinding {
  finding: FindingWithSeverity;
  path: string;
  // When startLine is non-null and differs from `line`, the caller
  // emits a multi-line inline comment via start_line + line. When
  // null, the caller emits a single-line comment.
  startLine: number | null;
  line: number;
}

export interface OutsideDiffFinding {
  finding: FindingWithSeverity;
  parsedAnchor: ParsedAnchor | null;
}

export interface AnchorPartition {
  anchorable: AnchorableFinding[];
  outsideDiff: OutsideDiffFinding[];
}

export interface AnchorFindingsToDiffInput {
  findings: FindingWithSeverity[];
  diffHunks: Map<string, HunkRange[]>;
}

export function anchorFindingsToDiff(
  input: AnchorFindingsToDiffInput,
): AnchorPartition {
  const anchorable: AnchorableFinding[] = [];
  const outsideDiff: OutsideDiffFinding[] = [];

  for (const finding of input.findings) {
    const parsed = parseLocationHint(finding.location_hint ?? null);

    // No parseable anchor at all.
    if (parsed === null) {
      outsideDiff.push({ finding, parsedAnchor: null });
      continue;
    }

    // Path-only (no line) — can't be inline-anchored.
    if (parsed.startLine === null || parsed.endLine === null) {
      outsideDiff.push({ finding, parsedAnchor: parsed });
      continue;
    }

    // File not in diff.
    const hunks = input.diffHunks.get(parsed.path);
    if (!hunks || hunks.length === 0) {
      outsideDiff.push({ finding, parsedAnchor: parsed });
      continue;
    }

    // Find a hunk this range intersects. For a multi-line finding
    // we keep the original startLine and clamp `line` to the in-hunk
    // max; for a single-line finding startLine stays null and `line`
    // is the in-hunk line. We pick the FIRST hunk that intersects;
    // if a range straddles two hunks, GitHub's API can only attach
    // one inline anyway.
    let anchored = false;
    for (const hunk of hunks) {
      const startInHunk = parsed.startLine <= hunk.endLine;
      const endInHunk = parsed.endLine >= hunk.startLine;
      if (!startInHunk || !endInHunk) continue;

      const clampedLine = Math.min(parsed.endLine, hunk.endLine);
      const isMultiLine = parsed.startLine < clampedLine;
      anchorable.push({
        finding,
        path: parsed.path,
        startLine: isMultiLine ? parsed.startLine : null,
        line: clampedLine,
      });
      anchored = true;
      break;
    }

    if (!anchored) {
      outsideDiff.push({ finding, parsedAnchor: parsed });
    }
  }

  return { anchorable, outsideDiff };
}
