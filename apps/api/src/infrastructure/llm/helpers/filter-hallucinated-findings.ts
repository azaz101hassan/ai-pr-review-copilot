import type { Logger } from '@nestjs/common';
import type {
  AnalyzeDiffInput,
  Finding,
} from '@/modules/reviews/types/llm-reviewer';
import { sanitizeSlug } from './log-formatters';

/**
 * Drop findings whose `rule_id` is not present in the retrieved rule
 * set, or whose `source:rule_id` composite the input never carried.
 * Both filter paths roll up into one counter at the call site so the
 * dashboard can show hallucination volume across the time-window slice.
 */
export function filterHallucinatedFindings(
  raw: Finding[],
  rules: AnalyzeDiffInput['rules'],
  inputRuleKeys: Set<string>,
  logger: Logger,
): Finding[] {
  const out: Finding[] = [];
  for (const f of raw) {
    const matchedRule = rules.find((r) => r.rule_id === f.rule_id);
    if (!matchedRule) {
      logger.warn(`Dropped hallucinated rule_id="${sanitizeSlug(f.rule_id)}"`);
      continue;
    }
    const composite = `${matchedRule.source}:${matchedRule.rule_id}`;
    if (!inputRuleKeys.has(composite)) {
      logger.warn(
        `Dropped finding with unknown composite="${sanitizeSlug(composite)}"`,
      );
      continue;
    }
    out.push({
      rule_id: f.rule_id,
      title: f.title,
      message: f.message,
      location_hint: f.location_hint ?? null,
      citation: f.citation ?? null,
    });
  }
  return out;
}
