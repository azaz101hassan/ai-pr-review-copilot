import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersMemoryModule } from '@/infrastructure/orders-memory';

// Orders feature module — probe surface for end-to-end bot testing.
// HTTP surface mounts under `/orders`; persistence is in-memory via
// `OrdersMemoryModule` (the binding for `ORDER_REPOSITORY`). When the
// surface graduates from "dummy" to a real feature, swap
// `OrdersMemoryModule` for a SQLite-backed sibling and consumers
// stay unchanged.
@Module({
  imports: [OrdersMemoryModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
