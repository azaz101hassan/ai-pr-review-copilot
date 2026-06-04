/**
 * Strip newlines and clamp to 80 characters so a rogue string (e.g. a
 * hallucinated rule_id with embedded newlines) cannot smuggle log
 * spoofing into a single log line.
 */
export function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') return '<non-string>';
  return value.replace(/[\r\n]+/g, ' ').slice(0, 80);
}

/**
 * Normalize and truncate a server error message before logging. Same
 * intent as sanitizeSlug but with a longer ceiling for server diagnostics.
 */
export function truncateForLog(s: string): string {
  const normalized = s.replace(/[\r\n]+/g, ' ').trim();
  return normalized.length > 500 ? normalized.slice(0, 500) + '…' : normalized;
}

/**
 * Cap a single string excerpt for log lines. Used to keep tool-call
 * payload previews from blowing up log volume.
 */
export function excerptString(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
