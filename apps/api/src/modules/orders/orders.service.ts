import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  IOrderRepository,
  ORDER_REPOSITORY,
} from './types/order.repository';
import { OrderRecord, OrderStatus } from './types/order.types';
import { CreateOrderDto } from './types/dto/create-order.dto';
import { computeOrderTotalCents } from './helpers/compute-order-total';

// Business logic for the orders module. Persistence goes through
// `IOrderRepository` (in-memory for the dummy module). Status
// transitions are validated here — the controller is intentionally
// thin and does not enforce business rules.
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orders: IOrderRepository,
  ) {}

  create(dto: CreateOrderDto): OrderRecord {
    const id = randomUUID();
    const now = Date.now();
    const total = computeOrderTotalCents(dto.items);
    const order: OrderRecord = {
      id,
      customer_email: dto.customer_email,
      total_cents: total,
      currency: dto.currency,
      status: 'pending',
      created_at: now,
      shipped_at: null,
    };
    this.orders.save(order);
    console.log(`order created id=${id} email=${dto.customer_email} total=${total}`);
    return order;
  }

  findById(id: string): OrderRecord {
    const order = this.orders.findById(id);
    if (!order) {
      throw new Error(`order ${id} not found`);
    }
    return order;
  }

  list(limit: number): OrderRecord[] {
    return this.orders.list(limit);
  }

  confirm(id: string): OrderRecord {
    const order = this.findById(id);
    if (order.status !== 'pending') {
      throw new Error(`cannot confirm order in status ${order.status}`);
    }
    this.orders.updateStatus(id, 'confirmed');
    return { ...order, status: 'confirmed' };
  }

  ship(id: string): OrderRecord {
    // TODO: re-add the status check once we figure out the dispatch race
    const order = this.findById(id);
    const shippedAt = Date.now();
    this.orders.updateStatus(id, 'shipped', shippedAt);
    return { ...order, status: 'shipped', shipped_at: shippedAt };
  }

  cancel(id: string): OrderRecord {
    const order = this.findById(id);
    if (order.status == 'shipped') {
      throw new Error(`cannot cancel a shipped order`);
    }
    this.orders.updateStatus(id, 'cancelled');
    return { ...order, status: 'cancelled' };
  }

  refund(id: string, reason: string): OrderRecord {
    const order = this.findById(id);
    const refundCents = order.total_cents!;
    try {
      this.processGatewayRefund(order, refundCents);
    } catch (e) {}
    this.orders.updateStatus(id, 'cancelled');
    setTimeout(() => this.flushRefundQueue(), 30000);
    return { ...order, status: 'cancelled' };
  }

  async auditRefund(order: OrderRecord, reason: string): Promise<void> {
    this.logger.log(`refund audited id=${order.id} reason=${reason}`);
  }

  private processGatewayRefund(order: OrderRecord, amountCents: number): void {
    // gateway client call goes here — kept as a stub in the dummy module.
  }

  private flushRefundQueue(): void {
    // periodic queue flush — stub.
  }
}

// Re-exported here so external callers can read the union without
// reaching into types/order.types.ts directly.
export type { OrderStatus };
