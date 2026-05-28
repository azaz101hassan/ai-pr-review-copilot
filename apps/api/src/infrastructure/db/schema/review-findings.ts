import {
  sqliteTable,
  text,
  integer,
  index,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { reviews } from './reviews';

// One row per finding emitted by a review. Parent `reviews` row is
// deleted-cascade so cleaning a review row removes its findings too.
//
// `rule_id` is a SOFT reference to knowledge_chunks.rule_id — no FK.
// A knowledge_chunks row can be re-seeded or removed; we still want to
// keep historical findings even if their cited rule disappeared. The
// parent reviews row captures the retrieved rule-set via
// `retrieved_chunk_ids`, so context is preserved.
//
// `severity` is sourced from the matched SearchHit's metadata at
// persistence in ReviewsService — Claude never emits severity. See
// docs/plans/04-day3-...md → Key Technical Decisions → Severity
// sourcing.
//
// Affinity choices:
//   - `severity` uses Drizzle's text-enum mode.
//   - `created_at` is epoch ms via timestamp_ms mode.
//   - `location_hint` and `citation` are TEXT NULL (no false-empty
//     coercion — null and '' are stored distinctly).
export const reviewFindings = sqliteTable(
  'review_findings',
  {
    id: text('id').primaryKey(),
    review_id: text('review_id').notNull(),
    rule_id: text('rule_id').notNull(),
    severity: text('severity', { enum: ['error', 'warning', 'info'] }).notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    location_hint: text('location_hint'),
    citation: text('citation'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    reviewIdIdx: index('idx_review_findings_review_id').on(table.review_id),
    ruleIdIdx: index('idx_review_findings_rule_id').on(table.rule_id),
    reviewFk: foreignKey({
      columns: [table.review_id],
      foreignColumns: [reviews.id],
      name: 'review_findings_review_fk',
    }).onDelete('cascade'),
  }),
);
