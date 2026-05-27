import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqliteKnowledgeSourcesRepository } from '../../../../src/infrastructure/db/repositories/sqlite-knowledge-sources.repository';
import { SqliteKnowledgeChunksRepository } from '../../../../src/infrastructure/db/repositories/sqlite-knowledge-chunks.repository';
import { KnowledgeChunkInsert } from '@/modules/embeddings/types/knowledge-chunk.types';

const SOURCE_ID = 'airbnb-eslint';
const NOW = new Date('2026-05-26T10:00:00Z');

function makeChunk(overrides: Partial<KnowledgeChunkInsert> = {}): KnowledgeChunkInsert {
  const rule_id = overrides.rule_id ?? 'eqeqeq';
  return {
    id: `${SOURCE_ID}:${rule_id}`,
    source_id: SOURCE_ID,
    rule_id,
    title: 'Require === and !==',
    body: 'Always use strict equality.',
    severity: 'error',
    language: 'javascript',
    category: 'best-practices',
    embedding_model: 'voyage-code-3',
    embedding_dim: 1024,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('SqliteKnowledgeChunksRepository', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let sources: SqliteKnowledgeSourcesRepository;
  let repo: SqliteKnowledgeChunksRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-chunk-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    sources = new SqliteKnowledgeSourcesRepository(db);
    repo = new SqliteKnowledgeChunksRepository(db);

    // FK parent row — chunks reference knowledge_sources(id). The FK is
    // enforced because DatabaseService.open() turns PRAGMA foreign_keys
    // ON. Without this, every chunk insert below would fail.
    sources.upsert({
      id: SOURCE_ID,
      name: 'Airbnb ESLint',
      description: null,
      created_at: NOW,
    });
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsertMany inserts a batch and findByIds reads it back', () => {
    const records: KnowledgeChunkInsert[] = Array.from({ length: 50 }, (_, i) =>
      makeChunk({ rule_id: `rule-${i}` }),
    );

    repo.upsertMany(records);

    const ids = records.map((r) => r.id);
    const found = repo.findByIds(ids);

    expect(found).toHaveLength(50);
    expect(found.map((row) => row.id).sort()).toEqual(ids.sort());
  });

  it('findByIds preserves input order and drops unknown ids', () => {
    repo.upsertMany([
      makeChunk({ rule_id: 'a' }),
      makeChunk({ rule_id: 'b' }),
      makeChunk({ rule_id: 'c' }),
    ]);

    const result = repo.findByIds([
      `${SOURCE_ID}:c`,
      `${SOURCE_ID}:unknown`,
      `${SOURCE_ID}:a`,
      `${SOURCE_ID}:b`,
    ]);

    expect(result.map((row) => row.rule_id)).toEqual(['c', 'a', 'b']);
  });

  it('findByIds returns [] for empty input without a SQL error', () => {
    expect(repo.findByIds([])).toEqual([]);
  });

  it('findByIds returns [] when no ids match', () => {
    expect(repo.findByIds(['nope', 'also-nope'])).toEqual([]);
  });

  it('upsertMany updates rows on conflicting (source_id, rule_id)', () => {
    repo.upsertMany([makeChunk({ rule_id: 'no-var', title: 'First' })]);
    repo.upsertMany([makeChunk({ rule_id: 'no-var', title: 'Second' })]);

    const found = repo.findById(`${SOURCE_ID}:no-var`);
    expect(found?.title).toBe('Second');
  });

  it('upsertMany rejects rows with a source_id that has no parent (FK enforced)', () => {
    const orphan = makeChunk({
      source_id: 'unknown-source',
      id: 'unknown-source:eqeqeq',
    });

    expect(() => repo.upsertMany([orphan])).toThrow(/FOREIGN KEY/i);
  });

  it('upsertMany([]) is a no-op (no transaction, no error)', () => {
    expect(() => repo.upsertMany([])).not.toThrow();
  });

  it('deleteBySourceId removes all chunks for that source and returns the count', () => {
    repo.upsertMany([
      makeChunk({ rule_id: 'a' }),
      makeChunk({ rule_id: 'b' }),
      makeChunk({ rule_id: 'c' }),
    ]);

    const deleted = repo.deleteBySourceId(SOURCE_ID);

    expect(deleted).toBe(3);
    expect(repo.findById(`${SOURCE_ID}:a`)).toBeUndefined();
    expect(repo.findById(`${SOURCE_ID}:b`)).toBeUndefined();
  });

  it('deleteBySourceId returns 0 when the source has no chunks', () => {
    expect(repo.deleteBySourceId(SOURCE_ID)).toBe(0);
  });
});
