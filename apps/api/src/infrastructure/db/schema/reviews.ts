import {
  sqliteTable,
  text,
  integer,
  index,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { pullRequests } from './pull-requests';

// One row per Claude review attempt. The row is inserted with
// status='in_progress' BEFORE the Anthropic call and flipped to a
// terminal state ('completed' or 'failed') after — the three-state enum
// closes the "process died mid-call" gap that a 2-state enum would
// silently leak. ReviewsService.onModuleInit sweeps stale 'in_progress'
// rows older than 5 minutes (see U5 / U6 of docs/plans/04-day3-...).
//
// Affinity choices:
//   - `status` uses Drizzle's text-enum mode so the TS surface narrows
//     to a literal union and the SQLite CHECK constraint catches typos.
//   - `created_at` / `completed_at` are epoch ms via timestamp_ms mode.
//   - `pr_node_id` is a nullable FK to pull_requests.node_id with
//     ON DELETE SET NULL — preserves the audit row when a PR is removed.
//   - `created_by` is reserved for Day-5 auth handoff. Day 3 always
//     writes NULL; the column ships nullable so Day 5 can backfill
//     without a schema migration. Width is unbounded TEXT (SQLite has
//     no length cap); a MaxLength(200) ceiling is enforced at the
//     controller layer when Day 5 wires auth in.
//   - `retrieved_chunk_ids_hash` is the SHA-256 hex of the sorted
//     retrieved-chunk composite ids. Day-6/8 telemetry uses collision
//     rate to decide whether a second prompt-cache breakpoint on the
//     retrieved rules is justified.
//   - No `diff_hash` — deferred to whichever day introduces dedup.
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    pr_node_id: text('pr_node_id'),
    created_by: text('created_by'),
    diff_length: integer('diff_length').notNull(),
    model: text('model').notNull(),
    prompt_version: text('prompt_version').notNull(),
    top_k: integer('top_k').notNull(),
    retrieved_chunk_ids: text('retrieved_chunk_ids').notNull(),
    retrieved_chunk_ids_hash: text('retrieved_chunk_ids_hash').notNull(),
    status: text('status', {
      enum: ['completed', 'failed', 'in_progress'],
    }).notNull(),
    error_status: integer('error_status'),
    error_code: text('error_code'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    cache_creation_input_tokens: integer('cache_creation_input_tokens'),
    cache_read_input_tokens: integer('cache_read_input_tokens'),
    // Day-4 multi-turn loop aggregates. `turn_count` defaults to 0 so
    // failures before the first `messages.create` response are
    // distinguishable from any review that made it past turn 1
    // (historical Day-3 rows backfill to 1 in the 0003 migration).
    // `tool_calls_json` stores the per-turn ToolCallRecord array as JSON
    // text; nullable because Day-4 pre-turn-1 failures and historical
    // Day-3 rows have no per-turn data.
    turn_count: integer('turn_count').notNull().default(0),
    tool_calls_json: text('tool_calls_json', { mode: 'json' }),
    // Day-8 observability counts. Populated by the reviewer when a review
    // completes; the dashboard aggregator SUMs them across the time-window.
    //   - hallucinated_finding_count: number of findings the reviewer
    //     emitted that the filter dropped (unknown rule_id or wrong
    //     source:rule_id composite).
    //   - cache_hit_count: number of tool-call invocations the per-review
    //     dedup cache short-circuited instead of re-invoking the tool.
    // Both default to 0 so historical rows backfill cleanly without a
    // separate data migration. Forward-looking signals — no retroactive
    // recomputation from tool_calls_json.
    hallucinated_finding_count: integer('hallucinated_finding_count')
      .notNull()
      .default(0),
    cache_hit_count: integer('cache_hit_count').notNull().default(0),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    completed_at: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    prNodeIdIdx: index('idx_reviews_pr_node_id').on(table.pr_node_id),
    createdAtIdx: index('idx_reviews_created_at').on(table.created_at),
    // Powers ReviewsService.onModuleInit's startup sweep — "find in_progress
    // rows older than 5 min". Composite order matches the WHERE clause.
    statusCreatedAtIdx: index('idx_reviews_status_created_at').on(
      table.status,
      table.created_at,
    ),
    // F17 closure. Powers two hot reads:
    //   1. findByPrNodeIdForPriorReview's
    //      `WHERE pr_node_id = ? AND status = 'completed' AND error_code IS NULL`
    //      → first two filters land directly on the composite.
    //   2. findRecentInProgressForPr's
    //      `WHERE pr_node_id = ? AND status = 'in_progress' AND created_at > ?`
    //      → composite covers the first two, created_at picked up
    //      from idx_reviews_pr_node_id_created_at-equivalent on the
    //      secondary lookup (DESC limit 1).
    // Composite order: pr_node_id leads (high cardinality), then status.
    prNodeIdStatusIdx: index('idx_reviews_pr_node_id_status').on(
      table.pr_node_id,
      table.status,
    ),
    pullRequestFk: foreignKey({
      columns: [table.pr_node_id],
      foreignColumns: [pullRequests.node_id],
      name: 'reviews_pr_node_fk',
    }).onDelete('set null'),
  }),
);
