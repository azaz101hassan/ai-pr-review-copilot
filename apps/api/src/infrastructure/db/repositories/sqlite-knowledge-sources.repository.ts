import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { knowledgeSources } from '../schema';
import { IKnowledgeSourceRepository } from '@/modules/embeddings/types/knowledge-source.repository';
import {
  KnowledgeSourceInsert,
  KnowledgeSourceRecord,
} from '@/modules/embeddings/types/knowledge-source.types';

@Injectable()
export class SqliteKnowledgeSourcesRepository implements IKnowledgeSourceRepository {
  constructor(private readonly db: DatabaseService) {}

  upsert(record: KnowledgeSourceInsert): void {
    this.db.drizzle
      .insert(knowledgeSources)
      .values(record)
      .onConflictDoUpdate({
        target: knowledgeSources.id,
        set: {
          name: record.name,
          description: record.description ?? null,
          created_at: record.created_at,
        },
      })
      .run();
  }

  findById(id: string): KnowledgeSourceRecord | undefined {
    return this.db.drizzle
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, id))
      .get();
  }

  listAll(): KnowledgeSourceRecord[] {
    return this.db.drizzle.select().from(knowledgeSources).all();
  }
}
