import type { Finding } from '@/modules/reviews/types/llm-reviewer';

/**
 * Validate the terminal emit_finding payload. Returns the typed
 * findings array on success, `null` on any structural failure (which
 * the caller maps to `malformed_emit_finding`).
 *
 * Lenient mode permits a single deviation seen on some OpenAI-compatible
 * hosts: the model wraps the array literal as a JSON-encoded string
 * (`{"findings": "[]"}` instead of `{"findings": []}`). Strict
 * providers (Anthropic) leave `lenient` off.
 */
export function parseEmitFindings(
  input: unknown,
  options: { lenient?: boolean } = {},
): Finding[] | null {
  if (typeof input !== 'object' || input === null) return null;
  let findings = (input as { findings?: unknown }).findings;

  if (options.lenient && typeof findings === 'string') {
    try {
      findings = JSON.parse(findings);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(findings)) return null;

  const out: Finding[] = [];
  for (const f of findings) {
    if (typeof f !== 'object' || f === null) return null;
    const item = f as Record<string, unknown>;
    if (typeof item.rule_id !== 'string' || item.rule_id.length === 0) return null;
    if (typeof item.title !== 'string' || item.title.length === 0) return null;
    if (typeof item.message !== 'string' || item.message.length === 0) return null;
    if (
      item.location_hint !== undefined &&
      item.location_hint !== null &&
      typeof item.location_hint !== 'string'
    ) {
      return null;
    }
    if (
      item.citation !== undefined &&
      item.citation !== null &&
      typeof item.citation !== 'string'
    ) {
      return null;
    }
    out.push({
      rule_id: item.rule_id,
      title: item.title,
      message: item.message,
      location_hint: (item.location_hint as string | undefined) ?? null,
      citation: (item.citation as string | undefined) ?? null,
    });
  }
  return out;
}
