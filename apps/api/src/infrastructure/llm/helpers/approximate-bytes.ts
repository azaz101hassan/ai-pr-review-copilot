/**
 * Best-effort UTF-8 byte size for arbitrary payloads. Handles raw
 * strings, arrays (sum of children), objects (JSON serialization), and
 * Anthropic-style text blocks `{type: 'text', text}` so both adapters
 * can use the same helper to populate `ToolCallRecord.result_bytes`.
 */
export function approximateBytes(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
  if (Array.isArray(payload)) {
    return payload.reduce<number>((sum, p) => sum + approximateBytes(p), 0);
  }
  if (typeof payload === 'object') {
    const p = payload as { type?: string; text?: string };
    if (p.type === 'text' && typeof p.text === 'string') {
      return Buffer.byteLength(p.text, 'utf8');
    }
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }
  return 0;
}
