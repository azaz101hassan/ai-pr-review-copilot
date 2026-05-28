import {
  formatReviewBody,
  FindingWithSeverity,
} from '@/modules/reviews/helpers/format-review-body';

const VALID_UUID = '01234567-89ab-4cde-8fed-cba987654321';

function f(
  overrides: Partial<FindingWithSeverity> = {},
): FindingWithSeverity {
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

// Inject a synchronous identity-style sanitize that preserves input
// — lets us assert raw input survives without relying on the unified
// pipeline's behavior. The production path runs the real sanitizer
// (covered when the Vitest migration replaces this scaffolding).
const passthroughSanitize = (s: string) => s;

describe('formatReviewBody', () => {
  describe('reviewId UUID validation', () => {
    it('throws on a non-UUID reviewId', () => {
      expect(() =>
        formatReviewBody({
          findings: [],
          reviewId: 'not-a-uuid',
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });

    it('throws on a UUID with an injected suffix', () => {
      expect(() =>
        formatReviewBody({
          findings: [],
          reviewId: `${VALID_UUID} extra`,
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });

    it('accepts a canonical lowercase UUID', () => {
      expect(() =>
        formatReviewBody({
          findings: [],
          reviewId: VALID_UUID,
          sanitize: passthroughSanitize,
        }),
      ).not.toThrow();
    });

    it('accepts a canonical uppercase UUID', () => {
      expect(() =>
        formatReviewBody({
          findings: [],
          reviewId: VALID_UUID.toUpperCase(),
          sanitize: passthroughSanitize,
        }),
      ).not.toThrow();
    });
  });

  describe('header + marker', () => {
    it('puts the self-identifying header on line 1 and the marker on line 2', () => {
      const body = formatReviewBody({
        findings: [],
        reviewId: VALID_UUID,
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

    it('matches the marker regex shape exactly', () => {
      const body = formatReviewBody({
        findings: [],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      const markerRe =
        /<!-- ai-pr-review-copilot:v1:review-id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} -->/i;
      expect(body).toMatch(markerRe);
    });
  });

  describe('empty findings', () => {
    it('renders a no-findings notice instead of a finding list', () => {
      const body = formatReviewBody({
        findings: [],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('No findings');
    });
  });

  describe('severity ordering', () => {
    it('orders error → warning → info', () => {
      const body = formatReviewBody({
        findings: [
          f({ severity: 'info', title: 'Info finding' }),
          f({ severity: 'error', title: 'Error finding' }),
          f({ severity: 'warning', title: 'Warning finding' }),
        ],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      const idxError = body.indexOf('Error finding');
      const idxWarning = body.indexOf('Warning finding');
      const idxInfo = body.indexOf('Info finding');
      expect(idxError).toBeGreaterThan(-1);
      expect(idxWarning).toBeGreaterThan(idxError);
      expect(idxInfo).toBeGreaterThan(idxWarning);
    });

    it('preserves emit order within the same severity (stable sort)', () => {
      const body = formatReviewBody({
        findings: [
          f({ severity: 'warning', title: 'first warning' }),
          f({ severity: 'warning', title: 'second warning' }),
          f({ severity: 'warning', title: 'third warning' }),
        ],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body.indexOf('first warning')).toBeLessThan(
        body.indexOf('second warning'),
      );
      expect(body.indexOf('second warning')).toBeLessThan(
        body.indexOf('third warning'),
      );
    });
  });

  describe('per-finding rendering', () => {
    it('renders severity tag, title, message, citation, rule_id', () => {
      const body = formatReviewBody({
        findings: [
          f({
            severity: 'error',
            title: 'Disallow var',
            message: 'Use let or const.',
            citation: 'var x = 1;',
            rule_id: 'no-var',
          }),
        ],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('**[error]**');
      expect(body).toContain('Disallow var');
      expect(body).toContain('Use let or const.');
      expect(body).toContain('var x = 1;');
      expect(body).toContain('_Rule:_ `no-var`');
    });

    it('wraps citations in a triple-backtick fence by default', () => {
      const body = formatReviewBody({
        findings: [f({ citation: 'plain citation' })],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('```\nplain citation\n```');
    });

    it('widens to four backticks when the citation contains a triple-backtick', () => {
      const body = formatReviewBody({
        findings: [
          f({
            citation: 'inside\n```js\nconsole.log(1)\n```\nback',
          }),
        ],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toMatch(/````\n/);
      expect(body).toContain('```js');
    });

    it('renders a placeholder when citation is null', () => {
      const body = formatReviewBody({
        findings: [f({ citation: null })],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('_(no citation)_');
    });

    it('falls back to _(no message)_ for empty messages', () => {
      const body = formatReviewBody({
        findings: [f({ message: '' })],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('_(no message)_');
    });

    it('falls back to (untitled) for empty titles', () => {
      const body = formatReviewBody({
        findings: [f({ title: '' })],
        reviewId: VALID_UUID,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('(untitled)');
    });
  });

  describe('sanitizer wiring', () => {
    it('passes title and message through the sanitizer (called twice per finding)', () => {
      const sanitize = jest.fn((s: string) => `S<${s}>S`);
      const body = formatReviewBody({
        findings: [
          f({ title: 'TITLE', message: 'BODY' }),
          f({ title: 'TITLE2', message: 'BODY2' }),
        ],
        reviewId: VALID_UUID,
        sanitize,
      });
      // title + message per finding → 4 calls total.
      expect(sanitize).toHaveBeenCalledTimes(4);
      expect(body).toContain('S<TITLE>S');
      expect(body).toContain('S<BODY2>S');
    });

    it('does NOT sanitize the citation (preserves verbatim inside fenced code)', () => {
      const sanitize = jest.fn((s: string) => `IGNORE_${s}`);
      const body = formatReviewBody({
        findings: [f({ citation: 'raw <html> & **bold**' })],
        reviewId: VALID_UUID,
        sanitize,
      });
      expect(body).toContain('raw <html> & **bold**');
      // The citation never appeared as a sanitize argument.
      for (const call of sanitize.mock.calls) {
        expect(call[0]).not.toContain('raw <html>');
      }
    });
  });
});
