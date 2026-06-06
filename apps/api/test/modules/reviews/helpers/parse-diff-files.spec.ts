import { parseDiffFiles } from '@/modules/reviews/helpers/parse-diff-files';

describe('parseDiffFiles', () => {
  it('returns added/removed counts per file from a unified diff', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
diff --git a/src/b.ts b/src/b.ts
index aaaa..bbbb 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,1 @@
 kept
-removed
`;
    expect(parseDiffFiles(diff)).toEqual([
      { path: 'src/a.ts', added: 1, removed: 0 },
      { path: 'src/b.ts', added: 0, removed: 1 },
    ]);
  });

  it('ignores hunk headers (@@) and file mode/diff header lines', () => {
    const diff = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1,2 @@
 a
+b
`;
    expect(parseDiffFiles(diff)).toEqual([{ path: 'x', added: 1, removed: 0 }]);
  });

  it('marks binary files with added=0 removed=0 and the path', () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
    expect(parseDiffFiles(diff)).toEqual([
      { path: 'img.png', added: 0, removed: 0, binary: true },
    ]);
  });

  it('returns an empty array for an empty diff', () => {
    expect(parseDiffFiles('')).toEqual([]);
  });
});
