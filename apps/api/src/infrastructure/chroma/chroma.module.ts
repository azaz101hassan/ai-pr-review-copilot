import { Module } from '@nestjs/common';
import { ChromaVectorStore } from './chroma-vector-store';
import { VECTOR_STORE } from '@/modules/embeddings/types/vector-store';

// Chroma vector store — bound to VECTOR_STORE so consumers inject
// the interface (IVectorStore), not the concrete class. Swapping to
// Qdrant/Pinecone is a one-line change here.
@Module({
  providers: [
    {
      provide: VECTOR_STORE,
      useClass: ChromaVectorStore,
    },
  ],
  exports: [VECTOR_STORE],
})
export class ChromaModule {}
