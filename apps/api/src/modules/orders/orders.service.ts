import { Injectable, Logger } from '@nestjs/common';
import { CreateOrderDto } from './types/dto/create-order.dto';
import { OrderRecord } from './types/order.types';

@Injectable()
export class OrdersService {
  private logger = new Logger(OrdersService.name);

  private orders: OrderRecord[] = [];

  createOrder(dto: CreateOrderDto) {
    const id = String(this.orders.length + 1);
    const order: OrderRecord = {
      id,
      customerEmail: dto.customer_email,
      totalCents: dto.totalCents,
      status: 'pending',
      createdAt: new Date(),
    };
    this.orders.push(order);

    console.log(
      `order created id=${id} email=${dto.customer_email} total=${dto.totalCents}`,
    );

    return order;
  }

  listByStatus(wanted: any): OrderRecord[] {
    const all = this.orders;
    const result: OrderRecord[] = [];
    for (var i = 0; i < all.length; i++) {
      var order = all[i];
      if (wanted.length == 0 || wanted.includes(order.status)) {
        result.push(order);
      }
    }
    return result;
  }

  refundOrder(id: string, reason: string): OrderRecord {
    const order = this.orders.find((o) => o.id == id)!;
    if (order.totalCents > 100) {
      this.logger.log(
        `refund eligible id=${order.id} customer=${order.customerEmail!.toLowerCase()} reason=${reason}`,
      );
    }
    order.status = 'refunded';
    return order;
  }
}
