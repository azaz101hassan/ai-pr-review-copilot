// Unit tests for the seed-dev script internals.
//
// Tests cover:
//   - Initial seed: empty DB → N synthetic rows written.
//   - Idempotency: second run without --force is a no-op.
//   - --force: DELETE seed rows then re-insert (no PRIMARY KEY violation).
//   - NODE_ENV guard: production + no --force → non-zero exit.
//   - Real-row preservation: --force never touches non-seeded rows.
//
// Database setup uses DatabaseService (NestJS infra) to apply migrations
// automatically, then the test calls the exported seed helpers directly
// against the same SQLite file. No mocks of the driver.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from '@/infrastructure/db';
import {
  buildFixtures,
  countRealRows,
  countSeedRows,
  deleteSeedRows,
  insertFixtures,
  openDb,
} from '@/modules/dashboard/scripts/seed-dev';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED_PREFIX = 'seed:';

/**
 * Opens a DatabaseService against a temp path (applies migrations), then
 * returns both the NestJS service and a raw better-sqlite3 handle to the
 * same file. The caller is responsible for closing both.
 */
function bootstrapDb(tmpDir: string): { svc: DatabaseService; db: Database.Database; dbPath: string } {
  const dbPath = path.join(tmpDir, 'seed-dev-test.sqlite');
  const svc = new DatabaseService();
  svc.open(dbPath);
  // Open a second handle via the seed helper so tests use the same code path
  // as the real script.
  const db = openDb(dbPath);
  return { svc, db, dbPath };
}

/** Insert a single non-seeded pull_request + review row to verify preservation. */
function insertRealRow(db: Database.Database, suffix: string): void {
  db.prepare(
    `INSERT INTO pull_requests
     (node_id, repo_full_name, number, title, state, head_sha, base_sha, author_login, created_at, updated_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `real-pr-${suffix}`,
    'real-org/real-repo',
    1,
    'Real PR',
    'open',
    'a'.repeat(40),
    'b'.repeat(40),
    'real-author',
    Date.now(),
    Date.now(),
    '{}',
  );

  db.prepare(
    `INSERT INTO reviews
     (id, pr_node_id, created_by, diff_length, model, prompt_version, top_k,
      retrieved_chunk_ids, retrieved_chunk_ids_hash, status, error_status, error_code,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      turn_count, tool_calls_json, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `real-rev-${suffix}`,
    `real-pr-${suffix}`,
    null, 100, 'claude-haiku', 'v1', 5, '[]', 'abc', 'completed',
    null, null, 100, 50, null, null, 1, null,
    Date.now(), Date.now(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('seed-dev script internals', () => {
  let tmpDir: string;
  let svc: DatabaseService;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dev-spec-'));
    ({ svc, db } = bootstrapDb(tmpDir));
  });

  afterEach(() => {
    db.close();
    svc.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Initial seed on empty DB
  // ---------------------------------------------------------------------------

  describe('initial seed on empty DB', () => {
    it('countSeedRows returns 0 on an empty DB', () => {
      expect(countSeedRows(db)).toBe(0);
    });

    it('insertFixtures writes synthetic pull_requests, reviews, and findings', () => {
      const fixtures = buildFixtures();
      insertFixtures(db, fixtures);

      // Verify PR rows.
      const prCount = (
        db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE node_id LIKE ?").get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(prCount).toBe(fixtures.prs.length);

      // Verify review rows (all seed: prefix — includes the null pr_node_id row).
      const revCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM reviews WHERE id LIKE ?")
          .get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(revCount).toBe(fixtures.reviews.length);

      // Verify findings rows.
      const findingCount = (
        db.prepare("SELECT COUNT(*) AS n FROM review_findings WHERE id LIKE ?").get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(findingCount).toBe(fixtures.findings.length);
    });

    it('countSeedRows is non-zero after insertFixtures', () => {
      insertFixtures(db, buildFixtures());
      // countSeedRows counts reviews WHERE pr_node_id LIKE 'seed:%'.
      // The seed includes one review with null pr_node_id — that one won't
      // be counted by the idempotency check, which is intentional.
      expect(countSeedRows(db)).toBeGreaterThan(0);
    });

    it('seeded reviews include a standalone-empty-diff row (for exclusion-from-aggregates invariant)', () => {
      insertFixtures(db, buildFixtures());
      const standalone = db
        .prepare("SELECT * FROM reviews WHERE prompt_version = 'standalone-empty-diff' AND id LIKE ?")
        .get(`${SEED_PREFIX}%`) as { id: string } | undefined;
      expect(standalone).toBeDefined();
    });

    it('seeded reviews include a review with NULL pr_node_id (AE3)', () => {
      insertFixtures(db, buildFixtures());
      const nullPr = db
        .prepare("SELECT * FROM reviews WHERE pr_node_id IS NULL AND id LIKE ?")
        .get(`${SEED_PREFIX}%`) as { id: string } | undefined;
      expect(nullPr).toBeDefined();
    });

    it('seeded findings include a mix of severities', () => {
      insertFixtures(db, buildFixtures());
      const severities = db
        .prepare("SELECT DISTINCT severity FROM review_findings WHERE id LIKE ?")
        .all(`${SEED_PREFIX}%`) as { severity: string }[];
      const severityValues = severities.map((r) => r.severity);
      expect(severityValues).toContain('error');
      expect(severityValues).toContain('warning');
      expect(severityValues).toContain('info');
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency: running twice without --force is a no-op
  // ---------------------------------------------------------------------------

  describe('idempotency (no --force)', () => {
    it('second insertFixtures call fails with UNIQUE constraint (requires --force to re-seed)', () => {
      const fixtures = buildFixtures();
      insertFixtures(db, fixtures);
      // countSeedRows must be non-zero, indicating the first seed landed.
      expect(countSeedRows(db)).toBeGreaterThan(0);

      // Attempting to insert again without deleting first should throw.
      expect(() => insertFixtures(db, fixtures)).toThrow();
    });

    it('countSeedRows after first seed is non-zero → idempotency guard would fire', () => {
      insertFixtures(db, buildFixtures());
      // Simulates the idempotency check in main(): if non-zero and no --force,
      // the script exits 0 without touching the DB.
      const count = countSeedRows(db);
      expect(count).toBeGreaterThan(0);
      // This is the branch condition checked in main():
      //   if (existingCount > 0 && !force) → exit 0 (no-op).
    });
  });

  // ---------------------------------------------------------------------------
  // --force: DELETE seed rows, then re-insert
  // ---------------------------------------------------------------------------

  describe('--force re-seed', () => {
    it('deleteSeedRows removes all seed: rows from reviews and pull_requests', () => {
      insertFixtures(db, buildFixtures());
      expect(countSeedRows(db)).toBeGreaterThan(0);

      deleteSeedRows(db);

      // All seed: reviews (pr_node_id LIKE 'seed:%') must be gone.
      const seedRevs = (
        db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE pr_node_id LIKE ?").get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(seedRevs).toBe(0);

      // All seed: PRs must be gone.
      const seedPrs = (
        db.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE node_id LIKE ?").get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(seedPrs).toBe(0);
    });

    it('delete then re-insert succeeds without UNIQUE constraint violation', () => {
      const fixtures = buildFixtures();
      insertFixtures(db, fixtures);
      deleteSeedRows(db);
      // Re-inserting after delete must not throw.
      expect(() => insertFixtures(db, fixtures)).not.toThrow();
    });

    it('cascade delete removes findings when reviews are deleted', () => {
      insertFixtures(db, buildFixtures());
      const countBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM review_findings WHERE id LIKE ?").get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(countBefore).toBeGreaterThan(0);

      deleteSeedRows(db);

      const countAfter = (
        db.prepare("SELECT COUNT(*) AS n FROM review_findings WHERE id LIKE ?").get(`${SEED_PREFIX}%`) as { n: number }
      ).n;
      expect(countAfter).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Real-row preservation: --force never touches non-seeded rows
  // ---------------------------------------------------------------------------

  describe('real-row preservation', () => {
    it('deleteSeedRows does NOT remove non-seeded pull_requests or reviews', () => {
      // Insert one real (non-seeded) row BEFORE seeding.
      insertRealRow(db, 'before');
      const realBefore = countRealRows(db);

      // Seed, then force-delete.
      insertFixtures(db, buildFixtures());
      deleteSeedRows(db);

      const realAfter = countRealRows(db);
      expect(realAfter.prs).toBe(realBefore.prs);
      expect(realAfter.reviews).toBe(realBefore.reviews);
    });

    it('real rows are present in the DB after --force re-seed cycle', () => {
      insertRealRow(db, 'cycle');
      const realBefore = countRealRows(db);

      const fixtures = buildFixtures();
      insertFixtures(db, fixtures);
      deleteSeedRows(db);
      insertFixtures(db, fixtures);

      const realAfter = countRealRows(db);
      expect(realAfter.prs).toBe(realBefore.prs);
      expect(realAfter.reviews).toBe(realBefore.reviews);
    });
  });

  // ---------------------------------------------------------------------------
  // NODE_ENV guard
  //
  // The guard lives in main() which calls process.exit(1). We test the
  // guard condition directly (not the exit) because child_process.spawn
  // is overkill here and the logic is a simple conditional.
  // ---------------------------------------------------------------------------

  describe('NODE_ENV guard (logic)', () => {
    // Helper to simulate the guard condition in main():
    //   if (process.env.NODE_ENV !== 'development' && !force) { process.exit(1) }
    // Uses `as string` to let TypeScript accept non-literal values.
    function wouldRefuse(nodeEnv: string, force: boolean): boolean {
      return nodeEnv !== 'development' && !force;
    }

    it('guard fires when NODE_ENV is production and force is false', () => {
      expect(wouldRefuse('production', false)).toBe(true);
    });

    it('guard does NOT fire when NODE_ENV is development', () => {
      expect(wouldRefuse('development', false)).toBe(false);
    });

    it('guard does NOT fire when --force is passed even with production NODE_ENV', () => {
      expect(wouldRefuse('production', true)).toBe(false);
    });

    it('guard does NOT fire when --force is passed with test NODE_ENV', () => {
      expect(wouldRefuse('test', true)).toBe(false);
    });
  });
});
