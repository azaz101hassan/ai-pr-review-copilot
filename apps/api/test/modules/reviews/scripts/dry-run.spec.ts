import { parseArgs, formatFindings } from '@/modules/reviews/scripts/dry-run';
import type { ReviewFindingRecord } from '@/modules/reviews/types/review-finding.types';

// Smoke test for parseArgs + the output formatter. The full
// integration (Nest bootstrap + Anthropic call) is covered by the
// gated integration spec; this file owns the pure
// shape/parsing/formatting concerns.

function arg(...argv: string[]): string[] {
  // process.argv-shaped — first two slots are node + script path.
  return ['node', 'dry-run.ts', ...argv];
}

function makeFinding(
  overrides: Partial<ReviewFindingRecord> = {},
): ReviewFindingRecord {
  return {
    id: 'f1',
    review_id: 'r1',
    rule_id: 'no-var',
    severity: 'warning',
    title: 'Use let/const',
    message: 'Replace `var` with `let` or `const`.',
    location_hint: 'src/x.js:1',
    citation: null,
    created_at: new Date('2026-05-28T10:00:00Z'),
    ...overrides,
  } as ReviewFindingRecord;
}

describe('parseArgs', () => {
  it('parses a bare patch path', () => {
    const result = parseArgs(arg('fixture.patch'));
    expect(result.patchPath).toBe('fixture.patch');
    expect(result.k).toBeUndefined();
    expect(result.repoDir).toBeUndefined();
  });

  it('parses --k=<n>', () => {
    const result = parseArgs(arg('fixture.patch', '--k=5'));
    expect(result.patchPath).toBe('fixture.patch');
    expect(result.k).toBe(5);
    expect(result.repoDir).toBeUndefined();
  });

  it('parses --repo=<dir>', () => {
    const result = parseArgs(arg('fixture.patch', '--repo=./fixture.repo'));
    expect(result.patchPath).toBe('fixture.patch');
    expect(result.repoDir).toBe('./fixture.repo');
    expect(result.k).toBeUndefined();
  });

  it('composes --k=<n> and --repo=<dir>', () => {
    const result = parseArgs(
      arg('fixture.patch', '--k=5', '--repo=./fixture.repo'),
    );
    expect(result).toEqual({
      patchPath: 'fixture.patch',
      k: 5,
      repoDir: './fixture.repo',
    });
  });

  it('accepts --repo and --k in any order', () => {
    const result = parseArgs(
      arg('--repo=./r', 'fixture.patch', '--k=3'),
    );
    expect(result.patchPath).toBe('fixture.patch');
    expect(result.k).toBe(3);
    expect(result.repoDir).toBe('./r');
  });

  it('rejects --repo= with empty value', () => {
    expect(() => parseArgs(arg('fixture.patch', '--repo='))).toThrow(
      /non-empty path/,
    );
  });

  it('rejects an invalid --k value', () => {
    expect(() => parseArgs(arg('fixture.patch', '--k=abc'))).toThrow(/--k/);
    expect(() => parseArgs(arg('fixture.patch', '--k=0'))).toThrow(/--k/);
    expect(() => parseArgs(arg('fixture.patch', '--k=101'))).toThrow(/--k/);
  });

  it('--help short-circuits and exits 0 (no patch-file required)', () => {
    // Stub process.exit so it doesn't kill the test runner.
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    parseArgs(arg('--help'));

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('rejects an unexpected second positional argument', () => {
    expect(() =>
      parseArgs(arg('fixture.patch', 'second-positional.patch')),
    ).toThrow(/Unexpected positional/);
  });
});

describe('formatFindings', () => {
  it('reports "No violations found." on empty findings', () => {
    const output = formatFindings({ findings: [] });
    expect(output).toBe('No violations found.');
  });

  it('renders a single finding as a one-row tabular print', () => {
    const output = formatFindings({
      findings: [makeFinding()],
    });
    expect(output).toContain('sev');
    expect(output).toContain('rule_id');
    expect(output).toContain('no-var');
  });

  it('renders multiple findings as a numbered list grouped by severity (highest first)', () => {
    const findings = [
      makeFinding({
        id: 'a',
        severity: 'warning',
        rule_id: 'rule-w',
        title: 'warning rule',
        message: 'fix me',
        location_hint: 'src/b.js:3',
      }),
      makeFinding({
        id: 'b',
        severity: 'error',
        rule_id: 'rule-e',
        title: 'error rule',
        message: 'fix me now',
        location_hint: 'src/a.js:5',
      }),
      makeFinding({
        id: 'c',
        severity: 'info',
        rule_id: 'rule-i',
        title: 'info rule',
        message: 'fyi',
        location_hint: 'src/c.js:1',
      }),
    ];

    const output = formatFindings({ findings });
    const lines = output.split('\n');
    // Highest severity (error) first.
    expect(lines[0]).toContain('[error]');
    expect(lines[0]).toContain('rule-e');
    // Numbered list — first entry is " 1."
    expect(lines[0].trimStart()).toMatch(/^1\./);
  });

  it('within the same severity, sorts by location_hint', () => {
    const findings = [
      makeFinding({ id: 'a', severity: 'warning', location_hint: 'src/z.js:1', rule_id: 'r-z' }),
      makeFinding({ id: 'b', severity: 'warning', location_hint: 'src/a.js:1', rule_id: 'r-a' }),
    ];
    const output = formatFindings({ findings });
    const lines = output.split('\n');
    // First entry should be `src/a.js:1` (lexicographic).
    expect(lines[0]).toContain('src/a.js:1');
    expect(lines[0]).toContain('r-a');
  });

  it('handles up to 10 findings without crashing (the emit_finding cap)', () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding({
        id: `f-${i}`,
        rule_id: `rule-${i}`,
        title: `Title ${i}`,
        message: `Message ${i}`,
        location_hint: `src/file-${i}.js:${i + 1}`,
      }),
    );
    const output = formatFindings({ findings });
    // Each finding renders as a header line + a message line (2 lines).
    for (let i = 0; i < 10; i++) {
      expect(output).toContain(`rule-${i}`);
      expect(output).toContain(`Message ${i}`);
    }
    // Numbered prefix on the first entry.
    expect(output).toMatch(/^\s*1\./);
  });

  it('omits "@ location" when location_hint is null', () => {
    const findings = [
      makeFinding({ severity: 'error', location_hint: null, rule_id: 'r-1' }),
      makeFinding({ severity: 'warning', location_hint: null, rule_id: 'r-2' }),
    ];
    const output = formatFindings({ findings });
    expect(output).not.toContain('@ ');
  });
});
