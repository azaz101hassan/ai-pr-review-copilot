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

  it('handles CRLF line endings', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+added',
      ' line2',
    ].join('\r\n');
    expect(parseDiffHunks(diff).get('src/foo.ts')).toEqual([
      { startLine: 1, endLine: 3 },
    ]);
  });

  it('resets currentFile on diff --git boundary (mode-only change followed by real diff)', () => {
    // The mode-only diff has no +++ line. Without a reset, a stray
    // hunk-shaped string in its body would be attributed to the
    // previous file. The reset makes the parser ignore anything
    // between the new `diff --git` and the next `+++` header.
    const diff = [
      'diff --git a/first.ts b/first.ts',
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
      'diff --git a/mode-only.sh b/mode-only.sh',
      'old mode 100644',
      'new mode 100755',
      // The next line LOOKS like a hunk header but is not preceded by
      // a +++ — it should be ignored, not attributed to first.ts.
      '@@ -99,99 +99,99 @@ stray context',
      'diff --git a/second.ts b/second.ts',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -5,1 +5,2 @@',
      ' a',
      '+b',
    ].join('\n');
    const result = parseDiffHunks(diff);
    expect(result.get('first.ts')).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(result.get('second.ts')).toEqual([{ startLine: 5, endLine: 6 }]);
    // No stray hunk attributed to first.ts.
  });
});
