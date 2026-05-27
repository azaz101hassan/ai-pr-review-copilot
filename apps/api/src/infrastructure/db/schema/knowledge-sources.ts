import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// One row per logical corpus source (`airbnb-eslint`, `team-standards`,
// future `internal-runbook`, etc.). `id` is a slug — short, kebab-cased,
// stable — so it can be referenced from seed JSON, FKs, and chunk-id
// prefixes (`${source_id}:${rule_id}`) without rewriting on display name
// changes.
//
// Affinity choices:
//   - `id` is the human-readable slug → TEXT primary key.
//   - `created_at` is an epoch-ms timestamp → INTEGER with timestamp_ms
//     mode so consumers see real `Date` objects.
export const knowledgeSources = sqliteTable('knowledge_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
