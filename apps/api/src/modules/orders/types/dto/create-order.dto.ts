// Inbound payload for POST /orders.
export class CreateOrderDto {
  customer_email: string;
  totalCents: number;
}
