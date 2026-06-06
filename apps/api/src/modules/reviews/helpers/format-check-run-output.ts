import type { FindingCounts } from './finding-counts.types';

// {title, summary} pair for the GitHub Check Run's `output` block.
// One discriminated union per lifecycle state; the worker calls
// this for both the POST (in-progress) and the PATCH (terminal).

export type FormatCheckRunOutputInput =
  | { mode: 'in-progress' }
  | { mode: 'skipped'; changedLines: number; limit: number }
  | { mode: 'failed'; reasonCopy: string }
  | { mode: 'empty-diff' }
  | {
      mode: 'success';
      findingsCount: number;
      retrievedRulesCount: number;
      walkthroughCommentUrl: string;
      counts?: FindingCounts;
    };

export interface CheckRunOutput {
  title: string;
  summary: string;
}

export function formatCheckRunOutput(
  input: FormatCheckRunOutputInput,
): CheckRunOutput {
  switch (input.mode) {
    case 'in-progress':
      return {
        title: 'Reviewing against your knowledge base',
        summary:
          "Checking this diff against your team's knowledge base. Usually 30-90 seconds on small PRs.",
      };
    case 'skipped':
      return {
        title: 'Review skipped — diff exceeds size limit',
        summary: `This PR has ${input.changedLines} changed lines, above the configured limit of ${input.limit}.`,
      };
    case 'failed':
      return {
        title: 'Review could not complete',
        summary: `${input.reasonCopy}. See the walkthrough comment for details.`,
      };
    case 'empty-diff':
      return {
        title: 'No diff to review',
        summary: 'The PR has no reviewable diff content.',
      };
    case 'success': {
      if (input.findingsCount === 0) {
        return {
          title: 'No findings — your knowledge base was consulted',
          summary: `Top ${input.retrievedRulesCount} rules retrieved; none matched. ${input.walkthroughCommentUrl}`,
        };
      }
      const counts = input.counts;
      const rollup = counts
        ? `${counts.error}E / ${counts.warning}W / ${counts.info}I. `
        : '';
      return {
        title: `${input.findingsCount} findings against your knowledge base`,
        summary: `${rollup}This check is informational and does not block merges. ${input.walkthroughCommentUrl}`,
      };
    }
  }
}
