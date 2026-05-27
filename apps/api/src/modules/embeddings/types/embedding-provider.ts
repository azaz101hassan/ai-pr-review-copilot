// EmbeddingsService injects this token; Voyage (or any future) provider
// is bound to it in `infrastructure/voyage/voyage.module.ts`. The
// asymmetric encoding split — `embedDocuments` for index-time text and
// `embedQuery` for retrieval-time text — is encoded at the type level so
// callers cannot accidentally mix `input_type: "document"` with a query
// (which degrades recall on `voyage-code-3` per Voyage docs).
export const EMBEDDING_PROVIDER = Symbol('EmbeddingProvider');

export interface EmbedDocumentsResult {
  vectors: number[][];
  tokensUsed: number;
}

export interface EmbedQueryResult {
  vector: number[];
  tokensUsed: number;
}

export interface IEmbeddingProvider {
  readonly modelName: string;
  readonly dimension: number;
  embedDocuments(texts: string[]): Promise<EmbedDocumentsResult>;
  embedQuery(text: string): Promise<EmbedQueryResult>;
}
