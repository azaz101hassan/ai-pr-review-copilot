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

  it('clamps the startLine of a range finding that partially overlaps the start of a hunk', () => {
    // hunk covers 3-10; finding is 1-5. Clamp startLine up to 3
    // (the hunk's start) so the inline comment is valid for
    // GitHub's API.
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:1-5' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 3, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(1);
    const a = result.anchorable[0] as AnchorableFinding;
    expect(a.startLine).toBe(3);
    expect(a.line).toBe(5);
  });

  it('collapses to a single-line comment when the clamped range is one line', () => {
    // hunk covers 1-10; finding is 10-15 (starts at the last hunk
    // line and extends past it). Clamped line = 10, effective
    // start = max(10, 1) = 10. Since they are equal, emit a
    // single-line comment (startLine: null), not a malformed
    // multi-line one.
    const result = anchorFindingsToDiff({
      findings: [f({ location_hint: 'src/foo.ts:10-15' })],
      diffHunks: hunks({ 'src/foo.ts': [{ startLine: 1, endLine: 10 }] }),
    });
    expect(result.anchorable).toHaveLength(1);
    const a = result.anchorable[0] as AnchorableFinding;
    expect(a.startLine).toBeNull();
    expect(a.line).toBe(10);
  });
});
