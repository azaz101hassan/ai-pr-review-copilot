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
