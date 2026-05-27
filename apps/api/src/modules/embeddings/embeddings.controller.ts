import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { EmbeddingsService, SearchHit } from './embeddings.service';
import { SearchRequestDto } from './types/dto/search-request.dto';

@Controller('embeddings')
export class EmbeddingsController {
  constructor(private readonly embeddings: EmbeddingsService) {}

  // POST /embeddings/search
  //
  // Body validation lives entirely on SearchRequestDto — the global
  // ValidationPipe in main.ts enforces it. The route itself is a thin
  // delegator that translates the DTO into a service call and wraps
  // the hits in `{ hits: [...] }` for forward-compatible response
  // shapes (e.g., adding `tokensUsed` or pagination later).
  //
  // POST is the right verb (idempotent search with a body) but search
  // is not creating a resource — override Nest's default 201 → 200.
  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(@Body() dto: SearchRequestDto): Promise<{ hits: SearchHit[] }> {
    const hits = await this.embeddings.search(dto.diff, { k: dto.k });
    return { hits };
  }
}
