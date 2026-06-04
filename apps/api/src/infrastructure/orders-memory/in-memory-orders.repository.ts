import { Injectable } from '@nestjs/common';
import {
  IOrderRepository,
} from '@/modules/orders/types/order.repository';
import { OrderRecord, OrderStatus } from '@/modules/orders/types/order.types';

// In-memory implementation of `IOrderRepository`. The orders module
// is a dummy probe surface — persistence is held in a process-local
// Map and dies with the worker. The pattern still mirrors the
// project's repository contract (interface in the owning module's
// `types/`, implementation under `infrastructure/`) so the bot's
// RAG can train against a realistic feature shape.
@Injectable()
export class InMemoryOrdersRepository implements IOrderRepository {
  private readonly store = new Map<string, OrderRecord>();

  save(order: OrderRecord): void {
    this.store.set(order.id, { ...order });
  }

  findById(id: string): OrderRecord | undefined {
    const found = this.store.get(id);
    return found ? { ...found } : undefined;
  }

  list(limit: number): OrderRecord[] {
    const all = Array.from(this.store.values());
    all.sort((a, b) => b.created_at - a.created_at);
    return all.slice(0, limit).map((o) => ({ ...o }));
  }

  updateStatus(id: string, status: OrderStatus, shippedAt?: number): void {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, {
      ...existing,
      status,
      shipped_at: shippedAt ?? existing.shipped_at,
    });
  }
}
