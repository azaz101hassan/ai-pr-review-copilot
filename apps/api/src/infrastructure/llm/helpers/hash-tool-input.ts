import { createHash } from 'node:crypto';

/**
 * 16-char SHA-256 prefix of canonical-JSON. Enough bits to disambiguate
 * per-review log lines and dedup cache keys without bloating storage.
 */
export function hashToolInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? {}))
    .digest('hex')
    .slice(0, 16);
}
