import type { AnalyzeDiffInput } from '@/modules/reviews/types/llm-reviewer';

export function buildUserMessage(input: AnalyzeDiffInput): string {
  const rulesBlock = input.rules
    .map((r) => `## ${r.rule_id} (${r.source})\n${r.document}`)
    .join('\n\n');
  return `<retrieved_rules>\n${rulesBlock}\n</retrieved_rules>\n<diff>\n${input.diff}\n</diff>`;
}
