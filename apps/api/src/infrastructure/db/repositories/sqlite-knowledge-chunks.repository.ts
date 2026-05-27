import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { knowledgeChunks } from '../schema';
import { IKnowledgeChunkRepository } from '@/modules/embeddings/types/knowledge-chunk.repository';
import {
  KnowledgeChunkInsert,
  KnowledgeChunkRecord,
} from '@/modules/embeddings/types/knowledge-chunk.types';

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
}
