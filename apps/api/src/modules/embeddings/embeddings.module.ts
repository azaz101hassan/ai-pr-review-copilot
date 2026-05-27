import { Module } from '@nestjs/common';
import { ChromaModule } from '@/infrastructure/chroma';
import { VoyageModule } from '@/infrastructure/voyage';
import { EmbeddingsController } from './embeddings.controller';
import { EmbeddingsService } from './embeddings.service';
import { CorpusLoader } from './helpers/corpus-loader';

// EmbeddingsModule wires the Day-2 RAG read/write paths. It pulls in
// the two infrastructure adapters (Voyage for embeddings, Chroma for
// the vector index), exposes the HTTP search endpoint, and exports
// `EmbeddingsService` so Day-3's review module can inject it.
//
// DatabaseModule is `@Global` and already provides the two repository
// tokens this service injects — no re-import needed.
@Module({
  imports: [VoyageModule, ChromaModule],
  controllers: [EmbeddingsController],
  providers: [EmbeddingsService, CorpusLoader],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
