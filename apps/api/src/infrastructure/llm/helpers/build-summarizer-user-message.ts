import type { WalkthroughSummarizerInput } from '@/modules/reviews/types/walkthrough-summarizer';

// Caps the number of retrieved rules included in the user message to
// avoid a pathological retrieval count blowing out the prompt size.
const MAX_RULES_IN_PROMPT = 20;

export function buildSummarizerUserMessage(
  input: WalkthroughSummarizerInput,
): string {
  const findingsBlock =
    input.findings.length === 0
      ? 'Findings: none.'
      : `Findings (${input.findings.length}):\n${input.findings
          .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.title}`)
          .join('\n')}`;
  const totalRules = input.retrievedRules.length;
  const shownRules = Math.min(totalRules, MAX_RULES_IN_PROMPT);
  const rulesHeader =
    totalRules === 0
      ? null
      : totalRules > MAX_RULES_IN_PROMPT
        ? `Rules retrieved (showing first ${shownRules} of ${totalRules}):`
        : `Rules retrieved (${totalRules}):`;
  const rulesBlock =
    totalRules === 0
      ? 'Rules retrieved: none.'
      : `${rulesHeader}\n${input.retrievedRules
          .slice(0, MAX_RULES_IN_PROMPT)
          .map((r) => `- ${r.rule_id} (from ${r.source}): ${r.title}`)
          .join('\n')}`;
  return [
    '<diff>',
    input.diff,
    '</diff>',
    '',
    findingsBlock,
    '',
    rulesBlock,
    '',
    'Write the 1-2 paragraph summary now.',
  ].join('\n');
}
