import { countChangedLines } from '@/modules/reviews/helpers/count-changed-lines';

describe('countChangedLines', () => {
  it('returns 0 for an empty string', () => {
    expect(countChangedLines('')).toBe(0);
  });

  it('returns 0 when the diff has no +/- content lines', () => {
    const diff = [
      'diff --git a/x.js b/x.js',
      'index aaa..bbb 100644',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,3 +1,3 @@',
      ' context line',
      ' another context',
      ' third context',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(0);
  });

  it('counts added lines (+ prefix)', () => {
    const diff = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,1 +1,4 @@',
      ' context',
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(3);
  });

  it('counts removed lines (- prefix)', () => {
    const diff = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,4 +1,1 @@',
      '-const a = 1;',
      '-const b = 2;',
      '-const c = 3;',
      ' context',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(3);
  });

  it('counts both added and removed lines together', () => {
    const diff = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,3 +1,3 @@',
      '-let x = 1;',
      '+var x = 1;',
      ' context',
      '-let y = 2;',
      '+var y = 2;',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(4);
  });

  it('excludes the +++/--- file headers from the count', () => {
    const diff = [
      'diff --git a/x.js b/x.js',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    // Only the -x and +y count, NOT the --- a/x.js and +++ b/x.js headers.
    expect(countChangedLines(diff)).toBe(2);
  });

  it('excludes hunk headers (@@) from the count', () => {
    const diff = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,1 +1,1 @@',
      '+x',
      '@@ -10,1 +10,1 @@',
      '+y',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(2);
  });

  it('sums across multiple files in a single diff', () => {
    const diff = [
      'diff --git a/x.js b/x.js',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
      'diff --git a/y.js b/y.js',
      '--- a/y.js',
      '+++ b/y.js',
      '@@ -1,2 +1,1 @@',
      '-c',
      ' d',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(2);
  });

  it('ignores the "\\ No newline at end of file" marker line', () => {
    const diff = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(2);
  });

  it('handles CRLF line endings', () => {
    const diff = ['--- a/x.js', '+++ b/x.js', '@@ -1,1 +1,1 @@', '+a', '-b'].join('\r\n');
    expect(countChangedLines(diff)).toBe(2);
  });
});
