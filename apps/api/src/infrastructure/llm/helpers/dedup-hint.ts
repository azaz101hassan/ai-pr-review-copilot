/**
 * Steering text prepended to a replayed cached tool result. Tells the
 * model the request is a duplicate of an earlier turn so it stops
 * re-fetching the same artifact. The original content follows
 * verbatim — the model still has all the data it asked for.
 *
 * Each provider applies this to its own content shape (Anthropic
 * concats onto the first text block; OpenRouter concats onto the
 * single string body).
 */
export function buildDedupHintText(cachedAtTurn: number): string {
  return (
    `[Note: an identical request was already served on turn ${cachedAtTurn}; ` +
    `cached content follows. If you have enough context, call \`emit_finding\` ` +
    `(or finish the review) instead of fetching the same artifact again.]\n\n`
  );
}
