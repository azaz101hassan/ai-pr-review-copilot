import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '@/infrastructure/db/database.service';

describe('reviews migration — check_run_id + walkthrough_summary columns', () => {
  let dir: string;
  let db: DatabaseService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviews-migration-'));
    db = new DatabaseService();
    db.open(join(dir, 'test.sqlite'));
  });

  afterAll(() => {
    db.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds check_run_id as a nullable INTEGER column', () => {
    const raw = db.getDb();
    const cols = raw.prepare("PRAGMA table_info('reviews')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const checkRunId = cols.find((c) => c.name === 'check_run_id');
    expect(checkRunId).toBeDefined();
    expect(checkRunId?.type.toUpperCase()).toBe('INTEGER');
    expect(checkRunId?.notnull).toBe(0);
  });

  it('adds walkthrough_summary as a nullable TEXT column', () => {
    const raw = db.getDb();
    const cols = raw.prepare("PRAGMA table_info('reviews')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const summary = cols.find((c) => c.name === 'walkthrough_summary');
    expect(summary).toBeDefined();
    expect(summary?.type.toUpperCase()).toBe('TEXT');
    expect(summary?.notnull).toBe(0);
  });
});
