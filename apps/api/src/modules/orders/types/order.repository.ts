import { OrderRecord, OrderStatus } from './order.types';

// Repository contract for the orders module. Matches the project's
// repository pattern (CLAUDE.md): interface + Symbol token live with
// the owning module's types; concrete implementations live under
// `infrastructure/`. For the dummy module the implementation is
// in-memory (see `infrastructure/orders/`).
export const ORDER_REPOSITORY = Symbol('OrderRepository');

export interface IOrderRepository {
  save(order: OrderRecord): void;
  findById(id: string): OrderRecord | undefined;
  list(limit: number): OrderRecord[];
  updateStatus(id: string, status: OrderStatus, shippedAt?: number): void;
}
