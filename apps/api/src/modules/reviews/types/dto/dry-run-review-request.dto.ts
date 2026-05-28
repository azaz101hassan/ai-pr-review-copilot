import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// Inbound payload for `POST /reviews/dry-run`.
//
// `diff` cap mirrors `SearchRequestDto.diff` (50_000 chars). The
// Day-3 endpoint forwards the text to Anthropic on a per-token billing
// relationship, so the same denial-of-wallet ceiling applies.
//
// `k` defaults to 10 inside ReviewsService when omitted; bounded
// 1..100 here so a runaway caller can't make embeddings.search ask
// Chroma for an unbounded result set.
//
// `pr_node_id` uses snake_case to match the JSON-over-HTTP contract.
// class-transformer/class-validator do NOT auto-rename, so the global
// pipe's `forbidNonWhitelisted: true` would reject a camelCase field.
// The controller maps `dto.pr_node_id → prNodeId` at the service call
// site.
export class DryRunReviewRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50_000)
  diff!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  k?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  pr_node_id?: string;
}
