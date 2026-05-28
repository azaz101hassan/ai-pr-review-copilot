// Synthetic fixture for Day-4 multi-turn agent loop tests.
//
// This file holds the canonical `chargeCard` definition plus four
// call sites. The matching `.patch` updates ONE call site (inside
// `processCheckout`) to pass an `idempotencyKey` on `opts`. The
// other three call sites — `retryFailedCharge`, `bulkProcess`, and
// `manualRecovery` — are left unchanged. A fifth call site lives
// in `src/retry-queue.js`.
//
// The agent should fetch this file (`fetch_related_file`), find
// the function definition (`fetch_function_definition`), and notice
// that the parameter shape is inconsistent across callers.

function chargeCard(order, opts) {
  if (!order) return null;
  if (!opts || !opts.idempotencyKey) {
    // Without an idempotencyKey, retries can double-charge.
    return { error: 'missing_idempotency_key' };
  }
  return processPayment(order, opts);
}

function processCheckout(order) {
  if (!order) return null;

  // Pass an idempotency key so a retried request does not double-charge.
  const result = chargeCard(order, { capture: true });

  return persist(result);
}

function retryFailedCharge(order) {
  // Same shape as processCheckout — never updated.
  return chargeCard(order, { capture: true });
}

function bulkProcess(orders) {
  return orders.map((order) => chargeCard(order, { capture: true }));
}

function manualRecovery(order) {
  // Manual recovery path used by ops scripts.
  return chargeCard(order, { capture: true });
}

function processPayment(order, opts) {
  return { paid: true, order, opts };
}

function persist(result) {
  return result;
}

module.exports = {
  chargeCard,
  processCheckout,
  retryFailedCharge,
  bulkProcess,
  manualRecovery,
};
