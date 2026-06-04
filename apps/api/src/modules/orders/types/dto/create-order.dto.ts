import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// HTTP DTO for `POST /orders`. class-validator runs at the controller
// boundary via the global ValidationPipe. Whitelist + transform
// settings are inherited from the existing pipeline in `main.ts`.

export class OrderLineItemDto {
  @IsString()
  @MaxLength(64)
  sku!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(0)
  unit_price_cents!: number;
}

export class CreateOrderDto {
  @IsEmail()
  @MaxLength(200)
  customer_email!: string;

  @IsString()
  @IsIn(['USD', 'EUR', 'GBP', 'JPY'])
  currency!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineItemDto)
  items!: OrderLineItemDto[];
}
