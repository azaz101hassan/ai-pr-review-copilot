import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';

function makePr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    node_id: 'PR_kwDOABCDEFG',
    repo_full_name: 'octocat/hello-world',
    number: 42,
    title: 'Add greetings',
    state: 'open',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    author_login: 'octocat',
    created_at: new Date('2026-05-25T10:00:00Z'),
    updated_at: new Date('2026-05-25T10:00:00Z'),
    raw_payload: JSON.stringify({ pull_request: { number: 42 } }),
    ...overrides,
  };
}

describe('SqlitePullRequestsRepository', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let repo: SqlitePullRequestsRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    repo = new SqlitePullRequestsRepository(db);
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a pull request', () => {
    const pr = makePr();
    repo.save(pr);

    const found = repo.findByNodeId(pr.node_id);
    expect(found).toEqual(pr);
  });

  it('upserts on conflict by node_id', () => {
    const original = makePr({ title: 'First title' });
    const updated = makePr({ title: 'Second title', state: 'closed' });
    repo.save(original);
    repo.save(updated);

    const found = repo.findByNodeId(original.node_id);
    expect(found?.title).toBe('Second title');
    expect(found?.state).toBe('closed');
  });

  it('returns undefined for unknown node_id', () => {
    expect(repo.findByNodeId('PR_doesnotexist')).toBeUndefined();
  });
});
