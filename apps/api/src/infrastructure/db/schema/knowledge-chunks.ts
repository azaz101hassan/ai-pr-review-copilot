import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { knowledgeSources } from './knowledge-sources';

// One row per atomic knowledge chunk — currently one row per rule
// (chunking strategy in docs/plans/03-day2-rag-foundation.md: rules are
// short and self-contained, so we skip the sliding-window splitter).
//
// `id` is deterministic from `${source_id}:${rule_id}` so seed re-runs
// upsert cleanly and SQLite-row-id ↔ Chroma-vector-id stay aligned by
// construction. The composite `(source_id, rule_id)` is also indexed for
// readable WHERE clauses even though the deterministic primary key
// enforces uniqueness already.
//
// Affinity choices:
//   - `severity` and `language` use Drizzle's text-enum mode so the TS
//     surface narrows to literal unions at compile time.
//   - `embedding_model` / `embedding_dim` capture provenance for the
//     vectors stored in Chroma — needed when a second model coexists or
//     when an old corpus has to be re-embedded against a newer model.
//   - `created_at` / `updated_at` are epoch ms via timestamp_ms mode.
export const knowledgeChunks = sqliteTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey(),
    source_id: text('source_id').notNull(),
    rule_id: text('rule_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    severity: text('severity', { enum: ['error', 'warning', 'info'] }),
    language: text('language', { enum: ['javascript', 'typescript', 'other'] }),
    category: text('category'),
    embedding_model: text('embedding_model').notNull(),
    embedding_dim: integer('embedding_dim').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    sourceIdIdx: index('idx_knowledge_chunks_source_id').on(table.source_id),
    ruleIdIdx: index('idx_knowledge_chunks_rule_id').on(table.rule_id),
    sourceRuleUq: uniqueIndex('uq_knowledge_chunks_source_rule').on(
      table.source_id,
      table.rule_id,
    ),
    sourceFk: foreignKey({
      columns: [table.source_id],
      foreignColumns: [knowledgeSources.id],
      name: 'knowledge_chunks_source_fk',
    }).onDelete('cascade'),
  }),
);
