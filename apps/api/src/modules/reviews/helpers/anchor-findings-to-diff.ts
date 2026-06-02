import { parseLocationHint, ParsedAnchor } from './parse-location-hint';
import type { HunkRange } from './parse-diff-hunks';
import type { FindingWithSeverity } from './format-review-body';

// Partitions findings into:
//   anchorable    — has a parseable path:line(:end), file is in the
//                   diff, AND the line range intersects at least one
//                   RIGHT-side hunk on that file. Both endpoints are clamped
//                   into the hunk: `line` capped at hunk.endLine,
//                   `startLine` floored at hunk.startLine. If the
//                   clamp collapses the range to a single line,
//                   `startLine` is null and a single-line comment
//                   is emitted instead of a malformed multi-line.
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

      // Symmetric clamping: pull startLine up to the hunk's start
      // and pull line down to the hunk's end. GitHub's review API
      // requires both endpoints of a multi-line inline comment to
      // sit inside the diff hunk; an out-of-hunk start_line yields
      // a 422. When the clamp collapses the range to a single line
      // (effectiveStart === clampedLine), emit a single-line
      // comment instead of a malformed multi-line one.
      const effectiveStart = Math.max(parsed.startLine, hunk.startLine);
      const clampedLine = Math.min(parsed.endLine, hunk.endLine);
      const isMultiLine = effectiveStart < clampedLine;
      anchorable.push({
        finding,
        path: parsed.path,
        startLine: isMultiLine ? effectiveStart : null,
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
