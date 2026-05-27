import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqliteKnowledgeSourcesRepository } from '../../../../src/infrastructure/db/repositories/sqlite-knowledge-sources.repository';
import { KnowledgeSourceInsert } from '@/modules/embeddings/types/knowledge-source.types';

function makeSource(overrides: Partial<KnowledgeSourceInsert> = {}): KnowledgeSourceInsert {
  return {
    id: 'airbnb-eslint',
    name: 'Airbnb ESLint',
    description: 'Curated Airbnb JavaScript style guide rules',
    created_at: new Date('2026-05-26T10:00:00Z'),
    ...overrides,
  };
}

describe('SqliteKnowledgeSourcesRepository', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let repo: SqliteKnowledgeSourcesRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-src-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    repo = new SqliteKnowledgeSourcesRepository(db);
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a knowledge source', () => {
    const source = makeSource();
    repo.upsert(source);

    const found = repo.findById(source.id);
    expect(found).toEqual(source);
  });

  it('upsert updates an existing row instead of failing', () => {
    repo.upsert(makeSource({ name: 'Original' }));
    repo.upsert(makeSource({ name: 'Renamed', description: 'Updated' }));

    const found = repo.findById('airbnb-eslint');
    expect(found?.name).toBe('Renamed');
    expect(found?.description).toBe('Updated');
  });

  it('findById returns undefined for unknown id', () => {
    expect(repo.findById('does-not-exist')).toBeUndefined();
  });

  it('listAll returns every inserted source', () => {
    repo.upsert(makeSource({ id: 'airbnb-eslint', name: 'Airbnb' }));
    repo.upsert(makeSource({ id: 'team-standards', name: 'Team' }));

    const all = repo.listAll();
    const ids = all.map((row) => row.id).sort();
    expect(ids).toEqual(['airbnb-eslint', 'team-standards']);
  });

  it('upsert accepts a null description', () => {
    repo.upsert(makeSource({ description: null }));

    const found = repo.findById('airbnb-eslint');
    expect(found?.description).toBeNull();
  });
});
