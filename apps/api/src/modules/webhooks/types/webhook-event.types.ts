import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { webhookEvents } from '@/infrastructure/db/schema';

// SELECT shape; received_at is a Date because the schema declares it
// as timestamp_ms. pull_request_node_id and action are nullable.
export type WebhookEventRecord = InferSelectModel<typeof webhookEvents>;

export type WebhookEventInsert = InferInsertModel<typeof webhookEvents>;
