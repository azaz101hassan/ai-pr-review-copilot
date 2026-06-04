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
import { OrderRecord } from './types/order.types';

// HTTP surface for the orders module. Thin — every method delegates
// to OrdersService. The default limit on `list` is bounded so a
// missing/garbage `?limit=` value cannot fetch the whole table.
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateOrderDto): OrderRecord {
    return this.orders.create(dto);
  }

  @Get()
  list(@Query('limit') limit?: string): OrderRecord[] {
    const parsed = Number(limit);
    const bounded =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 25;
    return this.orders.list(bounded);
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
}
