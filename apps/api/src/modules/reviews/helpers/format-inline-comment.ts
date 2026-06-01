import type { FindingWithSeverity } from './format-review-body';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';

type SanitizeFn = (input: string) => string;

const SEVERITY_EMOJI: Record<FindingWithSeverity['severity'], string> = {
  error: '🛑',
  warning: '⚠️',
  info: '💡',
};

export interface FormatInlineCommentBodyInput {
  finding: FindingWithSeverity;
  // Tests inject a synchronous identity sanitizer to avoid booting
  // the ESM-only unified ecosystem under Jest's CJS runtime, matching
  // the existing format-review-body convention.
  sanitize?: SanitizeFn;
}

// Per-finding markdown body for a single inline review comment.
// Output shape:
//   {emoji} **{title}**
//
//   {message}
//
//   _Citation:_
//   ```
//   {citation}
//   ```
//   _Rule:_ `{rule_id}`
export function formatInlineCommentBody(
  input: FormatInlineCommentBodyInput,
): string {
  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;
  const f = input.finding;

  const emoji = SEVERITY_EMOJI[f.severity];
  const title = sanitize(f.title || '(untitled)');
  const message = sanitize(f.message || '_(no message)_');

  const citation = f.citation ?? '';
  const fence = citation.includes('```') ? '````' : '```';
  const citationBlock = citation
    ? `${fence}\n${citation}\n${fence}`
    : '_(no citation)_';

  return [
    `${emoji} **${title}**`,
    '',
    message,
    '',
    '_Citation:_',
    citationBlock,
    `_Rule:_ \`${f.rule_id}\``,
  ].join('\n');
}
