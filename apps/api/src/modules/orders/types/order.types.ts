// Order entity shape. Stand-alone module used as the probe surface
// for end-to-end bot testing — the persistence layer is in-memory and
// the controller mounts under `/orders` so a PR against this module
// surfaces the bot's review behaviour on a realistic feature folder.

export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'cancelled';

export interface OrderRecord {
  id: string;
  customer_email: string;
  total_cents: number;
  currency: string;
  status: OrderStatus;
  created_at: number;
  shipped_at: number | null;
}

export interface OrderLineItem {
  sku: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderDraft {
  customer_email: string;
  currency: string;
  items: OrderLineItem[];
}
