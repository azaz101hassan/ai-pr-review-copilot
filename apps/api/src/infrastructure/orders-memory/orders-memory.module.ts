import { Module } from '@nestjs/common';
import { ORDER_REPOSITORY } from '@/modules/orders/types/order.repository';
import { InMemoryOrdersRepository } from './in-memory-orders.repository';

// Binds the in-memory orders repository to the `ORDER_REPOSITORY`
// token. Swap-seam pattern: a future SqliteOrdersRepository or
// PostgresOrdersRepository plugs in here with no consumer changes.
@Module({
  providers: [
    {
      provide: ORDER_REPOSITORY,
      useClass: InMemoryOrdersRepository,
    },
  ],
  exports: [ORDER_REPOSITORY],
})
export class OrdersMemoryModule {}
