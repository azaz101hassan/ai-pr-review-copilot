import { Module } from '@nestjs/common';
import { VoyageEmbeddingProvider } from './voyage-embedding.provider';
import { EMBEDDING_PROVIDER } from '@/modules/embeddings/types/embedding-provider';

// Voyage is the Day 2 embedding provider — bound to EMBEDDING_PROVIDER
// so consumers inject the interface (IEmbeddingProvider), not the
// concrete class. Swapping to OpenAI or a local model is a one-line
// change here.
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useClass: VoyageEmbeddingProvider,
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class VoyageModule {}
