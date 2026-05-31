import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

// Sensible upper bound for epoch-ms timestamps: year 2100 in milliseconds.
// Prevents absurdly far-future values while accommodating real-world usage.
const EPOCH_MS_CEILING = 4102444800000;

// Query parameter DTO for dashboard filter endpoints.
// Validated by the global ValidationPipe (transform + whitelist +
// forbidNonWhitelisted) configured in main.ts.
//
// String params use a strict charset pattern to reject SQL-injection
// and command-injection attempts at the DTO boundary. The ValidationPipe
// transforms numeric query params from strings to numbers via @Type(() => Number).
export class FilterSpecDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(/^[a-zA-Z0-9_\-./@]+$/)
  repo?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(/^[a-zA-Z0-9_\-./@]+$/)
  author?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(/^[a-zA-Z0-9_\-./@]+$/)
  pr_node_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(EPOCH_MS_CEILING)
  since?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(EPOCH_MS_CEILING)
  until?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
