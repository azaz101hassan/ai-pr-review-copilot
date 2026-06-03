// Shape of the JSON GitHub sends for the events we care about today.
// Optional fields reflect the union of pull_request / push / ping
// deliveries — the controller does not assume any of them are
// populated.
//
// `draft`, `state`, `user.type`, and the top-level `installation.id`
// are what the webhook enqueue path needs to:
//   - skip drafts (both `opened` and `synchronize`)
//   - allowlist by repo full_name
//   - mint an installation-scoped Octokit in the worker.
// Fields are optional — real GitHub webhooks always include them on
// pull_request deliveries, but synthesized test payloads may omit
// them, and other webhook types (ping, push) don't carry them at all.
export interface GithubWebhookPayload {
  action?: string;
  pull_request?: {
    node_id: string;
    number: number;
    title: string;
    state: string;
    draft?: boolean;
    head: { sha: string };
    base: { sha: string };
    user: { login: string; type?: string };
    created_at: string;
    updated_at: string;
  };
  repository?: {
    full_name: string;
  };
  installation?: {
    id: number;
  };
  // The `installation` event payload carries `installation.deleted`
  // / `installation.suspend` / `installation.unsuspend` shapes that
  // include the installation id at the top level (not nested under
  // pull_request). WebhookService uses this to evict the cached
  // Octokit when GitHub tells us the install is gone. Optional like
  // everything else in this type — only present on `installation`
  // event deliveries.
  sender?: {
    login: string;
  };
}
