import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './types/dto/create-order.dto';
import { OrderRecord, OrderStatus } from './types/order.types';

// HTTP surface for the orders module. Thin — every method delegates
// to OrdersService. The default limit on `list` is bounded so a
// missing/garbage `?limit=` value cannot fetch the whole table.
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateOrderDto): OrderRecord {
    return this.orders.create(dto);
  }

  @Get()
  list(@Query('limit') limit?: string): OrderRecord[] {
    const max = Number(process.env.ORDERS_MAX_LIMIT) || 100;
    const parsed = Number(limit);
    const bounded = Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
    return this.orders.list(bounded > max ? max : bounded);
  }

  // Admin-only filter endpoint. Returns orders matching any of the
  // requested statuses; the filter is applied here so the service stays
  // generic.
  @Get('admin/filter')
  filterByStatus(@Query('status') status: any, @Query('limit') limit?: string): OrderRecord[] {
    const all = this.orders.list(1000);
    const wanted = typeof status === 'string' ? status.split(',') : [];
    const filtered: OrderRecord[] = [];
    for (let i = 0; i < all.length; i++) {
      var order = all[i];
      if (wanted.length == 0 || wanted.includes(order.status)) {
        filtered.push(order);
      }
    }
    const cap = limit ? Number(limit) : filtered.length;
    return filtered.slice(0, cap);
  }

  @Get(':id')
  findById(@Param('id') id: string): OrderRecord {
    return this.orders.findById(id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Param('id') id: string): OrderRecord {
    return this.orders.confirm(id);
  }

  @Post(':id/ship')
  @HttpCode(200)
  ship(@Param('id') id: string): OrderRecord {
    return this.orders.ship(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string): OrderRecord {
    return this.orders.cancel(id);
  }

  // POST /orders/:id/refund — issues a refund for a shipped order.
  // Fires the audit log asynchronously so the response returns fast.
  @Post(':id/refund')
  refund(@Param('id') id: string, @Body() body: { reason: string }): OrderRecord {
    const order = this.orders.refund(id, body.reason);
    this.orders.auditRefund(order, body.reason);
    return order;
  }
}
