/**
 * Parse a `retry-after` header off either the Headers-like (SDK fetch
 * response) or plain-object form some SDKs expose. Returns the wait
 * hint in milliseconds, or `undefined` when the header is missing,
 * malformed, or non-positive. Both upstream providers express
 * retry-after as delta seconds.
 */
export function parseRetryAfterMs(headers: unknown): number | undefined {
  if (!headers) return undefined;
  let raw: string | undefined;
  if (typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
    raw =
      (headers as { get: (k: string) => string | null }).get('retry-after') ??
      undefined;
  } else if (typeof headers === 'object') {
    const dict = headers as Record<string, string | string[] | undefined>;
    const v = dict['retry-after'] ?? dict['Retry-After'];
    raw = Array.isArray(v) ? v[0] : v;
  }
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.floor(seconds * 1000);
}
