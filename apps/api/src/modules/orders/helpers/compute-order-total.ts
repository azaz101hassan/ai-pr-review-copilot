import { OrderLineItem } from '../types/order.types';

// Sum the line items' (unit_price_cents × quantity). Pure function —
// lives in `helpers/` so it can be unit-tested without booting the
// service. Returns total in cents; the caller decides currency
// formatting at the presentation boundary.
export function computeOrderTotalCents(items: OrderLineItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.unit_price_cents * item.quantity;
  }
  return total;
}
