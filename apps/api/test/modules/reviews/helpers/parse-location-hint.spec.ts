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
    it('returns null for trailing colon "src/foo.ts:"', () => {
      expect(parseLocationHint('src/foo.ts:')).toBeNull();
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
