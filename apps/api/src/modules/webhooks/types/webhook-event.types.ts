// Persistent shape of a webhook event as we store it. Columns match
// webhook_events in schema.sql one-to-one. pull_request_node_id is
// nullable because non-PR events (push, ping, …) and orphaned PR
// actions land with FK = null.
export interface WebhookEventRecord {
  delivery_id: string;
  event_name: string;
  action: string | null;
  pull_request_node_id: string | null;
  received_at: string;
  raw_payload: string;
}
