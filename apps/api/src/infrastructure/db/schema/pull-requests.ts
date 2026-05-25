import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Source of truth for the pull_requests table. drizzle-kit reads this
// to generate migration SQL; the SqlitePullRequestsRepository uses the
// table object for typed queries; modules consume the inferred row type
// via `InferSelectModel<typeof pullRequests>`.
//
// Affinity choices:
//   - `node_id`, `head_sha`, `base_sha` are strings by nature (GitHub
//     opaque ids and git SHAs) → TEXT.
//   - `number` is an integer PR number → INTEGER.
//   - `state` uses Drizzle's text-enum mode for compile-time type
//     safety. SQLite has no native enum, but the TS surface becomes
//     `'open' | 'closed'`.
//   - `created_at` / `updated_at` are timestamps from GitHub; stored as
//     epoch ms (INTEGER) so they're sortable and order-by-friendly.
//     Drizzle's timestamp_ms mode handles JS Date <-> int conversion.
//   - `raw_payload` stays TEXT to preserve GitHub's exact bytes for
//     audit; we deliberately do NOT use `text({ mode: 'json' })` since
//     auto-parsing would discard the original byte ordering.
export const pullRequests = sqliteTable(
  'pull_requests',
  {
    node_id: text('node_id').primaryKey(),
    repo_full_name: text('repo_full_name').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    state: text('state', { enum: ['open', 'closed'] }).notNull(),
    head_sha: text('head_sha').notNull(),
    base_sha: text('base_sha').notNull(),
    author_login: text('author_login').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    raw_payload: text('raw_payload').notNull(),
  },
  (table) => ({
    repoNumberIdx: index('idx_pull_requests_repo_number').on(
      table.repo_full_name,
      table.number,
    ),
  }),
);
