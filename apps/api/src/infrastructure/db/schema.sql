-- Day 1 schema. CREATE TABLE IF NOT EXISTS keeps boot idempotent.

CREATE TABLE IF NOT EXISTS pull_requests (
  node_id        TEXT    PRIMARY KEY,
  repo_full_name TEXT    NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  state          TEXT    NOT NULL,
  head_sha       TEXT    NOT NULL,
  base_sha       TEXT    NOT NULL,
  author_login   TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  raw_payload    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_number
  ON pull_requests(repo_full_name, number);

CREATE TABLE IF NOT EXISTS webhook_events (
  delivery_id          TEXT    PRIMARY KEY,
  event_name           TEXT    NOT NULL,
  action               TEXT,
  pull_request_node_id TEXT,
  received_at          TEXT    NOT NULL,
  raw_payload          TEXT    NOT NULL,
  FOREIGN KEY (pull_request_node_id) REFERENCES pull_requests(node_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events(received_at);
