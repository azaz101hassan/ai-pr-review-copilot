// Cross-tier error inspection helpers. Pure, dependency-free, and
// stable enough that every module needing to extract an HTTP status
// or a one-line excerpt from a thrown thing imports from here
// rather than redeclaring its own copy.
//
// CLAUDE.md tier note: `src/types/` is "cross-tier shared types
// only", which these straddle — they're functions, not types, but
// they're truly cross-tier (used by feature modules AND
// infrastructure adapters) and don't belong to any one vendor. The
// alternative (`src/infrastructure/errors/`) would invite the
// kitchen-sink common-module pitfall when other generic utilities
// want a home.

/**
 * Read a numeric HTTP status off an unknown thrown value. Returns
 * 0 when the input is not an object, is null, or carries no
 * `status` field of a finite-number type. Used by every catch path
 * that wants to branch on HTTP semantics (404 → terminal, 5xx →
 * retryable, etc.) without first narrowing to a typed error class.
 */
export function readStatus(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 0;
  const s = (err as { status?: unknown }).status;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * One-line excerpt of an unknown thrown value's message. Caps at
 * 200 characters so log lines stay grep-friendly and so error
 * messages embedded in BullMQ failure rows / GitHub Review bodies
 * don't blow past size limits. Falls back to `String(err)` for
 * non-Error throws (strings, plain objects).
 */
export function formatBriefError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
