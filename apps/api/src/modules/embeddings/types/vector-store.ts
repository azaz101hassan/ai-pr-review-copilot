// EmbeddingsService injects this token; Chroma (or any future) store is
// bound to it in `infrastructure/chroma/chroma.module.ts`. The interface
// hides Chroma's nested-by-query response shape behind a flat list of
// hits, and converts distance into a similarity score (higher = better)
// so consumers don't have to remember which metric Chroma was configured
// with.

export const VECTOR_STORE = Symbol('VectorStore');

// Chroma stores scalar metadata; we mirror its constraint so callers
// can't accidentally pass nested objects that the upstream then rejects.
export type VectorMetadataValue = string | number | boolean;
export type VectorMetadata = Record<string, VectorMetadataValue>;

export interface VectorStoreItem {
  id: string;
  embedding: number[];
  document: string;
  metadata: VectorMetadata;
}

export interface VectorStoreQueryOptions {
  embedding: number[];
  k: number;
  // Chroma's `where` filter — passed through verbatim. Typed loosely
  // here because the upstream type is shaped around Chroma's
  // expression DSL; we don't want to leak that DSL through this seam.
  where?: Record<string, unknown>;
}

export interface VectorStoreHit {
  id: string;
  // Higher = better. For cosine space (the default this adapter sets),
  // score = `1 - distance`. Consumers sort descending.
  score: number;
  document: string | null;
  metadata: Record<string, unknown>;
}

export interface IVectorStore {
  // Idempotent. Lazy by design — the first call to upsert/query/delete
  // triggers this if it hasn't run yet, so DI bootstrap stays
  // network-free. Callers may invoke it explicitly during a seed run to
  // surface a connection error early instead of mid-batch.
  ensureCollection(): Promise<void>;
  upsert(items: VectorStoreItem[]): Promise<void>;
  query(options: VectorStoreQueryOptions): Promise<VectorStoreHit[]>;
  // For test isolation and "rebuild from scratch" flows. Not called in
  // the seed runner — re-runs upsert by deterministic id.
  deleteAll(): Promise<void>;
}
