import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { pullRequests } from '@/infrastructure/db/schema';

// Type-only imports cross the modules→infrastructure tier boundary
// safely — they erase at compile time, so the runtime dependency rule
// (modules never depend on infrastructure values) is preserved. The
// drizzle schema is the single source of truth for column shapes.
//
// PullRequestRecord is the SELECT shape: created_at/updated_at are
// Date objects because the schema declares them as timestamp_ms;
// `state` is `'open' | 'closed'` via the schema's enum mode.
export type PullRequestRecord = InferSelectModel<typeof pullRequests>;

// PullRequestInsert is the INSERT shape — useful when callers need to
// construct row payloads without knowing every column.
export type PullRequestInsert = InferInsertModel<typeof pullRequests>;
