# Inline PR Review Comments — Implementation Plan

> **Reference spec:** `docs/plans/09-inline-pr-review-comments.md`
> **Branch:** `feat/inline-pr-review-comments` (already created)
> **Prior commit:** `fee4c29` (spec doc)

**Goal:** Replace today's single concatenated review comment with two timeline objects per review run — an editable Walkthrough issue comment (PATCH-edited via HTML marker on re-review) plus an inlined Review whose `comments[]` array anchors each finding to its `file:line`.

**Architecture:** Pure-function helpers (parse `location_hint`, parse diff hunks, partition findings into anchorable vs. outside-diff, format each body type) feed a refactored `reviews.processor.ts` step 10. One nullable column added to `pull_requests` caches the Walkthrough comment id. No prompt/tool-schema change — anchor parsing is server-side over the existing v3 freeform `location_hint`.

**Tech Stack:** NestJS 11, TypeScript 5, Drizzle ORM (SQLite), `better-sqlite3`, Octokit, Jest 29.

---

## Conventions used in every task

- **Run commands from `apps/api/`** unless stated otherwise.
- **Path alias `@/` resolves to `apps/api/src/`** (configured in `tsconfig.json` and Jest's `moduleNameMapper`).
- **Test file paths mirror `src/` exactly** under `apps/api/test/`. No exceptions.
- **Commit shape:** `feat(reviews): <subject>` or `feat(infra): <subject>` matching the conventional-commit style on existing commits. **Never add AI-attribution trailers** (`Co-Authored-By: Claude` etc.) — repo rule.
- **TDD per task:** write the failing test first, run it to see it fail with the expected message, implement the minimum to make it pass, run again to see it pass, commit.

---

## Task 1: `parse-location-hint` pure helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/parse-location-hint.ts`
- Test: `apps/api/test/modules/reviews/helpers/parse-location-hint.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts` (add export)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/modules/reviews/helpers/parse-location-hint.spec.ts`:

```ts
import { parseLocationHint } from '@/modules/reviews/helpers/parse-location-hint';

describe('parseLocationHint', () => {
  describe('null / empty input', () => {
    it('returns null for null', () => {
      expect(parseLocationHint(null)).toBeNull();
    });
    it('returns null for empty string', () => {
      expect(parseLocationHint('')).toBeNull();
    });
    it('returns null for whitespace-only string', () => {
      expect(parseLocationHint('   ')).toBeNull();
    });
  });

  describe('path-only (no line)', () => {
    it('parses "src/foo.ts" as path-only', () => {
      expect(parseLocationHint('src/foo.ts')).toEqual({
        path: 'src/foo.ts',
        startLine: null,
        endLine: null,
      });
    });
    it('trims whitespace around path-only', () => {
      expect(parseLocationHint('  src/foo.ts  ')).toEqual({
        path: 'src/foo.ts',
        startLine: null,
        endLine: null,
      });
    });
  });

  describe('single line', () => {
    it('parses "src/foo.ts:42"', () => {
      expect(parseLocationHint('src/foo.ts:42')).toEqual({
        path: 'src/foo.ts',
        startLine: 42,
        endLine: 42,
      });
    });
    it('parses single line at start of file', () => {
      expect(parseLocationHint('foo.ts:1')).toEqual({
        path: 'foo.ts',
        startLine: 1,
        endLine: 1,
      });
    });
  });

  describe('line range', () => {
    it('parses "src/foo.ts:42-50"', () => {
      expect(parseLocationHint('src/foo.ts:42-50')).toEqual({
        path: 'src/foo.ts',
        startLine: 42,
        endLine: 50,
      });
    });
    it('parses zero-width range "src/foo.ts:42-42" as single line', () => {
      expect(parseLocationHint('src/foo.ts:42-42')).toEqual({
        path: 'src/foo.ts',
        startLine: 42,
        endLine: 42,
      });
    });
    it('returns null when range is inverted (end < start)', () => {
      expect(parseLocationHint('src/foo.ts:50-42')).toBeNull();
    });
  });

  describe('comma list (first line is the anchor)', () => {
    it('parses "src/foo.ts:19,26" as anchor at line 19 only', () => {
      expect(parseLocationHint('src/foo.ts:19,26')).toEqual({
        path: 'src/foo.ts',
        startLine: 19,
        endLine: 19,
      });
    });
    it('parses "src/foo.ts:19,26,33" as anchor at line 19 only', () => {
      expect(parseLocationHint('src/foo.ts:19,26,33')).toEqual({
        path: 'src/foo.ts',
        startLine: 19,
        endLine: 19,
      });
    });
  });

  describe('malformed input', () => {
    it('returns null for "::" (no path)', () => {
      expect(parseLocationHint('::')).toBeNull();
    });
    it('returns null for non-numeric line "src/foo.ts:abc"', () => {
      expect(parseLocationHint('src/foo.ts:abc')).toBeNull();
    });
    it('returns null for negative line "src/foo.ts:-5"', () => {
      expect(parseLocationHint('src/foo.ts:-5')).toBeNull();
    });
    it('returns null for line 0 "src/foo.ts:0"', () => {
      expect(parseLocationHint('src/foo.ts:0')).toBeNull();
    });
  });

  describe('windows-style paths', () => {
    // Tolerated for forward-compatibility, but we split on the LAST
    // colon followed by digits so drive letters are preserved.
    it('parses "C:\\src\\foo.ts:42" keeping the drive letter', () => {
      expect(parseLocationHint('C:\\src\\foo.ts:42')).toEqual({
        path: 'C:\\src\\foo.ts',
        startLine: 42,
        endLine: 42,
      });
    });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=parse-location-hint
```

Expected: `FAIL`, error along the lines of `Cannot find module '@/modules/reviews/helpers/parse-location-hint'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/modules/reviews/helpers/parse-location-hint.ts`:

```ts
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
```

Add the export to `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
export * from './parse-location-hint';
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=parse-location-hint
```

Expected: `PASS`, all tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/parse-location-hint.ts \
        apps/api/src/modules/reviews/helpers/index.ts \
        apps/api/test/modules/reviews/helpers/parse-location-hint.spec.ts
git commit -m "feat(reviews): add parse-location-hint helper

Pure parser over Claude's freeform location_hint. Tolerant of the
four shapes seen in eval recordings: path-only, single line, range,
and comma list. Returns null for unparseable input — caller routes
to the outside-diff section."
```

---

## Task 2: `parse-diff-hunks` pure helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/parse-diff-hunks.ts`
- Test: `apps/api/test/modules/reviews/helpers/parse-diff-hunks.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/modules/reviews/helpers/parse-diff-hunks.spec.ts`:

```ts
import { parseDiffHunks } from '@/modules/reviews/helpers/parse-diff-hunks';

describe('parseDiffHunks', () => {
  it('returns empty map for empty diff', () => {
    expect(parseDiffHunks('')).toEqual(new Map());
  });

  it('parses a single-file single-hunk diff (RIGHT-side ranges only)', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,3 +10,4 @@',
      ' const x = 1;',
      '+const y = 2;',
      ' const z = 3;',
      ' export { x, y, z };',
    ].join('\n');

    const result = parseDiffHunks(diff);
    expect(result.get('src/foo.ts')).toEqual([
      { startLine: 10, endLine: 13 },
    ]);
  });

  it('parses a multi-file diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+line2',
      ' line3',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5,1 +5,2 @@',
      ' existing',
      '+added',
    ].join('\n');

    const result = parseDiffHunks(diff);
    expect(result.get('src/a.ts')).toEqual([{ startLine: 1, endLine: 3 }]);
    expect(result.get('src/b.ts')).toEqual([{ startLine: 5, endLine: 6 }]);
  });

  it('parses multiple hunks in a single file', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+addedA',
      ' line2',
      '@@ -10,2 +11,3 @@',
      ' line10',
      '+addedB',
      ' line11',
    ].join('\n');

    expect(parseDiffHunks(diff).get('src/foo.ts')).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 11, endLine: 13 },
    ]);
  });

  it('skips binary-file headers', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
    ].join('\n');

    const result = parseDiffHunks(diff);
    expect(result.has('img.png')).toBe(false);
    expect(result.get('src/foo.ts')).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it('handles new files (--- /dev/null)', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+line1',
      '+line2',
      '+line3',
    ].join('\n');

    expect(parseDiffHunks(diff).get('new.ts')).toEqual([
      { startLine: 1, endLine: 3 },
    ]);
  });

  it('omits deleted files (+++ /dev/null)', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n');

    const result = parseDiffHunks(diff);
    expect(result.has('gone.ts')).toBe(false);
  });

  it('hunk header with single-line range "@@ -X +Y @@" (count omitted)', () => {
    // git omits the count when it equals 1.
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new',
    ].join('\n');

    expect(parseDiffHunks(diff).get('foo.ts')).toEqual([
      { startLine: 5, endLine: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=parse-diff-hunks
```

Expected: `FAIL` with `Cannot find module '@/modules/reviews/helpers/parse-diff-hunks'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/modules/reviews/helpers/parse-diff-hunks.ts`:

```ts
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
```

Add export to `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
export * from './parse-diff-hunks';
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=parse-diff-hunks
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/parse-diff-hunks.ts \
        apps/api/src/modules/reviews/helpers/index.ts \
        apps/api/test/modules/reviews/helpers/parse-diff-hunks.spec.ts
git commit -m "feat(reviews): add parse-diff-hunks helper

Pure parser over the unified diff string we already fetch in step 5
of the worker. Returns RIGHT-side line ranges per file — the input
anchor-findings-to-diff needs to decide which findings can be
posted as inline comments vs. routed to the outside-diff section."
```

---

## Task 3: `anchor-findings-to-diff` pure helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/anchor-findings-to-diff.ts`
- Test: `apps/api/test/modules/reviews/helpers/anchor-findings-to-diff.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/modules/reviews/helpers/anchor-findings-to-diff.spec.ts`:

```ts
import {
  anchorFindingsToDiff,
  AnchorableFinding,
  OutsideDiffFinding,
} from '@/modules/reviews/helpers/anchor-findings-to-diff';
import type { FindingWithSeverity } from '@/modules/reviews/helpers/format-review-body';
import type { HunkRange } from '@/modules/reviews/helpers/parse-diff-hunks';

function f(
  overrides: Partial<FindingWithSeverity> = {},
): FindingWithSeverity {
  return {
    rule_id: 'rule.test',
    title: 't',
    message: 'm',
    severity: 'warning',
    location_hint: null,
    citation: null,
    ...overrides,
  };
}

function hunks(map: Record<string, HunkRange[]>): Map<string, HunkRange[]> {
  return new Map(Object.entries(map));
}

describe('anchorFindingsToDiff', () => {
  it('routes findings with null location_hint to outsideDiff', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: null })],
      diffHunks: hunks({}),
    });
    expect(result.anchorable).toHaveLength(0);
    expect(result.outsideDiff).toHaveLength(1);
    expect(result.outsideDiff[0].parsedAnchor).toBeNull();
  });

  it('routes findings with unparseable location_hint to outsideDiff', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'garbage:::' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(0);
    expect(result.outsideDiff).toHaveLength(1);
  });

  it('routes findings whose file is not in diffHunks to outsideDiff', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/other.ts:5' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(0);
    expect(result.outsideDiff).toHaveLength(1);
    expect(result.outsideDiff[0].parsedAnchor).toEqual({
      path: 'src/other.ts',
      startLine: 5,
      endLine: 5,
    });
  });

  it('anchors a single-line finding inside a hunk', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:5' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(1);
    expect(result.outsideDiff).toHaveLength(0);
    const a = result.anchorable[0] as AnchorableFinding;
    expect(a.path).toBe('src/foo.ts');
    expect(a.line).toBe(5);
    expect(a.startLine).toBeNull();
  });

  it('routes a single-line finding outside any hunk to outsideDiff', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:50' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(0);
    expect(result.outsideDiff).toHaveLength(1);
  });

  it('anchors a range finding that sits fully inside a hunk', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:3-7' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(1);
    const a = result.anchorable[0] as AnchorableFinding;
    expect(a.startLine).toBe(3);
    expect(a.line).toBe(7);
  });

  it('clamps the line of a range finding that partially overlaps the end of a hunk', () => {
    // hunk covers 1-10; finding is 7-15. Clamp line to 10, keep
    // startLine at 7.
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:7-15' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(1);
    const a = result.anchorable[0] as AnchorableFinding;
    expect(a.startLine).toBe(7);
    expect(a.line).toBe(10);
  });

  it('routes a range finding that is fully outside any hunk to outsideDiff', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:50-60' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(0);
    expect(result.outsideDiff).toHaveLength(1);
  });

  it('matches a multi-hunk file: a finding in hunk #2 anchors there', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:50' })],
      diffHunks: hunks({
        'src/foo.ts': [
          { startLine: 1, endLine: 10 },
          { startLine: 45, endLine: 55 },
        ],
      }),
    });
    expect(result.anchorable).toHaveLength(1);
    expect((result.anchorable[0] as AnchorableFinding).line).toBe(50);
  });

  it('routes a path-only finding (no line) to outsideDiff', () => {
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(0);
    expect(result.outsideDiff).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=anchor-findings-to-diff
```

Expected: `FAIL` with `Cannot find module '@/modules/reviews/helpers/anchor-findings-to-diff'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/modules/reviews/helpers/anchor-findings-to-diff.ts`:

```ts
import { parseLocationHint, ParsedAnchor } from './parse-location-hint';
import type { HunkRange } from './parse-diff-hunks';
import type { FindingWithSeverity } from './format-review-body';

// Partitions findings into:
//   anchorable    — has a parseable path:line(:end), file is in the
//                   diff, AND the line range intersects at least one
//                   hunk on that file. `line` is clamped to the
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
```

Add export to `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
export * from './anchor-findings-to-diff';
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=anchor-findings-to-diff
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/anchor-findings-to-diff.ts \
        apps/api/src/modules/reviews/helpers/index.ts \
        apps/api/test/modules/reviews/helpers/anchor-findings-to-diff.spec.ts
git commit -m "feat(reviews): add anchor-findings-to-diff helper

Pure partition over the parsed-anchor x diff-hunks join. Findings
whose file is changed AND whose line range intersects at least one
RIGHT-side hunk become anchorable; everything else routes to the
outside-diff section of the Walkthrough. Range findings that
straddle a hunk's end clamp line to the in-hunk max while keeping
the original start."
```

---

## Task 4: `format-inline-comment` pure helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/format-inline-comment.ts`
- Test: `apps/api/test/modules/reviews/helpers/format-inline-comment.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/modules/reviews/helpers/format-inline-comment.spec.ts`:

```ts
import { formatInlineCommentBody } from '@/modules/reviews/helpers/format-inline-comment';
import type { FindingWithSeverity } from '@/modules/reviews/helpers/format-review-body';

function f(overrides: Partial<FindingWithSeverity> = {}): FindingWithSeverity {
  return {
    rule_id: 'rule.eqeqeq',
    title: 'Use strict equality',
    message: 'Prefer `===` over `==`.',
    severity: 'warning',
    location_hint: 'src/foo.ts:3',
    citation: 'if (x == y)',
    ...overrides,
  };
}

const passthroughSanitize = (s: string) => s;

describe('formatInlineCommentBody', () => {
  it('renders error severity with 🛑 emoji prefix', () => {
    const body = formatInlineCommentBody({
      finding: f({ severity: 'error' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toMatch(/^🛑/);
  });

  it('renders warning severity with ⚠️ emoji prefix', () => {
    const body = formatInlineCommentBody({
      finding: f({ severity: 'warning' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toMatch(/^⚠️/);
  });

  it('renders info severity with 💡 emoji prefix', () => {
    const body = formatInlineCommentBody({
      finding: f({ severity: 'info' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toMatch(/^💡/);
  });

  it('includes the title on the first line after the emoji', () => {
    const body = formatInlineCommentBody({
      finding: f({ severity: 'warning', title: 'My specific title' }),
      sanitize: passthroughSanitize,
    });
    expect(body.split('\n')[0]).toContain('My specific title');
  });

  it('includes the message', () => {
    const body = formatInlineCommentBody({
      finding: f({ message: 'Some explanation.' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toContain('Some explanation.');
  });

  it('includes the rule_id under a "_Rule:_" line', () => {
    const body = formatInlineCommentBody({
      finding: f({ rule_id: 'rule.eqeqeq' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toContain('_Rule:_ `rule.eqeqeq`');
  });

  it('renders the citation in a fenced code block when present', () => {
    const body = formatInlineCommentBody({
      finding: f({ citation: 'if (x == y)' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toContain('```');
    expect(body).toContain('if (x == y)');
  });

  it('widens fence to 4 backticks if citation contains triple-backtick', () => {
    const body = formatInlineCommentBody({
      finding: f({ citation: 'code with ``` triple inside' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toContain('````');
  });

  it('omits the citation block when citation is null', () => {
    const body = formatInlineCommentBody({
      finding: f({ citation: null }),
      sanitize: passthroughSanitize,
    });
    expect(body).not.toContain('```');
    expect(body).toContain('_(no citation)_');
  });

  it('runs the title and message through the sanitizer', () => {
    const calls: string[] = [];
    const recordingSanitize = (s: string) => {
      calls.push(s);
      return s;
    };
    formatInlineCommentBody({
      finding: f({ title: 'T', message: 'M' }),
      sanitize: recordingSanitize,
    });
    expect(calls).toContain('T');
    expect(calls).toContain('M');
  });

  it('falls back to placeholder text when title or message is empty', () => {
    const body = formatInlineCommentBody({
      finding: f({ title: '', message: '' }),
      sanitize: passthroughSanitize,
    });
    expect(body).toContain('(untitled)');
    expect(body).toContain('_(no message)_');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=format-inline-comment
```

Expected: `FAIL` with `Cannot find module '@/modules/reviews/helpers/format-inline-comment'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/modules/reviews/helpers/format-inline-comment.ts`:

```ts
import type { FindingWithSeverity } from './format-review-body';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';

type SanitizeFn = (input: string) => string;

const SEVERITY_EMOJI: Record<FindingWithSeverity['severity'], string> = {
  error: '🛑',
  warning: '⚠️',
  info: '💡',
};

export interface FormatInlineCommentBodyInput {
  finding: FindingWithSeverity;
  // Tests inject a synchronous identity sanitizer to avoid booting
  // the ESM-only unified ecosystem under Jest's CJS runtime, matching
  // the existing format-review-body convention.
  sanitize?: SanitizeFn;
}

// Per-finding markdown body for a single inline review comment.
// Output shape:
//   {emoji} **{title}**
//
//   {message}
//
//   _Citation:_
//   ```
//   {citation}
//   ```
//   _Rule:_ `{rule_id}`
export function formatInlineCommentBody(
  input: FormatInlineCommentBodyInput,
): string {
  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;
  const f = input.finding;

  const emoji = SEVERITY_EMOJI[f.severity];
  const title = sanitize(f.title || '(untitled)');
  const message = sanitize(f.message || '_(no message)_');

  const citation = f.citation ?? '';
  const fence = citation.includes('```') ? '````' : '```';
  const citationBlock = citation
    ? `${fence}\n${citation}\n${fence}`
    : '_(no citation)_';

  return [
    `${emoji} **${title}**`,
    '',
    message,
    '',
    '_Citation:_',
    citationBlock,
    `_Rule:_ \`${f.rule_id}\``,
  ].join('\n');
}
```

Add export to `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
export * from './format-inline-comment';
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=format-inline-comment
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-inline-comment.ts \
        apps/api/src/modules/reviews/helpers/index.ts \
        apps/api/test/modules/reviews/helpers/format-inline-comment.spec.ts
git commit -m "feat(reviews): add format-inline-comment helper

Per-finding markdown for a single GitHub inline review comment.
Severity emoji prefix (error/warning/info → 🛑/⚠️/💡), title,
sanitized message, citation in a fenced code block (widened to 4
backticks if the citation itself contains a triple), and the rule
id on a trailing line. Sanitizer override mirrors the existing
format-review-body test pattern."
```

---

## Task 5: `format-walkthrough-body` pure helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/format-walkthrough-body.ts`
- Test: `apps/api/test/modules/reviews/helpers/format-walkthrough-body.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/modules/reviews/helpers/format-walkthrough-body.spec.ts`:

```ts
import { formatWalkthroughBody } from '@/modules/reviews/helpers/format-walkthrough-body';
import type { OutsideDiffFinding } from '@/modules/reviews/helpers/anchor-findings-to-diff';
import type { FindingWithSeverity } from '@/modules/reviews/helpers/format-review-body';

const VALID_UUID = '01234567-89ab-4cde-8fed-cba987654321';
const PR_NODE_ID = 'PR_kwDOABCDEFG';

function f(overrides: Partial<FindingWithSeverity> = {}): FindingWithSeverity {
  return {
    rule_id: 'rule.test',
    title: 'A finding',
    message: 'Some explanation.',
    severity: 'warning',
    location_hint: null,
    citation: null,
    ...overrides,
  };
}

function out(
  finding: FindingWithSeverity,
  parsed: OutsideDiffFinding['parsedAnchor'] = null,
): OutsideDiffFinding {
  return { finding, parsedAnchor: parsed };
}

const passthroughSanitize = (s: string) => s;

describe('formatWalkthroughBody', () => {
  describe('marker', () => {
    it('puts the v1 HTML walkthrough marker on line 1', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(body.split('\n')[0]).toBe(
        `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${PR_NODE_ID} -->`,
      );
    });

    it('throws when reviewId is not a canonical UUID', () => {
      expect(() =>
        formatWalkthroughBody({
          prNodeId: PR_NODE_ID,
          reviewId: 'not-a-uuid',
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          outsideDiff: [],
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });
  });

  describe('zero findings', () => {
    it('renders the no-findings line and omits the outside-diff section', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('No findings');
      expect(body).not.toContain('<details>');
      expect(body).not.toContain('Outside diff range');
    });
  });

  describe('counts table', () => {
    it('renders error/warning/info counts when non-zero', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 2, warning: 3, info: 1, total: 6 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('🛑');
      expect(body).toContain('2');
      expect(body).toContain('⚠️');
      expect(body).toContain('3');
      expect(body).toContain('💡');
      expect(body).toContain('1');
    });
  });

  describe('outside-diff section', () => {
    it('renders a collapsible <details> block with all outside-diff findings', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 2, info: 0, total: 2 },
        outsideDiff: [
          out(
            f({ title: 'First', message: 'm1' }),
            { path: 'src/a.ts', startLine: 5, endLine: 5 },
          ),
          out(f({ title: 'Second', message: 'm2', location_hint: null })),
        ],
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('<details>');
      expect(body).toContain('Outside diff range comments (2)');
      expect(body).toContain('First');
      expect(body).toContain('Second');
      // First has a parsed anchor — render its file:line hint.
      expect(body).toContain('src/a.ts:5');
    });
  });

  describe('marker keyed by prNodeId', () => {
    it('different prNodeId produces a different marker', () => {
      const a = formatWalkthroughBody({
        prNodeId: 'PR_A',
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      const b = formatWalkthroughBody({
        prNodeId: 'PR_B',
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(a.split('\n')[0]).not.toBe(b.split('\n')[0]);
    });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=format-walkthrough-body
```

Expected: `FAIL` with `Cannot find module '@/modules/reviews/helpers/format-walkthrough-body'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/modules/reviews/helpers/format-walkthrough-body.ts`:

```ts
import type { OutsideDiffFinding } from './anchor-findings-to-diff';
import type { FindingWithSeverity } from './format-review-body';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';

type SanitizeFn = (input: string) => string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FindingCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface FormatWalkthroughBodyInput {
  prNodeId: string;
  reviewId: string;
  counts: FindingCounts;
  outsideDiff: OutsideDiffFinding[];
  sanitize?: SanitizeFn;
}

export function formatWalkthroughBody(
  input: FormatWalkthroughBodyInput,
): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatWalkthroughBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }

  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;
  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const header = '**🤖 AI PR Review Copilot** — automated review (walkthrough)';
  const reviewMarker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  const lines: string[] = [marker, header, reviewMarker, ''];

  if (input.counts.total === 0) {
    lines.push('_No findings — the diff matched no team rules._');
    return lines.join('\n');
  }

  // Counts table.
  lines.push('| 🛑 errors | ⚠️ warnings | 💡 info |');
  lines.push('|---|---|---|');
  lines.push(
    `| ${input.counts.error} | ${input.counts.warning} | ${input.counts.info} |`,
  );

  if (input.outsideDiff.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(
      `<summary>⚠️ Outside diff range comments (${input.outsideDiff.length})</summary>`,
    );
    lines.push('');
    for (const od of input.outsideDiff) {
      lines.push(renderOutsideDiffEntry(od, sanitize));
      lines.push('');
    }
    lines.push('</details>');
  }

  return lines.join('\n');
}

function renderOutsideDiffEntry(
  entry: OutsideDiffFinding,
  sanitize: SanitizeFn,
): string {
  const f = entry.finding;
  const title = sanitize(f.title || '(untitled)');
  const message = sanitize(f.message || '_(no message)_');
  const where = entry.parsedAnchor
    ? entry.parsedAnchor.startLine !== null
      ? entry.parsedAnchor.endLine !== null &&
        entry.parsedAnchor.startLine !== entry.parsedAnchor.endLine
        ? `${entry.parsedAnchor.path}:${entry.parsedAnchor.startLine}-${entry.parsedAnchor.endLine}`
        : `${entry.parsedAnchor.path}:${entry.parsedAnchor.startLine}`
      : entry.parsedAnchor.path
    : f.location_hint ?? '(no location)';

  return [
    `**${title}** — \`${where}\``,
    '',
    message,
    `_Rule:_ \`${f.rule_id}\``,
  ].join('\n');
}
```

Add export to `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
export * from './format-walkthrough-body';
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=format-walkthrough-body
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-walkthrough-body.ts \
        apps/api/src/modules/reviews/helpers/index.ts \
        apps/api/test/modules/reviews/helpers/format-walkthrough-body.spec.ts
git commit -m "feat(reviews): add format-walkthrough-body helper

Builds the editable Walkthrough issue-comment markdown. Line 1 is
the v1 marker keyed by PR node id (the dedup anchor on re-review).
Counts table for non-empty runs. Outside-diff findings rendered in
a collapsible <details> block, each with its file:line and rule id.
UUID validation on the embedded review-id marker mirrors the
existing format-review-body guard."
```

---

## Task 6: Rewrite `format-review-body` to slim shape

**Files:**
- Modify: `apps/api/src/modules/reviews/helpers/format-review-body.ts`
- Modify: `apps/api/test/modules/reviews/helpers/format-review-body.spec.ts`

The existing `formatReviewBody` returns one big concatenated body. After this change it returns a slim body — header + UUID marker + counts + a pointer to the Walkthrough when there are outside-diff findings. The exported `FindingWithSeverity` type stays.

- [ ] **Step 1: Update the test to assert the new slim shape**

Replace the body of `apps/api/test/modules/reviews/helpers/format-review-body.spec.ts` with:

```ts
import {
  formatReviewBody,
  FindingWithSeverity,
} from '@/modules/reviews/helpers/format-review-body';

const VALID_UUID = '01234567-89ab-4cde-8fed-cba987654321';

const passthroughSanitize = (s: string) => s;

describe('formatReviewBody (slim shape)', () => {
  describe('reviewId UUID validation', () => {
    it('throws on a non-UUID reviewId', () => {
      expect(() =>
        formatReviewBody({
          reviewId: 'not-a-uuid',
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });

    it('throws on a UUID with an injected suffix', () => {
      expect(() =>
        formatReviewBody({
          reviewId: `${VALID_UUID} extra`,
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });

    it('accepts a canonical lowercase UUID', () => {
      expect(() =>
        formatReviewBody({
          reviewId: VALID_UUID,
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).not.toThrow();
    });

    it('accepts a canonical uppercase UUID', () => {
      expect(() =>
        formatReviewBody({
          reviewId: VALID_UUID.toUpperCase(),
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).not.toThrow();
    });
  });

  describe('header + marker', () => {
    it('puts the header on line 1 and the v1 review-id marker on line 2', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      const lines = body.split('\n');
      expect(lines[0]).toBe(
        '**🤖 AI PR Review Copilot** — automated review (Day 5)',
      );
      expect(lines[1]).toBe(
        `<!-- ai-pr-review-copilot:v1:review-id=${VALID_UUID} -->`,
      );
    });
  });

  describe('counts', () => {
    it('renders zero-findings line when total === 0', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('No findings');
    });

    it('renders counts when findings exist', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 1, warning: 2, info: 0, total: 3 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('🛑');
      expect(body).toContain('1');
      expect(body).toContain('⚠️');
      expect(body).toContain('2');
    });
  });

  describe('walkthrough pointer', () => {
    it('includes a pointer line when hasOutsideDiff is true', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 1, info: 0, total: 1 },
        hasOutsideDiff: true,
        sanitize: passthroughSanitize,
      });
      expect(body).toMatch(/Walkthrough/);
    });

    it('omits the pointer when hasOutsideDiff is false', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 1, info: 0, total: 1 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).not.toMatch(/Walkthrough/);
    });
  });

  describe('does NOT include per-finding blocks', () => {
    // Per-finding rendering moved to format-inline-comment and
    // format-walkthrough-body. The Review body itself is slim.
    it('does not call the sanitizer (no per-finding text in body)', () => {
      const calls: string[] = [];
      const recordingSanitize = (s: string) => {
        calls.push(s);
        return s;
      };
      formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 1, warning: 0, info: 0, total: 1 },
        hasOutsideDiff: false,
        sanitize: recordingSanitize,
      });
      expect(calls).toHaveLength(0);
    });
  });
});

// Re-export check — FindingWithSeverity is still the shared shape.
describe('FindingWithSeverity (type re-export)', () => {
  it('compiles', () => {
    const f: FindingWithSeverity = {
      rule_id: 'r',
      title: 't',
      message: 'm',
      severity: 'warning',
      location_hint: null,
      citation: null,
    };
    expect(f.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=format-review-body
```

Expected: `FAIL` — the existing `formatReviewBody` signature takes `findings`, not `counts` + `hasOutsideDiff`.

- [ ] **Step 3: Rewrite the implementation**

Replace the body of `apps/api/src/modules/reviews/helpers/format-review-body.ts` with:

```ts
import type { Finding } from '@/modules/reviews/types/llm-reviewer';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';

type SanitizeFn = (input: string) => string;

// Slim Review-with-inlines body. Per-finding rendering moved to
// format-inline-comment (anchorable findings) and
// format-walkthrough-body (outside-diff findings). The Review's
// body only carries the self-identifying header, the UUID marker,
// a counts row, and (when applicable) a pointer to the Walkthrough.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Severity-rich Finding shape. The processor narrows the raw Finding
// shape from the LLM reviewer into this by joining with the matched
// rule's metadata.
export interface FindingWithSeverity extends Finding {
  severity: 'error' | 'warning' | 'info';
}

export interface FindingCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface FormatReviewBodyInput {
  reviewId: string;
  counts: FindingCounts;
  hasOutsideDiff: boolean;
  // Sanitizer is plumbed in for symmetry with the other formatters
  // even though the slim body does not currently render any
  // user-controlled markdown — callers can keep passing it without
  // a code change if findings ever return to the body.
  sanitize?: SanitizeFn;
}

export function formatReviewBody(input: FormatReviewBodyInput): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatReviewBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  // sanitize is intentionally unused right now — keep the param for
  // symmetry. Reference it once to make tsc happy in strict mode.
  void (input.sanitize ?? sanitizeFindingMarkdown);

  const header = '**🤖 AI PR Review Copilot** — automated review (Day 5)';
  const marker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  const lines: string[] = [header, marker, ''];

  if (input.counts.total === 0) {
    lines.push('_No findings — the diff matched no team rules._');
    return lines.join('\n');
  }

  lines.push('| 🛑 errors | ⚠️ warnings | 💡 info |');
  lines.push('|---|---|---|');
  lines.push(
    `| ${input.counts.error} | ${input.counts.warning} | ${input.counts.info} |`,
  );

  if (input.hasOutsideDiff) {
    lines.push('');
    lines.push(
      '_See the Walkthrough comment above for findings outside this diff._',
    );
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=format-review-body
```

Expected: `PASS`.

- [ ] **Step 5: Confirm no other callers depend on the old signature**

```bash
grep -rn "formatReviewBody" apps/api/src apps/api/test
```

Expected: only `apps/api/src/modules/reviews/reviews.processor.ts` calls it (will be updated in Task 9). The helper's exported type `FindingWithSeverity` is also referenced — that survives the rewrite.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-review-body.ts \
        apps/api/test/modules/reviews/helpers/format-review-body.spec.ts
git commit -m "feat(reviews): rewrite format-review-body to slim shape

The Review's body now carries only header + UUID marker + counts +
a pointer to the Walkthrough when applicable. Per-finding rendering
moved to format-inline-comment and format-walkthrough-body. The
exported FindingWithSeverity type stays. Worker is updated in a
follow-up commit."
```

---

## Task 7: Schema column + Drizzle migration + repository methods

**Files:**
- Modify: `apps/api/src/infrastructure/db/schema/pull-requests.ts`
- Modify: `apps/api/src/modules/webhooks/types/pull-request.repository.ts`
- Modify: `apps/api/src/infrastructure/db/repositories/sqlite-pull-requests.repository.ts`
- Modify: `apps/api/test/infrastructure/db/repositories/sqlite-pull-requests.repository.spec.ts`
- Create: `apps/api/src/infrastructure/db/migrations/0005_add_walkthrough_comment_id_to_pull_requests.sql` (via drizzle-kit)

- [ ] **Step 1: Add the column to the schema**

Edit `apps/api/src/infrastructure/db/schema/pull-requests.ts`. Add the column inside the existing column object (after `raw_payload`):

```ts
    raw_payload: text('raw_payload').notNull(),
    walkthrough_comment_id: integer('walkthrough_comment_id'),
```

- [ ] **Step 2: Generate the migration**

```bash
cd apps/api && npx drizzle-kit generate --name=add_walkthrough_comment_id_to_pull_requests
```

Expected: a new file `apps/api/src/infrastructure/db/migrations/0005_add_walkthrough_comment_id_to_pull_requests.sql` is created. It should contain `ALTER TABLE pull_requests ADD COLUMN walkthrough_comment_id integer;`.

Verify the generated SQL:

```bash
cat apps/api/src/infrastructure/db/migrations/0005_add_walkthrough_comment_id_to_pull_requests.sql
```

If the generated file has any unrelated changes, **do NOT hand-edit** — instead, undo the column change, regenerate, and check the schema diff. The migration must contain only the ADD COLUMN statement.

- [ ] **Step 3: Add the failing tests for the new repository methods**

Append to `apps/api/test/infrastructure/db/repositories/sqlite-pull-requests.repository.spec.ts` (inside the existing `describe('SqlitePullRequestsRepository', ...)` block, before the closing `});`):

```ts
  describe('walkthrough_comment_id round-trip', () => {
    it('returns null when no walkthrough comment id has been set', () => {
      const pr = makePr();
      repo.save(pr);
      expect(repo.getWalkthroughCommentId(pr.node_id)).toBeNull();
    });

    it('round-trips a non-null id', () => {
      const pr = makePr();
      repo.save(pr);
      repo.setWalkthroughCommentId(pr.node_id, 123_456_789);
      expect(repo.getWalkthroughCommentId(pr.node_id)).toBe(123_456_789);
    });

    it('setting to null clears a previously set id', () => {
      const pr = makePr();
      repo.save(pr);
      repo.setWalkthroughCommentId(pr.node_id, 42);
      repo.setWalkthroughCommentId(pr.node_id, null);
      expect(repo.getWalkthroughCommentId(pr.node_id)).toBeNull();
    });

    it('does not clobber other PR columns when updating the id', () => {
      const pr = makePr({ title: 'Original' });
      repo.save(pr);
      repo.setWalkthroughCommentId(pr.node_id, 99);
      const found = repo.findByNodeId(pr.node_id);
      expect(found?.title).toBe('Original');
      expect(found?.walkthrough_comment_id).toBe(99);
    });

    it('throws when setting on a non-existent PR', () => {
      expect(() =>
        repo.setWalkthroughCommentId('PR_doesnotexist', 1),
      ).toThrow();
    });

    it('returns null for getWalkthroughCommentId on a non-existent PR', () => {
      expect(repo.getWalkthroughCommentId('PR_doesnotexist')).toBeNull();
    });
  });
```

Also extend the `makePr` factory to include the new column. Find this block near line 9:

```ts
function makePr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    node_id: 'PR_kwDOABCDEFG',
    repo_full_name: 'octocat/hello-world',
    number: 42,
    title: 'Add greetings',
    state: 'open',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    author_login: 'octocat',
    created_at: new Date('2026-05-25T10:00:00Z'),
    updated_at: new Date('2026-05-25T10:00:00Z'),
    raw_payload: JSON.stringify({ pull_request: { number: 42 } }),
    ...overrides,
  };
}
```

…and add `walkthrough_comment_id: null,` before the `...overrides` line:

```ts
    raw_payload: JSON.stringify({ pull_request: { number: 42 } }),
    walkthrough_comment_id: null,
    ...overrides,
  };
```

- [ ] **Step 4: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=sqlite-pull-requests.repository
```

Expected: FAIL with `repo.setWalkthroughCommentId is not a function`.

- [ ] **Step 5: Add the methods to the repository interface**

Edit `apps/api/src/modules/webhooks/types/pull-request.repository.ts`. Add to the `IPullRequestRepository` interface:

```ts
export interface IPullRequestRepository {
  save(pr: PullRequestRecord): void;
  findByNodeId(nodeId: string): PullRequestRecord | undefined;

  findRecentMatching(spec: ReviewFilterSpec, limit: number): PullRequestSummary[];

  // Walkthrough cache — one Walkthrough issue comment per PR over
  // its lifetime. The id is the GitHub-assigned comment id returned
  // by `issues.createComment`. setWalkthroughCommentId throws if the
  // PR row does not exist (the row is upserted on webhook ingestion
  // before any worker code runs, so a missing row is a programming
  // bug — fail loudly).
  setWalkthroughCommentId(prNodeId: string, id: number | null): void;
  getWalkthroughCommentId(prNodeId: string): number | null;
}
```

- [ ] **Step 6: Implement the methods on the SQLite repository**

Edit `apps/api/src/infrastructure/db/repositories/sqlite-pull-requests.repository.ts`. Add these two methods inside the class (after `findRecentMatching`):

```ts
  setWalkthroughCommentId(prNodeId: string, id: number | null): void {
    const result = this.db.drizzle
      .update(pullRequests)
      .set({ walkthrough_comment_id: id })
      .where(eq(pullRequests.node_id, prNodeId))
      .run();

    // better-sqlite3 exposes `changes` on the run result. Zero means
    // no row matched — fail loudly per the contract.
    if ((result as { changes?: number }).changes === 0) {
      throw new Error(
        `setWalkthroughCommentId: no pull_requests row matches node_id "${prNodeId}"`,
      );
    }
  }

  getWalkthroughCommentId(prNodeId: string): number | null {
    const row = this.db.drizzle
      .select({ id: pullRequests.walkthrough_comment_id })
      .from(pullRequests)
      .where(eq(pullRequests.node_id, prNodeId))
      .get();
    return row?.id ?? null;
  }
```

- [ ] **Step 7: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=sqlite-pull-requests.repository
```

Expected: `PASS`.

- [ ] **Step 8: Run the full test suite to verify nothing else broke**

```bash
npm test --workspace apps/api
```

Expected: all tests pass. The new column is nullable with no default; existing tests that build `PullRequestRecord` directly will need the field — the type now requires it. **If other test files break** with "Property 'walkthrough_comment_id' is missing in type", add `walkthrough_comment_id: null,` to the offending factories. Likely candidates: `apps/api/test/modules/dashboard/scripts/seed-dev.ts` and any other place a `PullRequestRecord` is constructed by hand.

```bash
grep -rn "PullRequestRecord" apps/api/test apps/api/src \
  | grep -v 'pull-request.types.ts' \
  | grep -v 'pull-request.repository.ts'
```

For each match, check if the file builds a `PullRequestRecord` literal. If yes, add the new field.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/infrastructure/db/schema/pull-requests.ts \
        apps/api/src/infrastructure/db/migrations/0005_add_walkthrough_comment_id_to_pull_requests.sql \
        apps/api/src/modules/webhooks/types/pull-request.repository.ts \
        apps/api/src/infrastructure/db/repositories/sqlite-pull-requests.repository.ts \
        apps/api/test/infrastructure/db/repositories/sqlite-pull-requests.repository.spec.ts
# Plus any test-factory updates from step 8.
git commit -m "feat(infra): add walkthrough_comment_id to pull_requests

One nullable column caches the GitHub comment id of the editable
Walkthrough issue comment, so re-reviews can PATCH it in place
instead of posting a new top-level comment per push. Drizzle
migration 0005. Repository gains setWalkthroughCommentId /
getWalkthroughCommentId; setter throws on a non-existent PR row
(the row is upserted on webhook ingestion before any worker code
runs)."
```

---

## Task 8: `find-walkthrough-comment-id` helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/find-walkthrough-comment-id.ts`
- Test: `apps/api/test/modules/reviews/helpers/find-walkthrough-comment-id.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/modules/reviews/helpers/find-walkthrough-comment-id.spec.ts`:

```ts
import { findWalkthroughCommentId } from '@/modules/reviews/helpers/find-walkthrough-comment-id';
import type { Octokit } from 'octokit';

function makeOctokit(listComments: jest.Mock): Octokit {
  return {
    rest: {
      issues: {
        listComments,
      },
    },
  } as unknown as Octokit;
}

const ARGS = {
  owner: 'octocat',
  repo: 'demo',
  pr_number: 7,
  pr_node_id: 'PR_node_test',
};

describe('findWalkthroughCommentId', () => {
  it('returns null when there are no comments', async () => {
    const list = jest.fn().mockResolvedValue({ data: [] });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBeNull();
    expect(list).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'demo',
      issue_number: 7,
      per_page: 100,
    });
  });

  it('returns the id of a comment whose body starts with the matching marker', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        { id: 1, body: '<!-- some other marker -->\n...' },
        {
          id: 2,
          body:
            '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->\nbody',
        },
        { id: 3, body: 'a plain comment' },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBe(2);
  });

  it('ignores a marker for a different PR node id', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        {
          id: 9,
          body:
            '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_OTHER -->\nbody',
        },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBeNull();
  });

  it('returns null when no body matches', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        { id: 1, body: 'one' },
        { id: 2, body: 'two' },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBeNull();
  });

  it('tolerates a comment with a null body', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        { id: 1, body: null },
        {
          id: 2,
          body:
            '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->\nbody',
        },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=find-walkthrough-comment-id
```

Expected: FAIL with `Cannot find module '@/modules/reviews/helpers/find-walkthrough-comment-id'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/modules/reviews/helpers/find-walkthrough-comment-id.ts`:

```ts
import type { Octokit } from 'octokit';

// Scan path for the Walkthrough comment id when our cache
// (pull_requests.walkthrough_comment_id) is empty. Reads the PR's
// issue comments and returns the first whose body starts with our
// v1 marker keyed by this PR's node id. Used in the worker step 10a
// before deciding whether to POST a new Walkthrough or PATCH the
// existing one.
//
// per_page=100 is the GitHub max — we don't paginate in v1 because
// any reasonable PR has well under 100 comments by the time the
// bot runs. If pagination becomes necessary later, scan in order
// (oldest first, GitHub's default) so the bot's earliest comment
// wins.

export interface FindWalkthroughCommentIdArgs {
  owner: string;
  repo: string;
  pr_number: number;
  pr_node_id: string;
}

export async function findWalkthroughCommentId(
  octokit: Octokit,
  args: FindWalkthroughCommentIdArgs,
): Promise<number | null> {
  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${args.pr_node_id} -->`;

  const res = await octokit.rest.issues.listComments({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.pr_number,
    per_page: 100,
  });

  const comments = (res.data ?? []) as Array<{
    id: number;
    body: string | null;
  }>;

  for (const c of comments) {
    if (typeof c.body === 'string' && c.body.startsWith(marker)) {
      return c.id;
    }
  }
  return null;
}
```

Add export to `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
export * from './find-walkthrough-comment-id';
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=find-walkthrough-comment-id
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/find-walkthrough-comment-id.ts \
        apps/api/src/modules/reviews/helpers/index.ts \
        apps/api/test/modules/reviews/helpers/find-walkthrough-comment-id.spec.ts
git commit -m "feat(reviews): add find-walkthrough-comment-id helper

Recovery path for the Walkthrough cache miss: scans the PR's issue
comments and returns the first whose body starts with our v1
marker keyed by this PR's node id. Used by the worker before
POSTing a new Walkthrough so a cleared cache (DB reset / redeploy)
adopts an existing comment instead of creating a duplicate."
```

---

## Task 9: Worker integration — happy paths

Refactor `reviews.processor.ts` step 9–10 to the new two-object pattern. Adds three test scenarios in one batch because they share the implementation surface: first run, second run, zero findings.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`
- Create: `apps/api/test/modules/reviews/reviews.processor.inline.spec.ts`

- [ ] **Step 1: Write the failing happy-path tests**

Create `apps/api/test/modules/reviews/reviews.processor.inline.spec.ts`:

```ts
import { ConfigService } from '@/config';
import { ReviewsProcessor } from '@/modules/reviews/reviews.processor';
import type { ReviewJobData } from '@/modules/reviews/types/review-queue';
import type { IGithubAuthProvider } from '@/modules/reviews/types/github-auth-provider';
import type { IReviewRepository } from '@/modules/reviews/types/review.repository';
import type { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
import type { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import type { ReviewsService } from '@/modules/reviews/reviews.service';
import type { Job } from 'bullmq';
import type { Octokit } from 'octokit';

const VALID_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,5 @@',
  ' const x = 1;',
  '+const y = 2;',
  '+const z = 3;',
  ' export { x };',
].join('\n');

function fmtFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    rule_id: 'rule.test',
    severity: 'warning' as const,
    title: 'A finding',
    message: 'An explanation.',
    location_hint: 'src/foo.ts:2',
    citation: 'const y = 2;',
    created_at: new Date(),
    ...overrides,
  };
}

interface StubOctokitParts {
  prsGet: jest.Mock;
  request: jest.Mock;
  createReview: jest.Mock;
  createComment: jest.Mock;
  updateComment: jest.Mock;
  listComments: jest.Mock;
}

function makeOctokit(parts: Partial<StubOctokitParts> = {}): {
  octokit: Octokit;
  parts: StubOctokitParts;
} {
  const full: StubOctokitParts = {
    prsGet:
      parts.prsGet ??
      jest.fn().mockResolvedValue({ data: { state: 'open' } }),
    request:
      parts.request ??
      jest.fn().mockResolvedValue({ data: VALID_DIFF }),
    createReview:
      parts.createReview ??
      jest
        .fn()
        .mockResolvedValue({ data: { html_url: 'https://example.test/r/1' } }),
    createComment:
      parts.createComment ??
      jest.fn().mockResolvedValue({ data: { id: 555 } }),
    updateComment:
      parts.updateComment ?? jest.fn().mockResolvedValue({ data: {} }),
    listComments:
      parts.listComments ?? jest.fn().mockResolvedValue({ data: [] }),
  };
  return {
    octokit: {
      rest: {
        pulls: {
          get: full.prsGet,
          createReview: full.createReview,
        },
        issues: {
          createComment: full.createComment,
          updateComment: full.updateComment,
          listComments: full.listComments,
        },
      },
      request: full.request,
    } as unknown as Octokit,
    parts: full,
  };
}

const baseData: ReviewJobData = {
  pr_node_id: 'PR_node_test',
  owner: 'octocat',
  repo: 'demo',
  pr_number: 7,
  head_sha: 'a'.repeat(40),
  installation_id: 12345,
};

function makeJob(data: ReviewJobData = baseData, id = 'bullmq-job-1') {
  return { id, data } as unknown as Job<ReviewJobData>;
}

function happyServiceResult(reviewId: string | undefined, findings: unknown[]) {
  return {
    review_id: reviewId ?? '01234567-89ab-4cde-8fed-cba987654321',
    status: 'completed' as const,
    findings,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    model: 'claude-haiku-4-5-20251001',
    prompt_version: 'v3',
    turn_count: 1,
    tool_calls: [],
  };
}

interface SetupOpts {
  octokitParts?: Partial<StubOctokitParts>;
  walkthroughCachedId?: number | null;
  findings?: unknown[];
}

function setup(opts: SetupOpts = {}) {
  const { octokit, parts } = makeOctokit(opts.octokitParts);

  const authProvider: IGithubAuthProvider = {
    forInstallation: jest.fn().mockReturnValue(octokit),
    invalidateInstallation: jest.fn(),
  };

  const runRealReview = jest.fn().mockImplementation(async (input: {
    reviewId?: string;
  }) =>
    happyServiceResult(input.reviewId, opts.findings ?? [fmtFinding()]),
  );

  const reviewsService = {
    runRealReview,
  } as unknown as ReviewsService;

  const reviewsRepo: IReviewRepository = {
    insert: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn().mockReturnValue([]),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
    markFailedIfInProgress: jest.fn().mockReturnValue(1),
    sweepStaleInProgress: jest.fn().mockReturnValue(0),
    findRecentInProgressForPr: jest.fn().mockReturnValue(undefined),
    findFiltered: jest.fn().mockReturnValue([]),
    countFiltered: jest.fn().mockReturnValue(0),
    findByIdWithFindings: jest.fn().mockReturnValue(null),
    aggregateByFilter: jest.fn().mockReturnValue({
      statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
      severityRollup: { error: 0, warning: 0, info: 0 },
      topRules: [],
      tokenTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      latency: { p50: null, p95: null },
    }),
    distinctRepos: jest.fn().mockReturnValue([]),
    distinctAuthors: jest.fn().mockReturnValue([]),
  };

  const findingsRepo: IReviewFindingRepository = {
    insertMany: jest.fn(),
    findByReviewId: jest.fn().mockReturnValue([]),
    findByPrNodeIdForPriorReview: jest.fn().mockReturnValue([]),
  };

  const getWalkthroughCommentId = jest
    .fn()
    .mockReturnValue(opts.walkthroughCachedId ?? null);
  const setWalkthroughCommentId = jest.fn();
  const pullRequestsRepo: IPullRequestRepository = {
    save: jest.fn(),
    findByNodeId: jest.fn(),
    findRecentMatching: jest.fn().mockReturnValue([]),
    getWalkthroughCommentId,
    setWalkthroughCommentId,
  };

  const config = new ConfigService();
  const processor = new ReviewsProcessor(
    authProvider,
    reviewsService,
    reviewsRepo,
    findingsRepo,
    pullRequestsRepo,
    config,
  );

  return {
    processor,
    octokit,
    parts,
    runRealReview,
    getWalkthroughCommentId,
    setWalkthroughCommentId,
    pullRequestsRepo,
    reviewsRepo,
  };
}

describe('ReviewsProcessor inline-comment flow', () => {
  describe('first run (no cached walkthrough)', () => {
    it('posts the walkthrough, then the inlined review with comments[]', async () => {
      const s = setup({ walkthroughCachedId: null });
      await s.processor.process(makeJob());

      // 1. Walkthrough scan happens first.
      expect(s.parts.listComments).toHaveBeenCalledTimes(1);
      // 2. Walkthrough POST fires (nothing matched the marker).
      expect(s.parts.createComment).toHaveBeenCalledTimes(1);
      const walkthroughArgs = s.parts.createComment.mock.calls[0][0];
      expect(walkthroughArgs.issue_number).toBe(7);
      expect(walkthroughArgs.body).toMatch(
        /^<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->/,
      );
      // 3. The comment id is cached.
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        555,
      );
      // 4. Inlined Review POST fires with comments[].
      expect(s.parts.createReview).toHaveBeenCalledTimes(1);
      const reviewArgs = s.parts.createReview.mock.calls[0][0];
      expect(reviewArgs.event).toBe('COMMENT');
      expect(reviewArgs.commit_id).toBeUndefined();
      expect(reviewArgs.body).toContain('ai-pr-review-copilot:v1:review-id=');
      expect(reviewArgs.comments).toHaveLength(1);
      expect(reviewArgs.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/foo.ts',
          line: 2,
          side: 'RIGHT',
        }),
      );
      expect(reviewArgs.request).toEqual({ retries: 0 });
    });
  });

  describe('second run (cached walkthrough)', () => {
    it('PATCHes the walkthrough in place, does not POST a new one', async () => {
      const s = setup({ walkthroughCachedId: 999 });
      await s.processor.process(makeJob());

      // listComments scan is skipped when the cache hits.
      expect(s.parts.listComments).not.toHaveBeenCalled();
      // createComment is NOT called.
      expect(s.parts.createComment).not.toHaveBeenCalled();
      // updateComment IS called.
      expect(s.parts.updateComment).toHaveBeenCalledTimes(1);
      expect(s.parts.updateComment.mock.calls[0][0]).toEqual(
        expect.objectContaining({ comment_id: 999 }),
      );
      // setWalkthroughCommentId is not called on the cached path
      // (id is already correct).
      expect(s.setWalkthroughCommentId).not.toHaveBeenCalled();
      // Inlined Review still posts.
      expect(s.parts.createReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('zero findings', () => {
    it('PATCHes the walkthrough only and skips the inlined Review POST', async () => {
      const s = setup({ walkthroughCachedId: 999, findings: [] });
      await s.processor.process(makeJob());

      expect(s.parts.updateComment).toHaveBeenCalledTimes(1);
      expect(s.parts.createReview).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test --workspace apps/api -- --testPathPattern=reviews.processor.inline
```

Expected: FAIL — `ReviewsProcessor` constructor does not accept `IPullRequestRepository`; `createComment` etc. are not called.

- [ ] **Step 3: Modify the processor — constructor + step 9 + step 10**

Edit `apps/api/src/modules/reviews/reviews.processor.ts`.

**3a. Add the new imports near the existing import block:**

```ts
import {
  anchorFindingsToDiff,
  findWalkthroughCommentId,
  formatInlineCommentBody,
  formatReviewBody,
  formatWalkthroughBody,
  parseDiffHunks,
  sanitizeFindingMarkdown,
  FindingWithSeverity,
} from './helpers';
import {
  IPullRequestRepository,
  PULL_REQUEST_REPOSITORY,
} from '@/modules/webhooks/types/pull-request.repository';
```

(Remove `formatReviewBody` / `FindingWithSeverity` / `sanitizeFindingMarkdown` from the existing helpers import block to avoid duplicates — combine into the import above.)

**3b. Add the new constructor parameter:**

Find the constructor (around line 107) and add `pullRequestsRepo` after `findingsRepo`:

```ts
  constructor(
    @Inject(GITHUB_AUTH_PROVIDER)
    private readonly githubAuth: IGithubAuthProvider,
    private readonly reviewsService: ReviewsService,
    @Inject(REVIEW_REPOSITORY)
    private readonly reviewsRepo: IReviewRepository,
    @Inject(REVIEW_FINDING_REPOSITORY)
    private readonly findingsRepo: IReviewFindingRepository,
    @Inject(PULL_REQUEST_REPOSITORY)
    private readonly pullRequestsRepo: IPullRequestRepository,
    private readonly config: ConfigService,
  ) {
    super();
  }
```

**3c. Replace step 9 + 10 (lines roughly 287–417).**

Locate the existing `try { ... } finally { ... }` block that starts after the `runRealReview` call. Replace its **try-block** body (from `this.logger.log(...findings_emitted...)` through to the closing of the inner createReview try/catch) with this new body:

```ts
    try {
      this.logger.log(
        `${jobLogPrefix} worker.review.findings_emitted count=${result.findings.length} review_id=${reviewId}`,
      );

      // UUID defense (unchanged).
      if (result.review_id !== reviewId || !UUID_RE.test(reviewId)) {
        this.logger.error(
          `${jobLogPrefix} worker.review.bad_uuid expected=${reviewId} got=${result.review_id}`,
        );
        this.reviewsRepo.markFailed(reviewId, {
          completed_at: new Date(),
          error_status: null,
          error_code: 'internal_error',
        });
        throw new UnrecoverableError(
          'runRealReview review_id did not match worker-allocated id',
        );
      }

      // Step 9 — parse and partition (pure, deterministic, no I/O).
      const sanitizedFindings: FindingWithSeverity[] = result.findings.map(
        (f) => ({
          rule_id: f.rule_id,
          title: f.title,
          message: f.message,
          location_hint: f.location_hint,
          citation: f.citation,
          severity: f.severity,
        }),
      );

      const diffHunks = parseDiffHunks(diff);
      const partition = anchorFindingsToDiff({
        findings: sanitizedFindings,
        diffHunks,
      });
      const counts = countBySeverity(sanitizedFindings);
      const hasOutsideDiff = partition.outsideDiff.length > 0;

      // Step 10a — upsert the Walkthrough.
      const walkthroughBody = formatWalkthroughBody({
        prNodeId: data.pr_node_id,
        reviewId,
        counts,
        outsideDiff: partition.outsideDiff,
      });

      const walkthroughPosted = await this.upsertWalkthrough({
        octokit,
        owner: data.owner,
        repo: data.repo,
        pr_number: data.pr_number,
        pr_node_id: data.pr_node_id,
        body: walkthroughBody,
      });

      // Step 10b — POST the inlined Review (skip on zero findings).
      let inlinePosted = false;
      if (sanitizedFindings.length > 0) {
        const reviewBody = formatReviewBody({
          reviewId,
          counts,
          hasOutsideDiff,
        });

        const inlineComments = partition.anchorable.map((a) => ({
          path: a.path,
          line: a.line,
          side: 'RIGHT' as const,
          ...(a.startLine !== null && a.startLine !== a.line
            ? { start_line: a.startLine, start_side: 'RIGHT' as const }
            : {}),
          body: formatInlineCommentBody({ finding: a.finding }),
        }));

        type CreateReviewParams = Parameters<
          typeof octokit.rest.pulls.createReview
        >[0];
        const createReviewArgs: CreateReviewParams & {
          request?: { retries?: number };
        } = {
          owner: data.owner,
          repo: data.repo,
          pull_number: data.pr_number,
          event: 'COMMENT',
          body: reviewBody,
          comments: inlineComments,
          request: { retries: 0 },
        };

        const posted = await octokit.rest.pulls.createReview(createReviewArgs);
        const url =
          (posted.data as { html_url?: string } | undefined)?.html_url ??
          '(no URL)';
        this.logger.log(
          `${jobLogPrefix} worker.review.posted url=${url} review_id=${reviewId}`,
        );
        inlinePosted = true;
      }

      this.logger.log(
        `${jobLogPrefix} worker.review.post_summary ` +
          `walkthrough.posted=${walkthroughPosted} ` +
          `inline_review.posted=${inlinePosted} ` +
          `anchorable_count=${partition.anchorable.length} ` +
          `outside_diff_count=${partition.outsideDiff.length}`,
      );
    } finally {
      this.activeReviewIds.delete(reviewId);
    }
```

**Note:** the old `try { ... } catch (err) { /* F5 422 closure / markFailed / UnrecoverableError */ }` block around the createReview is intentionally **not** preserved here — Task 10 adds it back as part of the failure-path implementation. After step 3 of this task the worker will throw if the inlined POST fails. That's acceptable for the happy-path scenarios; the failure tests in Task 10 will drive the recovery code back in.

**3d. Add the new private methods to the class** (before the `onApplicationShutdown` method):

```ts
  private async upsertWalkthrough(args: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pr_number: number;
    pr_node_id: string;
    body: string;
  }): Promise<'created' | 'patched'> {
    const { octokit, owner, repo, pr_number, pr_node_id, body } = args;

    const cachedId = this.pullRequestsRepo.getWalkthroughCommentId(pr_node_id);
    if (cachedId !== null) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: cachedId,
        body,
      });
      return 'patched';
    }

    const scanned = await findWalkthroughCommentId(octokit, {
      owner,
      repo,
      pr_number,
      pr_node_id,
    });
    if (scanned !== null) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: scanned,
        body,
      });
      this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, scanned);
      return 'patched';
    }

    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr_number,
      body,
    });
    const newId = (created.data as { id: number }).id;
    this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, newId);
    return 'created';
  }
```

Add a free function at the bottom of the file (next to the other module-private functions):

```ts
function countBySeverity(findings: { severity: 'error' | 'warning' | 'info' }[]) {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === 'error') error += 1;
    else if (f.severity === 'warning') warning += 1;
    else info += 1;
  }
  return { error, warning, info, total: error + warning + info };
}
```

Add the `Octokit` type import at the top of the file:

```ts
import type { Octokit } from 'octokit';
```

**3e. Wire `PULL_REQUEST_REPOSITORY` into the reviews module.**

Open `apps/api/src/modules/reviews/reviews.module.ts` and confirm it imports `DatabaseModule` (or whatever module provides `PULL_REQUEST_REPOSITORY`). The database module is `@Global()` per `CLAUDE.md` so no module-import change is typically needed — verify by running the existing module spec:

```bash
npm test --workspace apps/api -- --testPathPattern=reviews.module.spec
```

If this passes the wiring is good. If it fails with `Nest can't resolve dependencies of the ReviewsProcessor`, add `imports: [DatabaseModule]` to the `@Module` decorator in `reviews.module.ts`.

- [ ] **Step 4: Update the existing `reviews.processor.spec.ts` factory**

The existing happy-path spec at `apps/api/test/modules/reviews/reviews.processor.spec.ts` constructs the processor with 5 args. It now needs a 6th — the `pullRequestsRepo` stub. Open the spec and find `makeProcessor`. After the `findingsRepo` block, add:

```ts
  const pullRequestsRepo: IPullRequestRepository = {
    save: jest.fn(),
    findByNodeId: jest.fn(),
    findRecentMatching: jest.fn().mockReturnValue([]),
    getWalkthroughCommentId: jest.fn().mockReturnValue(null),
    setWalkthroughCommentId: jest.fn(),
  };
```

Add the import at the top:

```ts
import type { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
```

And update the `new ReviewsProcessor(...)` call to pass `pullRequestsRepo` after `findingsRepo`:

```ts
  const processor = new ReviewsProcessor(
    authProvider,
    reviewsService,
    reviewsRepo,
    findingsRepo,
    pullRequestsRepo,
    config,
  );
```

The existing assertions in that file check for the OLD body shape (`expect(reviewArgs.body).toContain('ai-pr-review-copilot:v1:review-id=')`). That contain-check still holds — the marker is still on the Review body. **But assertions like `body).toContain('Rule:')` or per-finding text need to move to the inline spec or be deleted.** Scan the file for assertions on review-body content other than the marker; relax or remove anything that references per-finding text. The integration spec (`reviews.processor.inline.spec.ts`) covers those.

If the existing spec exercises the post-failure path with explicit 422 / 5xx mocks, those assertions will fail until Task 10 lands. **Mark those tests with `.skip` in this commit and add a `// TODO Task 10: re-enable when failure paths land` comment.** They will be re-enabled in Task 10.

- [ ] **Step 5: Run the inline spec and verify it passes**

```bash
npm test --workspace apps/api -- --testPathPattern=reviews.processor
```

Expected: all three new scenarios in `reviews.processor.inline.spec.ts` pass; the existing `reviews.processor.spec.ts` passes with relaxed assertions and any failure-path tests skipped.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts \
        apps/api/src/modules/reviews/reviews.module.ts \
        apps/api/test/modules/reviews/reviews.processor.spec.ts \
        apps/api/test/modules/reviews/reviews.processor.inline.spec.ts
git commit -m "feat(reviews): worker posts walkthrough + inlined review

Replaces the single concatenated review-body POST with the
two-object pattern. Step 9 partitions findings via the new pure
helpers (parse, anchor, classify). Step 10a upserts a Walkthrough
issue comment via the cached comment_id, recovering via a marker
scan when the cache is empty. Step 10b POSTs the inlined Review
with one comments[] entry per anchorable finding, body slim.
Failure paths (PATCH 404 recovery, inline 422, walkthrough retry)
land in the next commit."
```

---

## Task 10: Worker integration — failure paths + telemetry

Adds the four failure scenarios + the structured telemetry log.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`
- Modify: `apps/api/test/modules/reviews/reviews.processor.inline.spec.ts`
- Modify: `apps/api/test/modules/reviews/reviews.processor.spec.ts` (re-enable the previously skipped tests)

- [ ] **Step 1: Write the failing failure-path tests**

Append to `apps/api/test/modules/reviews/reviews.processor.inline.spec.ts` (before the last closing `});` of the outer describe):

```ts
  describe('walkthrough POST/PATCH failure paths', () => {
    it('PATCH 404 → clears cache and falls through to scan/POST', async () => {
      const update404 = jest
        .fn()
        .mockRejectedValueOnce({ status: 404, message: 'Not Found' });
      const scanned = jest.fn().mockResolvedValue({ data: [] }); // empty scan
      const created = jest.fn().mockResolvedValue({ data: { id: 777 } });

      const s = setup({
        walkthroughCachedId: 999,
        octokitParts: {
          updateComment: update404,
          listComments: scanned,
          createComment: created,
        },
      });
      await s.processor.process(makeJob());

      expect(update404).toHaveBeenCalledTimes(1);
      expect(scanned).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledTimes(1);
      // Cache cleared then set to the new id.
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        null,
      );
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        777,
      );
    });

    it('empty cache + scan finds existing comment → PATCH (adopt) instead of POST', async () => {
      const scanned = jest.fn().mockResolvedValue({
        data: [
          {
            id: 333,
            body:
              '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->\n...',
          },
        ],
      });
      const update = jest.fn().mockResolvedValue({ data: {} });
      const created = jest.fn();

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: {
          listComments: scanned,
          updateComment: update,
          createComment: created,
        },
      });
      await s.processor.process(makeJob());

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 333 }),
      );
      expect(created).not.toHaveBeenCalled();
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        333,
      );
    });

    it('walkthrough POST 502 → retried once, then succeeds', async () => {
      const create502 = jest
        .fn()
        .mockRejectedValueOnce({ status: 502, message: 'Bad Gateway' })
        .mockResolvedValueOnce({ data: { id: 888 } });

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: { createComment: create502 },
      });
      await s.processor.process(makeJob());

      expect(create502).toHaveBeenCalledTimes(2);
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        888,
      );
      expect(s.parts.createReview).toHaveBeenCalledTimes(1);
    });

    it('walkthrough POST fails twice → review row marked comment_post_failed', async () => {
      const create502 = jest
        .fn()
        .mockRejectedValue({ status: 502, message: 'Bad Gateway' });

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: { createComment: create502 },
      });

      await expect(s.processor.process(makeJob())).rejects.toBeDefined();

      expect(create502).toHaveBeenCalledTimes(2);
      // Inlined Review POST is NOT attempted when the Walkthrough
      // ultimately fails.
      expect(s.parts.createReview).not.toHaveBeenCalled();
      expect(s.reviewsRepo.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error_code: 'comment_post_failed',
          error_status: 502,
        }),
      );
    });
  });

  describe('inlined Review POST failure paths', () => {
    it('createReview 422 → review row marked inline_post_failed, walkthrough already up', async () => {
      const create422 = jest
        .fn()
        .mockRejectedValue({ status: 422, message: 'Unprocessable' });

      // Make the PR-state recheck return 'open' so the 422 is NOT
      // reclassified as pr_closed_during_review.
      const prsGet = jest
        .fn()
        .mockResolvedValueOnce({ data: { state: 'open' } }) // step 4
        .mockResolvedValueOnce({ data: { state: 'open' } }); // F5 recheck

      const s = setup({
        walkthroughCachedId: 999,
        octokitParts: { createReview: create422, prsGet },
      });

      await expect(s.processor.process(makeJob())).rejects.toBeDefined();

      // Walkthrough patched first.
      expect(s.parts.updateComment).toHaveBeenCalledTimes(1);
      // Inline POST attempted exactly once (retries: 0).
      expect(create422).toHaveBeenCalledTimes(1);
      // Row marked with the new error_code.
      expect(s.reviewsRepo.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error_code: 'inline_post_failed',
          error_status: 422,
        }),
      );
    });

    it('createReview 422 → PR closed mid-flight reclassifies as pr_closed_during_review', async () => {
      const create422 = jest
        .fn()
        .mockRejectedValue({ status: 422, message: 'Unprocessable' });
      const prsGet = jest
        .fn()
        .mockResolvedValueOnce({ data: { state: 'open' } })
        .mockResolvedValueOnce({ data: { state: 'closed' } });

      const s = setup({
        walkthroughCachedId: 999,
        octokitParts: { createReview: create422, prsGet },
      });

      await expect(s.processor.process(makeJob())).rejects.toBeDefined();
      expect(s.reviewsRepo.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error_code: 'pr_closed_during_review',
        }),
      );
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npm test --workspace apps/api -- --testPathPattern=reviews.processor.inline
```

Expected: the new scenarios FAIL because the worker currently throws on the first PATCH/POST failure and does not retry.

- [ ] **Step 3: Implement the failure-path code in the worker**

Edit `apps/api/src/modules/reviews/reviews.processor.ts`.

**3a.** Replace the `upsertWalkthrough` method with this version that wraps both POST and PATCH in single-retry blocks and handles 404-on-PATCH as a recovery path:

```ts
  private async upsertWalkthrough(args: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pr_number: number;
    pr_node_id: string;
    body: string;
  }): Promise<'created' | 'patched'> {
    const { octokit, owner, repo, pr_number, pr_node_id, body } = args;

    const cachedId = this.pullRequestsRepo.getWalkthroughCommentId(pr_node_id);
    if (cachedId !== null) {
      try {
        await this.callWithOneRetry(() =>
          octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: cachedId,
            body,
          }),
        );
        return 'patched';
      } catch (err) {
        if (readStatus(err) === 404) {
          // Comment manually deleted — clear cache and fall through
          // to scan/POST below.
          this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, null);
        } else {
          throw err;
        }
      }
    }

    const scanned = await findWalkthroughCommentId(octokit, {
      owner,
      repo,
      pr_number,
      pr_node_id,
    });
    if (scanned !== null) {
      await this.callWithOneRetry(() =>
        octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: scanned,
          body,
        }),
      );
      this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, scanned);
      return 'patched';
    }

    const created = await this.callWithOneRetry(() =>
      octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pr_number,
        body,
      }),
    );
    const newId = (created.data as { id: number }).id;
    this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, newId);
    return 'created';
  }

  // One-retry wrapper for the walkthrough POST/PATCH calls. The
  // request itself goes through @octokit/plugin-retry, but we keep
  // retries: 0 there and do the single application-level retry here
  // so the behavior is explicit and testable.
  private async callWithOneRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const status = readStatus(err);
      if (status === 404) {
        // 404 is signalled to the caller (cache-clear recovery).
        throw err;
      }
      // One-second backoff between attempts.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await fn();
    }
  }
```

**3b.** Wrap step 10a + 10b in a try/catch that distinguishes the two failure surfaces. Replace the `try { ... happy-path body ... } finally { ... }` block (the one updated in Task 9 step 3c) with this version:

```ts
    try {
      this.logger.log(
        `${jobLogPrefix} worker.review.findings_emitted count=${result.findings.length} review_id=${reviewId}`,
      );

      if (result.review_id !== reviewId || !UUID_RE.test(reviewId)) {
        this.logger.error(
          `${jobLogPrefix} worker.review.bad_uuid expected=${reviewId} got=${result.review_id}`,
        );
        this.reviewsRepo.markFailed(reviewId, {
          completed_at: new Date(),
          error_status: null,
          error_code: 'internal_error',
        });
        throw new UnrecoverableError(
          'runRealReview review_id did not match worker-allocated id',
        );
      }

      const sanitizedFindings: FindingWithSeverity[] = result.findings.map(
        (f) => ({
          rule_id: f.rule_id,
          title: f.title,
          message: f.message,
          location_hint: f.location_hint,
          citation: f.citation,
          severity: f.severity,
        }),
      );

      const diffHunks = parseDiffHunks(diff);
      const partition = anchorFindingsToDiff({
        findings: sanitizedFindings,
        diffHunks,
      });
      const counts = countBySeverity(sanitizedFindings);
      const hasOutsideDiff = partition.outsideDiff.length > 0;

      const walkthroughBody = formatWalkthroughBody({
        prNodeId: data.pr_node_id,
        reviewId,
        counts,
        outsideDiff: partition.outsideDiff,
      });

      // Step 10a — Walkthrough upsert. Failure here is terminal.
      let walkthroughPosted: 'created' | 'patched';
      try {
        walkthroughPosted = await this.upsertWalkthrough({
          octokit,
          owner: data.owner,
          repo: data.repo,
          pr_number: data.pr_number,
          pr_node_id: data.pr_node_id,
          body: walkthroughBody,
        });
      } catch (err) {
        const status = readStatus(err);
        this.logger.warn(
          `${jobLogPrefix} worker.walkthrough.post_failed status=${status} ${formatBriefError(err)}`,
        );
        this.reviewsRepo.markFailed(reviewId, {
          completed_at: new Date(),
          error_status: status,
          error_code: 'comment_post_failed',
        });
        throw new UnrecoverableError(formatBriefError(err));
      }

      // Step 10b — inlined Review (skip on zero findings).
      let inlinePosted = false;
      if (sanitizedFindings.length > 0) {
        const reviewBody = formatReviewBody({
          reviewId,
          counts,
          hasOutsideDiff,
        });

        const inlineComments = partition.anchorable.map((a) => ({
          path: a.path,
          line: a.line,
          side: 'RIGHT' as const,
          ...(a.startLine !== null && a.startLine !== a.line
            ? { start_line: a.startLine, start_side: 'RIGHT' as const }
            : {}),
          body: formatInlineCommentBody({ finding: a.finding }),
        }));

        type CreateReviewParams = Parameters<
          typeof octokit.rest.pulls.createReview
        >[0];
        const createReviewArgs: CreateReviewParams & {
          request?: { retries?: number };
        } = {
          owner: data.owner,
          repo: data.repo,
          pull_number: data.pr_number,
          event: 'COMMENT',
          body: reviewBody,
          comments: inlineComments,
          request: { retries: 0 },
        };

        try {
          const posted =
            await octokit.rest.pulls.createReview(createReviewArgs);
          const url =
            (posted.data as { html_url?: string } | undefined)?.html_url ??
            '(no URL)';
          this.logger.log(
            `${jobLogPrefix} worker.review.posted url=${url} review_id=${reviewId}`,
          );
          inlinePosted = true;
        } catch (err) {
          const status = readStatus(err);
          this.logger.warn(
            `${jobLogPrefix} worker.review.post_failed status=${status} ${formatBriefError(err)}`,
          );

          // F5 closure preserved: on 422, recheck PR state.
          let errorCode = 'inline_post_failed';
          if (status === 422) {
            try {
              const recheck = await octokit.rest.pulls.get({
                owner: data.owner,
                repo: data.repo,
                pull_number: data.pr_number,
              });
              const currentState = (recheck.data as { state?: string }).state;
              if (currentState !== 'open') {
                errorCode = 'pr_closed_during_review';
                this.logger.warn(
                  `${jobLogPrefix} worker.review.post_failed pr_state=${currentState} — reclassified as pr_closed_during_review`,
                );
              }
            } catch (recheckErr) {
              this.logger.warn(
                `${jobLogPrefix} worker.review.post_recheck_failed ${formatBriefError(recheckErr)}`,
              );
            }
          }

          this.reviewsRepo.markFailed(reviewId, {
            completed_at: new Date(),
            error_status: status,
            error_code: errorCode,
          });
          throw new UnrecoverableError(formatBriefError(err));
        }
      }

      this.logger.log(
        `${jobLogPrefix} worker.review.post_summary ` +
          `walkthrough.posted=${walkthroughPosted} ` +
          `inline_review.posted=${inlinePosted} ` +
          `anchorable_count=${partition.anchorable.length} ` +
          `outside_diff_count=${partition.outsideDiff.length}`,
      );
    } finally {
      this.activeReviewIds.delete(reviewId);
    }
```

- [ ] **Step 4: Run the failure-path tests and verify they pass**

```bash
npm test --workspace apps/api -- --testPathPattern=reviews.processor.inline
```

Expected: all scenarios (happy + failure) pass.

- [ ] **Step 5: Re-enable any tests in the old `reviews.processor.spec.ts` that were skipped in Task 9 step 4**

Remove the `.skip` markers and the `// TODO Task 10` comments. Update assertions if they referenced the old `error_code: 'comment_post_failed'` for the inline failure — that error code now belongs to the Walkthrough failure path; the inline POST uses `inline_post_failed`.

- [ ] **Step 6: Run the full apps/api test suite**

```bash
npm test --workspace apps/api
```

Expected: all suites pass. If a spec elsewhere builds a `PullRequestRecord` without the new column, fix per Task 7 step 8.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts \
        apps/api/test/modules/reviews/reviews.processor.inline.spec.ts \
        apps/api/test/modules/reviews/reviews.processor.spec.ts
git commit -m "feat(reviews): worker failure paths + telemetry

Walkthrough POST/PATCH retries once with one-second backoff before
marking the row comment_post_failed (existing error_code).
Inlined Review POST is non-retryable per Day-5's F3 closure — on
failure the row is marked inline_post_failed (new error_code), or
pr_closed_during_review when the F5 422 recheck shows the PR
closed mid-flight. PATCH 404 on a cached comment_id clears the
cache and falls through to scan/POST. Structured post_summary log
line emits walkthrough.posted, inline_review.posted,
anchorable_count, outside_diff_count for the eval extension."
```

---

## Task 11: Final verification + open PR

- [ ] **Step 1: Run the full test suite from the repo root**

```bash
npm test --workspaces --if-present
```

Expected: every workspace test suite passes (apps/api: 56+ suites including the new ones; apps/web has no tests today).

- [ ] **Step 2: Build apps/api**

```bash
npm run build --workspace apps/api
```

Expected: `nest build` succeeds with no TypeScript errors.

- [ ] **Step 3: Build apps/web (sanity — should be unaffected)**

If a `next dev` server is running on port 4000, kill it first (project memory: `next-dev-vs-build-conflict`):

```bash
lsof -i :4000 -t | xargs kill 2>/dev/null
rm -rf apps/web/.next
npm run build --workspace apps/web
```

Expected: production build clean.

- [ ] **Step 4: Run the em-dash gate (CI gate added in PR #8)**

```bash
npm run check:copy --workspace apps/web
```

Expected: exit 0.

- [ ] **Step 5: `npm audit`**

```bash
npm audit
```

Expected: 0 vulnerabilities (state after #9 and #10 merged).

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/inline-pr-review-comments
```

- [ ] **Step 7: Open the PR**

```bash
gh pr create --base main --title "feat(reviews): inline PR review comments" --body "$(cat <<'EOF'
## Summary

Replaces today's single concatenated review comment with two timeline objects per review run:
- An **editable Walkthrough issue comment**, PATCH-edited in place across re-reviews via a v1 HTML marker keyed by PR node id. Holds counts and any findings whose anchor falls outside the diff.
- An **inlined Review** (`pulls.createReview`) whose `comments[]` array anchors each finding to its `file:line`. `event: COMMENT`, `commit_id` omitted, body slim.

Anchor parsing is server-side over the existing v3 freeform `location_hint` — no `PROMPT_AND_TOOL_VERSION` bump, no eval fixture re-record.

Design spec: `docs/plans/09-inline-pr-review-comments.md`.

## What changed

- **6 new pure-function helpers** under `apps/api/src/modules/reviews/helpers/` (parse-location-hint, parse-diff-hunks, anchor-findings-to-diff, format-inline-comment, format-walkthrough-body, find-walkthrough-comment-id).
- **`format-review-body` rewritten** to the slim shape (header + UUID marker + counts + Walkthrough pointer).
- **One nullable column** `walkthrough_comment_id` on `pull_requests` (Drizzle migration `0005`) caches the comment id for in-place PATCH.
- **Worker step 9–10 refactored** in `reviews.processor.ts` into parse → partition → upsertWalkthrough → POST inlined Review, with the Walkthrough as the failure-floor.
- **New error_code** `inline_post_failed` (sibling to `comment_post_failed`).
- **Structured `post_summary` log line** per review with walkthrough.posted, inline_review.posted, anchorable_count, outside_diff_count.

## Test plan

- [ ] CI green on this branch
- [ ] Manual smoke against a multi-file PR on the test repo: confirm Walkthrough appears once and gets PATCH-edited on the second push; confirm each anchorable finding appears as an inline thread; confirm an out-of-diff finding lands in the Walkthrough's `<details>` section
- [ ] Verify the cached `walkthrough_comment_id` survives a worker restart
EOF
)"
```

- [ ] **Step 8: Watch CI and respond to feedback**

```bash
gh pr checks
```

Iterate on any failures until green.

---

## Self-review checklist (run after writing the plan)

Performed before publishing the plan; documented here for completeness.

- ✅ **Spec coverage:**
  - 6 helper components in spec → Tasks 1–6 and 8.
  - Schema column + migration + repo methods → Task 7.
  - Worker integration → Tasks 9–10.
  - Telemetry log line → Task 10.
  - Error handling matrix (Walkthrough fail, inline 422, PATCH 404, scan-and-adopt, unparseable hint, empty diff) → Tasks 9 + 10.
  - Eval-harness extension noted as out of scope per spec → not a task.
- ✅ **No placeholders:** every code block contains actual code; every test contains real assertions; every commit message is finalised.
- ✅ **Type consistency:**
  - `ParsedAnchor` / `AnchorableFinding` / `OutsideDiffFinding` / `FindingWithSeverity` referenced consistently across Tasks 1–6.
  - `IPullRequestRepository.setWalkthroughCommentId(prNodeId, id)` signature matches in interface (Task 7 step 5), implementation (Task 7 step 6), spec (Task 7 step 3), and worker callers (Tasks 9 + 10).
  - Helper names match exports (`parseLocationHint`, `parseDiffHunks`, `anchorFindingsToDiff`, `formatInlineCommentBody`, `formatWalkthroughBody`, `formatReviewBody`, `findWalkthroughCommentId`).

---

## Execution

After approval of this plan, implementation runs task-by-task from Task 1 through Task 11. Each task is independently committable; the branch `feat/inline-pr-review-comments` collects them all and the PR in Task 11 squash-merges to main.
