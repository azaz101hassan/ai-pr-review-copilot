// Fifth call site of `chargeCard` — lives in a separate file.
// The agent has to walk the repo (or fetch this file explicitly)
// to find it. The matching `.patch` does NOT touch this file, so
// the parameter mismatch is silent — only visible by reading the
// surrounding source.

const { chargeCard } = require('./checkout');

function drainRetryQueue(queue) {
  while (queue.length > 0) {
    const order = queue.shift();
    // Unchanged call site — still passes `{ capture: true }` only.
    chargeCard(order, { capture: true });
  }
}

module.exports = { drainRetryQueue };
