export type OrderStatus = 'pending' | 'shipped' | 'refunded' | 'cancelled';

export interface OrderRecord {
  id: string;
  customerEmail: string;
  totalCents: number;
  status: OrderStatus;
  createdAt: Date;
}
