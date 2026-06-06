import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';
import type { FindingWithSeverity } from './format-review-body';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SanitizeFn = (input: string) => string;

const SEVERITY_EMOJI: Record<FindingWithSeverity['severity'], string> = {
  error: '🛑',
  warning: '⚠️',
  info: '💡',
};

export interface FormatWalkthroughSuccessBodyInput {
  prNodeId: string;
  reviewId: string;
  retrievedRulesCount: number;
  firingRules: Array<{
    rule_id: string;
    source: string;
    title: string;
    severity: FindingWithSeverity['severity'];
  }>;
  intro: string | null;
  missingChecksPermission?: boolean;
  sanitize?: SanitizeFn;
}

const TITLE_MAX = 80;

export function formatWalkthroughSuccessBody(
  input: FormatWalkthroughSuccessBodyInput,
): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatWalkthroughSuccessBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  if (!input.prNodeId) {
    throw new Error('formatWalkthroughSuccessBody: prNodeId is required.');
  }

  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;

  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=success -->`;
  const reviewMarker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;
  const header = '**AI PR Review Copilot** — review complete';

  const lines: string[] = [
    marker,
    header,
    modeMarker,
    reviewMarker,
    '',
    `> Reviewed against your team's knowledge base — top **${input.retrievedRulesCount}** rules retrieved for this diff.`,
  ];

  if (input.intro) {
    lines.push('', '### Summary', '', sanitize(input.intro));
  }

  if (input.firingRules.length > 0) {
    lines.push('', '<details>', `<summary>\u{1F4DA} Rules cited (${input.firingRules.length})</summary>`, '');
    const grouped = groupBySource(input.firingRules);
    for (const [source, rules] of grouped) {
      lines.push(`**From \`${source}\`**`);
      for (const rule of rules) {
        const emoji = SEVERITY_EMOJI[rule.severity];
        const safeTitle = sanitize(rule.title).slice(0, TITLE_MAX);
        lines.push(`- ${emoji} \`${rule.rule_id}\` — ${safeTitle}`);
      }
      lines.push('');
    }
    lines.push('</details>');
  }

  lines.push('', '_See the review below for the per-line findings and severity rollup._');

  if (input.missingChecksPermission) {
    lines.push(
      '',
      '> _The merge-box status badge is unavailable until your repo admin accepts this app\'s new "Checks" permission at [github.com/settings/installations](https://github.com/settings/installations)._',
    );
  }

  return lines.join('\n');
}

function groupBySource(
  rules: FormatWalkthroughSuccessBodyInput['firingRules'],
): Map<string, FormatWalkthroughSuccessBodyInput['firingRules']> {
  const out = new Map<string, FormatWalkthroughSuccessBodyInput['firingRules']>();
  for (const rule of rules) {
    const list = out.get(rule.source);
    if (list) list.push(rule);
    else out.set(rule.source, [rule]);
  }
  return out;
}
