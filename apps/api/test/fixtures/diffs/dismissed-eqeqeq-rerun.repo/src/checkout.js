// Post-diff state. The eqeqeq violation lives on line 15 (the
// `if (order.status == "pending")` line). The matching
// `reviews.json` seeds a prior finding at this exact location
// with `dismissed_at` set — the agent should fetch the prior
// review (`fetch_prior_review`), see the dismissal, and emit
// zero findings.

function processOrder(order) {
  if (!order) return null;

  // Loose comparison — re-applies a prior eqeqeq violation that
  // was already dismissed by the team during last week's review.
  if (order.status == "pending") {
    await chargeCard(order);
  }

  return persist(order);
}

function chargeCard(order) {
  return { paid: true, order };
}

function persist(order) {
  return order;
}

module.exports = { processOrder };
