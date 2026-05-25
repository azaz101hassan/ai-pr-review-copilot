import { sqliteTable, text, integer, index, foreignKey } from 'drizzle-orm/sqlite-core';
import { pullRequests } from './pull-requests';

// Affinity choices:
//   - `delivery_id` is a GitHub UUID string → TEXT.
//   - `event_name` / `action` stay TEXT because GitHub's vocabulary is
//     open (new events / actions land in webhooks without us shipping).
//   - `received_at` is a server-controlled timestamp → INTEGER epoch ms.
//   - `pull_request_node_id` is a nullable FK to pull_requests.node_id;
//     ON DELETE SET NULL preserves the audit row when a PR is removed.
export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    delivery_id: text('delivery_id').primaryKey(),
    event_name: text('event_name').notNull(),
    action: text('action'),
    pull_request_node_id: text('pull_request_node_id'),
    received_at: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
    raw_payload: text('raw_payload').notNull(),
  },
  (table) => ({
    receivedAtIdx: index('idx_webhook_events_received_at').on(table.received_at),
    pullRequestFk: foreignKey({
      columns: [table.pull_request_node_id],
      foreignColumns: [pullRequests.node_id],
      name: 'webhook_events_pr_node_fk',
    }).onDelete('set null'),
  }),
);
