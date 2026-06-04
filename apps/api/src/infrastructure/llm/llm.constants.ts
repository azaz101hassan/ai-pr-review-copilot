/**
 * Provider-neutral defaults for the agent loop. Anthropic and
 * OpenRouter adapters share these so the two paths stay comparable
 * across runs and so the troubleshooting docs need only one source.
 */

export const MAX_TOKENS_PER_TURN = 2048;

export const SDK_MAX_RETRIES = 2;

export const PER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Default ceiling on agent-loop turns per review. The canonical
 * SYSTEM_PROMPT is built at this value; non-default operator overrides
 * yield a runtime-only prompt with the same shape but a different
 * stated cap. Snapshot drift guard pins the canonical bytes.
 */
export const DEFAULT_TURN_CAP = 6;

/**
 * Maximum findings the terminal emit_finding tool may return. Enforced
 * by the tool schema's `maxItems`; surfaced here so consumers can
 * reason about output budget without parsing the schema.
 */
export const MAX_FINDINGS_PER_EMIT = 10;
