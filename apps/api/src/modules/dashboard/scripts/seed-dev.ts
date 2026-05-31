// Dev-seed script — `npm run seed:dev --workspace apps/api`.
//
// Populates the local SQLite database with synthetic review fixtures so the
// dashboard has data to display without requiring a live PR or GitHub App.
//
// Guards:
//   1. NODE_ENV must be 'development' unless --force is passed.
//   2. Idempotency: if seed: rows already exist and --force is absent,
//      the script prints the count and exits without touching the DB.
//   3. --force is the SINGLE flag that bypasses both guards (NODE_ENV
//      check AND the idempotency check). It deletes existing seed rows
//      in FK order before re-inserting — the PRIMARY KEY on
//      pull_requests.node_id is never violated.
//
// Seed-row marker: pr_node_id / node_id LIKE 'seed:%'. No schema migration.
// Real rows (no seed: prefix) are NEVER touched.
//
// End with process.exit(0) — scripts hang without an explicit exit.

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEED_PREFIX = 'seed:';
const SEED_REPO = 'seed-org/sample-repo';
const SEED_AUTHOR = 'seed-author';
const SEED_PR_COUNT = 4;

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

interface SeedPr {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  head_sha: string;
  base_sha: string;
  author_login: string;
  created_at: number; // epoch ms stored as INTEGER
  updated_at: number;
  raw_payload: string;
}

interface SeedReview {
  id: string;
  pr_node_id: string | null;
  created_by: string | null;
  diff_length: number;
  model: string;
  prompt_version: string;
  top_k: number;
  retrieved_chunk_ids: string;
  retrieved_chunk_ids_hash: string;
  status: 'completed' | 'failed';
  error_status: number | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  turn_count: number;
  tool_calls_json: string | null;
  created_at: number;
  completed_at: number | null;
}

interface SeedFinding {
  id: string;
  review_id: string;
  rule_id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  location_hint: string | null;
  citation: string | null;
  created_at: number;
}

export function buildFixtures(): { prs: SeedPr[]; reviews: SeedReview[]; findings: SeedFinding[] } {
  const now = Date.now();
  const hour = 3_600_000;
  const day = 24 * hour;

  const prs: SeedPr[] = Array.from({ length: SEED_PR_COUNT }, (_, i) => ({
    node_id: `${SEED_PREFIX}${SEED_REPO}/${i + 1}`,
    repo_full_name: SEED_REPO,
    number: i + 1,
    title: `Seed PR #${i + 1} — fixture`,
    state: i % 2 === 0 ? 'open' : 'closed',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    author_login: SEED_AUTHOR,
    created_at: now - (i + 1) * day,
    updated_at: now - i * hour,
    raw_payload: JSON.stringify({ seed: true, index: i }),
  }));

  const seedReviews: SeedReview[] = [
    // Completed review with token costs — primary analytics scenario.
    {
      id: `${SEED_PREFIX}rev-completed-1`,
      pr_node_id: `${SEED_PREFIX}${SEED_REPO}/1`,
      created_by: null,
      diff_length: 850,
      model: 'claude-sonnet-4-5',
      prompt_version: 'v2',
      top_k: 10,
      retrieved_chunk_ids: '["chunk-1","chunk-2","chunk-3"]',
      retrieved_chunk_ids_hash: 'abc123',
      status: 'completed',
      error_status: null,
      error_code: null,
      input_tokens: 12_000,
      output_tokens: 800,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 8_000,
      turn_count: 2,
      tool_calls_json: null,
      created_at: now - 2 * day,
      completed_at: now - 2 * day + 45_000,
    },
    // Completed review with higher token cost for percentile variance.
    {
      id: `${SEED_PREFIX}rev-completed-2`,
      pr_node_id: `${SEED_PREFIX}${SEED_REPO}/2`,
      created_by: null,
      diff_length: 3200,
      model: 'claude-sonnet-4-5',
      prompt_version: 'v2',
      top_k: 10,
      retrieved_chunk_ids: '["chunk-1","chunk-4"]',
      retrieved_chunk_ids_hash: 'def456',
      status: 'completed',
      error_status: null,
      error_code: null,
      input_tokens: 28_000,
      output_tokens: 1_500,
      cache_creation_input_tokens: 5_000,
      cache_read_input_tokens: 22_000,
      turn_count: 3,
      tool_calls_json: null,
      created_at: now - 1 * day,
      completed_at: now - 1 * day + 120_000,
    },
    // Completed review with NULL pr_node_id — AE3 scenario (no PR metadata).
    {
      id: `${SEED_PREFIX}rev-null-pr`,
      pr_node_id: null,
      created_by: null,
      diff_length: 200,
      model: 'claude-haiku-4-5',
      prompt_version: 'v2',
      top_k: 5,
      retrieved_chunk_ids: '["chunk-2"]',
      retrieved_chunk_ids_hash: 'ghi789',
      status: 'completed',
      error_status: null,
      error_code: null,
      input_tokens: 4_000,
      output_tokens: 200,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      turn_count: 1,
      tool_calls_json: null,
      created_at: now - 6 * hour,
      completed_at: now - 6 * hour + 20_000,
    },
    // Failed review with NULL token fields — pre-LLM failure path.
    {
      id: `${SEED_PREFIX}rev-failed-1`,
      pr_node_id: `${SEED_PREFIX}${SEED_REPO}/3`,
      created_by: null,
      diff_length: 450,
      model: 'claude-sonnet-4-5',
      prompt_version: 'v2',
      top_k: 10,
      retrieved_chunk_ids: '[]',
      retrieved_chunk_ids_hash: 'jkl012',
      status: 'failed',
      error_status: 429,
      error_code: 'rate_limit_error',
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      turn_count: 0,
      tool_calls_json: null,
      created_at: now - 3 * day,
      completed_at: now - 3 * day + 5_000,
    },
    // Standalone-empty-diff row — must be EXCLUDED from analytics aggregates
    // but visible in the reviews list. Exercises the exclusion invariant.
    {
      id: `${SEED_PREFIX}rev-standalone`,
      pr_node_id: `${SEED_PREFIX}${SEED_REPO}/4`,
      created_by: null,
      diff_length: 0,
      model: 'claude-sonnet-4-5',
      prompt_version: 'standalone-empty-diff',
      top_k: 10,
      retrieved_chunk_ids: '[]',
      retrieved_chunk_ids_hash: 'mno345',
      status: 'completed',
      error_status: null,
      error_code: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      turn_count: 0,
      tool_calls_json: null,
      created_at: now - 4 * day,
      completed_at: now - 4 * day + 1_000,
    },
  ];

  // Findings linked to the two completed reviews (with real PR rows).
  const seedFindings: SeedFinding[] = [
    // rev-completed-1: one error, two warnings
    {
      id: `${SEED_PREFIX}finding-1`,
      review_id: `${SEED_PREFIX}rev-completed-1`,
      rule_id: 'no-direct-db-access',
      severity: 'error',
      title: 'Direct DB access in controller',
      message: 'Controllers must not access the database directly; use a service layer.',
      location_hint: 'src/some.controller.ts:42',
      citation: 'The tier rule (CLAUDE.md) forbids direct DB access from controllers.',
      created_at: now - 2 * day + 46_000,
    },
    {
      id: `${SEED_PREFIX}finding-2`,
      review_id: `${SEED_PREFIX}rev-completed-1`,
      rule_id: 'missing-validation-pipe',
      severity: 'warning',
      title: 'DTO missing @IsString() decorator',
      message: 'The inbound DTO field `name` lacks a validation decorator.',
      location_hint: 'src/some.dto.ts:10',
      citation: null,
      created_at: now - 2 * day + 46_500,
    },
    {
      id: `${SEED_PREFIX}finding-3`,
      review_id: `${SEED_PREFIX}rev-completed-1`,
      rule_id: 'prefer-path-alias',
      severity: 'info',
      title: 'Relative import instead of path alias',
      message: 'Use @/infrastructure/db instead of a relative path.',
      location_hint: 'src/some.module.ts:5',
      citation: 'CLAUDE.md path alias convention.',
      created_at: now - 2 * day + 47_000,
    },
    // rev-completed-2: one warning, one info
    {
      id: `${SEED_PREFIX}finding-4`,
      review_id: `${SEED_PREFIX}rev-completed-2`,
      rule_id: 'missing-validation-pipe',
      severity: 'warning',
      title: 'Unbounded query param not validated',
      message: 'The `limit` param has no @Max() decorator — a caller can request all rows.',
      location_hint: 'src/other.controller.ts:88',
      citation: null,
      created_at: now - 1 * day + 121_000,
    },
    {
      id: `${SEED_PREFIX}finding-5`,
      review_id: `${SEED_PREFIX}rev-completed-2`,
      rule_id: 'prefer-path-alias',
      severity: 'info',
      title: 'Relative import in test file',
      message: 'Test imports should use @/ aliases to stay refactor-safe.',
      location_hint: 'test/other.spec.ts:3',
      citation: null,
      created_at: now - 1 * day + 121_500,
    },
  ];

  return { prs, reviews: seedReviews, findings: seedFindings };
}

// ---------------------------------------------------------------------------
// DB helpers (raw better-sqlite3 — no NestJS context needed)
// Exported for unit tests.
// ---------------------------------------------------------------------------

export function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function countSeedRows(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM reviews WHERE pr_node_id LIKE ?")
    .get(`${SEED_PREFIX}%`) as { n: number };
  return row.n;
}

export function deleteSeedRows(db: Database.Database): void {
  // Delete in FK order: review_findings are cascade-deleted with reviews,
  // so we only need to delete reviews then pull_requests.
  db.prepare("DELETE FROM reviews WHERE pr_node_id LIKE ?").run(`${SEED_PREFIX}%`);
  // Also delete reviews with null pr_node_id that have a seed: id prefix.
  db.prepare("DELETE FROM reviews WHERE id LIKE ? AND pr_node_id IS NULL").run(`${SEED_PREFIX}%`);
  db.prepare("DELETE FROM pull_requests WHERE node_id LIKE ?").run(`${SEED_PREFIX}%`);
}

export function countRealRows(db: Database.Database): { prs: number; reviews: number } {
  const prRow = db
    .prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE node_id NOT LIKE ?")
    .get(`${SEED_PREFIX}%`) as { n: number };
  const revRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM reviews WHERE (pr_node_id NOT LIKE ? OR pr_node_id IS NULL) AND id NOT LIKE ?",
    )
    .get(`${SEED_PREFIX}%`, `${SEED_PREFIX}%`) as { n: number };
  return { prs: prRow.n, reviews: revRow.n };
}

export function insertFixtures(db: Database.Database, fixtures: ReturnType<typeof buildFixtures>): void {
  const insertPr = db.prepare(
    `INSERT INTO pull_requests
     (node_id, repo_full_name, number, title, state, head_sha, base_sha, author_login, created_at, updated_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReview = db.prepare(
    `INSERT INTO reviews
     (id, pr_node_id, created_by, diff_length, model, prompt_version, top_k,
      retrieved_chunk_ids, retrieved_chunk_ids_hash, status, error_status, error_code,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      turn_count, tool_calls_json, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFinding = db.prepare(
    `INSERT INTO review_findings
     (id, review_id, rule_id, severity, title, message, location_hint, citation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Use a transaction so the full fixture set is atomic.
  db.transaction(() => {
    for (const pr of fixtures.prs) {
      insertPr.run(
        pr.node_id, pr.repo_full_name, pr.number, pr.title, pr.state,
        pr.head_sha, pr.base_sha, pr.author_login,
        pr.created_at, pr.updated_at, pr.raw_payload,
      );
    }
    for (const rev of fixtures.reviews) {
      insertReview.run(
        rev.id, rev.pr_node_id, rev.created_by, rev.diff_length, rev.model,
        rev.prompt_version, rev.top_k, rev.retrieved_chunk_ids,
        rev.retrieved_chunk_ids_hash, rev.status, rev.error_status, rev.error_code,
        rev.input_tokens, rev.output_tokens, rev.cache_creation_input_tokens,
        rev.cache_read_input_tokens, rev.turn_count, rev.tool_calls_json,
        rev.created_at, rev.completed_at,
      );
    }
    for (const f of fixtures.findings) {
      insertFinding.run(
        f.id, f.review_id, f.rule_id, f.severity, f.title, f.message,
        f.location_hint, f.citation, f.created_at,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  // Guard 1: NODE_ENV must be 'development' unless --force is passed.
  if (process.env.NODE_ENV !== 'development' && !force) {
    // eslint-disable-next-line no-console
    console.error(
      'seed:dev refuses to run outside NODE_ENV=development. Pass --force to override.',
    );
    process.exit(1);
  }

  const dbPath = path.resolve(process.env.DATABASE_PATH ?? './data/app.sqlite');
  // eslint-disable-next-line no-console
  console.log(`seed:dev — target DB: ${dbPath}`);

  const db = openDb(dbPath);

  // Guard 2 (idempotency): if seed rows already exist and --force is absent,
  // print the count and exit without touching the DB.
  const existingCount = countSeedRows(db);
  if (existingCount > 0 && !force) {
    // eslint-disable-next-line no-console
    console.log(
      `seed:dev — ${existingCount} seed row(s) already exist. Pass --force to re-seed.`,
    );
    db.close();
    process.exit(0);
  }

  // --force: delete existing seed rows in FK order, then re-insert.
  if (force && existingCount > 0) {
    const realBefore = countRealRows(db);
    // eslint-disable-next-line no-console
    console.log(`seed:dev --force — deleting ${existingCount} existing seed row(s) and re-seeding.`);
    deleteSeedRows(db);
    const realAfter = countRealRows(db);
    // Verify that no real rows were harmed.
    if (realAfter.prs !== realBefore.prs || realAfter.reviews !== realBefore.reviews) {
      // eslint-disable-next-line no-console
      console.error(
        `seed:dev — ABORT: real row count changed during delete! ` +
          `PRs: ${realBefore.prs} → ${realAfter.prs}, reviews: ${realBefore.reviews} → ${realAfter.reviews}`,
      );
      db.close();
      process.exit(1);
    }
  }

  const fixtures = buildFixtures();
  // eslint-disable-next-line no-console
  console.log(
    `seed:dev — inserting ${fixtures.prs.length} pull_requests, ` +
      `${fixtures.reviews.length} reviews, ${fixtures.findings.length} findings.`,
  );

  insertFixtures(db, fixtures);
  db.close();

  // eslint-disable-next-line no-console
  console.log(`seed:dev — done. Open localhost:4001/dashboard/reviews to verify.`);
}

// Only invoke main() when this file is run directly (not when imported by tests).
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('seed:dev failed:', err);
      process.exit(1);
    });
}
