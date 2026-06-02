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
