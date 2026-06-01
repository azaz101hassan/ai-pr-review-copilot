// Parses Claude's freeform `location_hint` into a structured anchor.
// Tolerant of the four shapes observed in eval recordings:
//   "src/foo.ts"           → path-only (no line numbers)
//   "src/foo.ts:42"        → single line
//   "src/foo.ts:42-50"     → range
//   "src/foo.ts:19,26"     → comma list; keep first line, drop the rest
// Returns null for null / empty / unparseable input. The caller routes
// null-returning findings to the Walkthrough outside-diff section.
//
// Path-extraction note: we split on the LAST colon followed by digits
// so Windows-style absolute paths ("C:\\src\\foo.ts:42") keep the
// drive-letter colon as part of the path. The Day-5 corpus is
// Unix-style; this is forward-compat.

export interface ParsedAnchor {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

// Matches the rightmost ":<digits>...<terminator>" segment so we
// peel the line/range portion off the right end of the string.
// The line portion can be "N", "N-M", or "N,M,...".
const LINE_PORTION_RE = /:(\d+(?:[-,]\d+(?:[-,]\d+)*)?)$/;

export function parseLocationHint(hint: string | null): ParsedAnchor | null {
  if (hint === null) return null;
  const trimmed = hint.trim();
  if (trimmed.length === 0) return null;

  // Try to peel a line portion off the right end.
  const match = trimmed.match(LINE_PORTION_RE);
  if (!match) {
    // No trailing line portion. The whole string is the path — but
    // reject obviously malformed inputs (empty path, leading colons).
    if (trimmed.includes(':') && trimmed.replace(/[:\s]/g, '').length === 0) {
      return null;
    }
    // Reject "path:non-digit-suffix" — looks like a broken line reference.
    // A trailing colon followed by anything non-digit (letters, minus sign,
    // etc.) signals the caller tried to specify a line but got it wrong.
    if (/:[^/\\]/.test(trimmed)) {
      // Only reject if the part after the last colon looks like a
      // malformed line specifier (non-empty, non-digit-only).
      const lastColonIdx = trimmed.lastIndexOf(':');
      const afterColon = trimmed.slice(lastColonIdx + 1);
      if (afterColon.length > 0 && !/^\d/.test(afterColon)) {
        return null;
      }
    }
    return { path: trimmed, startLine: null, endLine: null };
  }

  const linePortion = match[1];
  const path = trimmed.slice(0, match.index).trim();
  if (path.length === 0) return null;

  // Comma list — keep first line only.
  if (linePortion.includes(',')) {
    const first = parseInt(linePortion.split(',')[0], 10);
    if (!Number.isFinite(first) || first < 1) return null;
    return { path, startLine: first, endLine: first };
  }

  // Range "N-M".
  if (linePortion.includes('-')) {
    const [a, b] = linePortion.split('-').map((s) => parseInt(s, 10));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < 1 || b < 1) return null;
    if (b < a) return null;
    return { path, startLine: a, endLine: b };
  }

  // Single line "N".
  const n = parseInt(linePortion, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return { path, startLine: n, endLine: n };
}
