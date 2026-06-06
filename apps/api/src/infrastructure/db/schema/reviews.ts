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
// terminal state ('completed' or 'failed') after — the three-state
// enum closes the "process died mid-call" gap that a 2-state enum
// would silently leak. ReviewsService.onModuleInit sweeps stale
// 'in_progress' rows older than the configured cutoff.
//
// Affinity choices:
//   - `status` uses Drizzle's text-enum mode so the TS surface narrows
//     to a literal union and the SQLite CHECK constraint catches typos.
//   - `created_at` / `completed_at` are epoch ms via timestamp_ms mode.
//   - `pr_node_id` is a nullable FK to pull_requests.node_id with
//     ON DELETE SET NULL — preserves the audit row when a PR is removed.
//   - `created_by` is reserved for a future auth handoff. Today we
//     always write NULL; the column ships nullable so a later backfill
//     doesn't need a schema migration.
//   - `retrieved_chunk_ids_hash` is the SHA-256 hex of the sorted
//     retrieved-chunk composite ids. Telemetry uses collision rate
//     to decide whether a second prompt-cache breakpoint on the
//     retrieved rules is justified.
//   - No `diff_hash` — deferred until a real diff-dedup use case lands.
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
    // Multi-turn loop aggregates. `turn_count` defaults to 0 so
    // failures before the first `messages.create` response are
    // distinguishable from any review that made it past turn 1
    // (historical single-turn rows backfill to 1 in the 0003
    // migration). `tool_calls_json` stores the per-turn
    // ToolCallRecord array as JSON text; nullable because pre-turn-1
    // failures and historical single-turn rows have no per-turn data.
    turn_count: integer('turn_count').notNull().default(0),
    tool_calls_json: text('tool_calls_json', { mode: 'json' }),
    // Observability counts. Populated by the reviewer when a review
    // completes; the dashboard aggregator SUMs them across the
    // time-window.
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
    // GitHub Check Run id, cached per-review (per head_sha) so the
    // worker can PATCH the in-progress check to its terminal
    // conclusion after the agent loop completes. Null when the
    // installation has not accepted the Checks permission (the
    // C-POST returns 403; the worker logs and skips the PATCH).
    check_run_id: integer('check_run_id'),
    // 1-2 paragraph LLM-generated prose intro embedded in the
    // walkthrough's success body. Null when the summarizer call
    // failed (graceful degrade: the walkthrough renders the
    // mechanical scaffold without prose).
    walkthrough_summary: text('walkthrough_summary'),
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
    // Composite for two hot reads:
    //   1. findByPrNodeIdForPriorReview's
    //      `WHERE pr_node_id = ? AND status = 'completed' AND error_code IS NULL`
    //      — the first two filters land directly on the composite.
    //   2. findRecentInProgressForPr's
    //      `WHERE pr_node_id = ? AND status = 'in_progress' AND created_at > ?`
    //      — composite covers the first two; created_at is picked up
    //      on the secondary lookup (DESC LIMIT 1).
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
