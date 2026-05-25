// Shape of the JSON GitHub sends for the events we care about today.
// Optional fields reflect the union of pull_request / push / ping deliveries
// — the controller does not assume any of them are populated.
export interface GithubWebhookPayload {
  action?: string;
  pull_request?: {
    node_id: string;
    number: number;
    title: string;
    state: string;
    head: { sha: string };
    base: { sha: string };
    user: { login: string };
    created_at: string;
    updated_at: string;
  };
  repository?: {
    full_name: string;
  };
}
