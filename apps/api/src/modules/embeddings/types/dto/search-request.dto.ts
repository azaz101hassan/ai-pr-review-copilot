import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// Inbound payload for `POST /embeddings/search`.
//
// `diff` is capped at 50_000 chars (≈ 12K tokens for code). The endpoint
// is unauthenticated and forwards the text to Voyage on a per-token
// billing relationship, so an uncapped field would let any caller
// drain the API budget — the doc-review's "denial-of-wallet" gap that
// this cap closes. Real PR diffs that exceed 50K chars are also useless
// for whole-diff retrieval (see the Day-2 plan's known per-hunk dilution
// risk — fixing that is a Day-6+ optimization, not this endpoint's job).
//
// `k` defaults to 10 when omitted; bounded 1..100 so a runaway caller
// can't ask Chroma for an unbounded result set.
export class SearchRequestDto {
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
}
