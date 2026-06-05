import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { knowledgeChunks } from '../schema';
import {
  IKnowledgeChunkRepository,
  KeywordSearchHit,
} from '@/modules/embeddings/types/knowledge-chunk.repository';
import {
  KnowledgeChunkInsert,
  KnowledgeChunkRecord,
} from '@/modules/embeddings/types/knowledge-chunk.types';

// Cap the number of MATCH terms we send to FTS5. A long diff easily
// produces hundreds of distinct tokens; past ~512 the per-token query
// cost outweighs the marginal recall gain. The cap also bounds memory
// for absurdly long diffs (>10k unique tokens) without affecting any
// realistic small-PR review.
const MAX_FTS_QUERY_TERMS = 512;
// Drop a token unless it has at least this many characters. `==`, `if`,
// `to`, etc. are either lost to the tokenizer or too common to be
// discriminative; the threshold cuts noise while keeping `var`, `any`.
const MIN_TOKEN_LENGTH = 2;
// Per-token retrieval depth. Rare diff tokens like `var` or `any` only
// match one or two chunks; pulling 3 per token is enough to absorb that
// without polluting the candidate pool with topical noise that the
// OR-of-all-tokens fallback would surface.
const PER_TOKEN_HITS = 3;

@Injectable()
export class SqliteKnowledgeChunksRepository implements IKnowledgeChunkRepository {
  constructor(private readonly db: DatabaseService) {}

  upsertMany(records: KnowledgeChunkInsert[]): void {
    if (records.length === 0) return;

    // Wrap the batch in a single transaction so a mid-batch failure
    // leaves the table at its prior coherent state rather than partially
    // updated. better-sqlite3's `transaction(fn)` synchronously bubbles
    // throws and rolls back automatically.
    this.db.transaction(() => {
      for (const record of records) {
        this.db.drizzle
          .insert(knowledgeChunks)
          .values(record)
          .onConflictDoUpdate({
            target: knowledgeChunks.id,
            set: {
              source_id: record.source_id,
              rule_id: record.rule_id,
              title: record.title,
              body: record.body,
              severity: record.severity ?? null,
              language: record.language ?? null,
              category: record.category ?? null,
              embedding_model: record.embedding_model,
              embedding_dim: record.embedding_dim,
              updated_at: record.updated_at,
            },
          })
          .run();
      }
    });
  }

  findById(id: string): KnowledgeChunkRecord | undefined {
    return this.db.drizzle
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.id, id))
      .get();
  }

  findByIds(ids: string[]): KnowledgeChunkRecord[] {
    if (ids.length === 0) return [];

    const rows = this.db.drizzle
      .select()
      .from(knowledgeChunks)
      .where(inArray(knowledgeChunks.id, ids))
      .all();

    // SQLite's IN returns rows in arbitrary order; the caller (search
    // path) expects positional alignment with `ids` so the ranked hit
    // list can be zipped back together. Unknown ids fall out silently —
    // that's the "Chroma allowed to drift ahead of SQLite" failure mode.
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is KnowledgeChunkRecord => row !== undefined);
  }

  deleteBySourceId(sourceId: string): number {
    const result = this.db.drizzle
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.source_id, sourceId))
      .run();
    return Number(result.changes);
  }

  searchByKeyword(query: string, k: number): KeywordSearchHit[] {
    if (k <= 0) return [];
    const tokens = extractTokens(query);
    if (tokens.length === 0) return [];

    // Per-token BM25: each distinct token in the diff gets its own
    // query, returning the PER_TOKEN_HITS chunks that best match THAT
    // token alone. Rare tokens like `var` or `any` then ride the BM25
    // IDF curve cleanly — `var` appears in only the `no-var` chunk's
    // body, so the single-token query puts it at rank 1.
    //
    // The alternative — OR-of-all-tokens — drowns these rare-token
    // wins. With ~50 diff tokens OR-merged, scoring favours chunks
    // that match the bulk of common identifiers (`Controller`, `Get`,
    // `Body`); rare-token chunks with a single high-IDF hit rank far
    // below the topical crowd and never reach the merged top-K.
    //
    // Topical matches are NOT lost — the dense (Voyage) leg handles
    // semantic similarity. Sparse retrieval's job is the surface-token
    // signal that dense embeddings smear out.
    const stmt = this.db.getDb().prepare(
      `SELECT kc.id AS id, knowledge_chunks_fts.rank AS bm25
         FROM knowledge_chunks_fts
         JOIN knowledge_chunks kc ON kc.rowid = knowledge_chunks_fts.rowid
        WHERE knowledge_chunks_fts MATCH ?
        ORDER BY knowledge_chunks_fts.rank
        LIMIT ?`,
    );

    // Rank each chunk by the BEST per-token position it achieves — not
    // by absolute BM25 score, which is incommensurable across tokens.
    //
    // Why: a rare token like `var` (in only 2 chunks) gives `no-var` a
    // BM25 score of about -7. A common token like `controller` (in
    // ~11 chunks) gives the matching rule a score of -50 or more
    // negative. Sorting absolute scores would push every common-token
    // match above every rare-token match — exactly the bias we're
    // trying to cancel. Sorting by per-token rank levels the playing
    // field: a chunk that was rank 1 for ANY single token gets sparse
    // rank 1, regardless of the absolute BM25 number.
    //
    // The returned `bm25Score` field is set to `-perTokenRank` so the
    // ordering invariant (more negative = better) is preserved for
    // callers that sort on the field.
    const bestRankById = new Map<string, number>();
    for (const token of tokens) {
      const rows = stmt.all(token, PER_TOKEN_HITS) as Array<{ id: string; bm25: number }>;
      rows.forEach((row, idx) => {
        const perTokenRank = idx + 1;
        const prev = bestRankById.get(row.id);
        if (prev === undefined || perTokenRank < prev) {
          bestRankById.set(row.id, perTokenRank);
        }
      });
    }

    return [...bestRankById.entries()]
      .map(([id, rank]) => ({ id, bm25Score: -rank }))
      .sort((a, b) => a.bm25Score - b.bm25Score)
      .slice(0, k);
  }
}

// Tokenize a query into an alphanumeric token set: lowercase, deduped,
// dropping tokens shorter than MIN_TOKEN_LENGTH, capped at
// MAX_FTS_QUERY_TERMS. Exposed for tests + for the
// `buildFtsMatchExpression` helper that backs single-shot queries.
export function extractTokens(query: string): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(raw);
    if (tokens.length >= MAX_FTS_QUERY_TERMS) break;
  }
  return tokens;
}

// Build an FTS5 `MATCH` expression from a query string. Returns null
// when the query has no usable tokens — callers should short-circuit
// to an empty result rather than handing FTS5 an empty MATCH (which
// raises a syntax error).
export function buildFtsMatchExpression(query: string): string | null {
  const tokens = extractTokens(query);
  return tokens.length === 0 ? null : tokens.join(' OR ');
}
