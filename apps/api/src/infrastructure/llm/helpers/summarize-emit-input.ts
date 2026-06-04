import { hashToolInput } from './hash-tool-input';

/**
 * Log-safe summary of a terminal `emit_finding` payload. Used by the
 * provider adapters' `logTurn(is_terminal=true)` paths.
 *
 * Logging the raw `tool_input` would leak the full findings payload —
 * rule messages and citation snippets that often contain code excerpts
 * from private repos — into retained log storage. The hash plus the
 * findings count is enough for tracing turn behaviour and dedup
 * verification without echoing the content.
 */
export function summarizeEmitInput(toolInput: unknown): {
  tool_input_hash: string;
  findings_count: number | undefined;
} {
  const findingsArray =
    typeof toolInput === 'object' &&
    toolInput !== null &&
    Array.isArray((toolInput as { findings?: unknown }).findings)
      ? ((toolInput as { findings: unknown[] }).findings as unknown[])
      : undefined;
  return {
    tool_input_hash: hashToolInput(toolInput),
    findings_count: findingsArray ? findingsArray.length : undefined,
  };
}
