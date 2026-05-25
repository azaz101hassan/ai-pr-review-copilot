// Persistent shape of a pull request as we store it. Columns match
// pull_requests in schema.sql one-to-one.
export interface PullRequestRecord {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string;
  state: string;
  head_sha: string;
  base_sha: string;
  author_login: string;
  created_at: string;
  updated_at: string;
  raw_payload: string;
}
