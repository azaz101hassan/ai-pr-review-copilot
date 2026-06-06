import { formatCheckRunOutput } from '@/modules/reviews/helpers/format-check-run-output';

describe('formatCheckRunOutput', () => {
  it('in_progress: title carries the KB tagline', () => {
    const out = formatCheckRunOutput({ mode: 'in-progress' });
    expect(out.title).toMatch(/Reviewing against your knowledge base/);
    expect(out.summary).toMatch(/Usually 30-90 seconds/);
  });

  it('skipped: title indicates size limit', () => {
    const out = formatCheckRunOutput({ mode: 'skipped', changedLines: 1000, limit: 300 });
    expect(out.title).toMatch(/Review skipped — diff exceeds size limit/);
    expect(out.summary).toMatch(/1000 changed lines/);
  });

  it('failed: title and summary reflect the reason copy', () => {
    const out = formatCheckRunOutput({ mode: 'failed', reasonCopy: 'the language-model call was rejected' });
    expect(out.title).toMatch(/Review could not complete/);
    expect(out.summary).toMatch(/the language-model call was rejected/);
  });

  it('success 0 findings: title + walkthrough URL in summary', () => {
    const out = formatCheckRunOutput({
      mode: 'success',
      findingsCount: 0,
      retrievedRulesCount: 40,
      walkthroughCommentUrl: 'https://github.com/o/r/pull/1#issuecomment-9',
    });
    expect(out.title).toMatch(/No findings — your knowledge base was consulted/);
    expect(out.summary).toContain('https://github.com/o/r/pull/1#issuecomment-9');
  });

  it('success N findings: title cites the count + informational disclaimer in summary', () => {
    const out = formatCheckRunOutput({
      mode: 'success',
      findingsCount: 3,
      counts: { error: 1, warning: 2, info: 0, total: 3 },
      retrievedRulesCount: 40,
      walkthroughCommentUrl: 'https://example.com',
    });
    expect(out.title).toMatch(/3 findings against your knowledge base/);
    expect(out.summary).toMatch(/1E \/ 2W \/ 0I/);
    expect(out.summary).toMatch(/informational and does not block merges/);
  });

  it('empty-diff: title indicates no diff to review', () => {
    const out = formatCheckRunOutput({ mode: 'empty-diff' });
    expect(out.title).toMatch(/No diff to review/);
  });

  it('success N findings without counts: omits the rollup, no "undefined" leaks', () => {
    const out = formatCheckRunOutput({
      mode: 'success',
      findingsCount: 3,
      retrievedRulesCount: 40,
      walkthroughCommentUrl: 'https://example.com',
    });
    expect(out.title).toMatch(/3 findings against your knowledge base/);
    expect(out.summary).not.toMatch(/undefined/);
    expect(out.summary).toMatch(
      /^This check is informational and does not block merges\. https:\/\/example\.com$/,
    );
  });
});
