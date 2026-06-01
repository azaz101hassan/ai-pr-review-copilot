import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';
import { ReviewFilterSpec } from '@/modules/reviews/types/review.repository';

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
    walkthrough_comment_id: null,
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

  describe('findRecentMatching', () => {
    const BASE_AT = new Date('2026-05-27T10:00:00Z');

    function savePr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
      const pr = makePr(overrides);
      repo.save(pr);
      return pr;
    }

    it('returns all PRs when spec is empty, ordered by created_at DESC', () => {
      savePr({ node_id: 'PR_1', number: 1, created_at: new Date(BASE_AT.getTime()) });
      savePr({ node_id: 'PR_2', number: 2, created_at: new Date(BASE_AT.getTime() + 1_000) });
      savePr({ node_id: 'PR_3', number: 3, created_at: new Date(BASE_AT.getTime() + 2_000) });

      const result = repo.findRecentMatching({}, 10);
      expect(result).toHaveLength(3);
      expect(result[0].node_id).toBe('PR_3');
      expect(result[1].node_id).toBe('PR_2');
      expect(result[2].node_id).toBe('PR_1');
    });

    it('filters by repo_full_name when spec.repo is set', () => {
      savePr({ node_id: 'PR_main', number: 1, repo_full_name: 'octocat/hello-world' });
      savePr({ node_id: 'PR_other', number: 2, repo_full_name: 'org/other' });

      const spec: ReviewFilterSpec = { repo: 'octocat/hello-world' };
      const result = repo.findRecentMatching(spec, 10);
      expect(result).toHaveLength(1);
      expect(result[0].node_id).toBe('PR_main');
    });

    it('filters by author_login when spec.author is set', () => {
      savePr({ node_id: 'PR_octocat', number: 1, author_login: 'octocat' });
      savePr({ node_id: 'PR_alice', number: 2, author_login: 'alice' });

      const spec: ReviewFilterSpec = { author: 'alice' };
      const result = repo.findRecentMatching(spec, 10);
      expect(result).toHaveLength(1);
      expect(result[0].node_id).toBe('PR_alice');
    });

    it('respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        savePr({ node_id: `PR_lim_${i}`, number: i + 10 });
      }
      const result = repo.findRecentMatching({}, 3);
      expect(result).toHaveLength(3);
    });

    it('returns empty array when no PRs match', () => {
      savePr({ node_id: 'PR_one', number: 1 });
      const result = repo.findRecentMatching({ repo: 'nobody/norepo' }, 10);
      expect(result).toEqual([]);
    });

    it('returned shape has expected PullRequestSummary fields', () => {
      savePr({ node_id: 'PR_shape', number: 99 });
      const result = repo.findRecentMatching({}, 1);
      expect(result[0]).toMatchObject({
        node_id: 'PR_shape',
        repo_full_name: expect.any(String),
        number: expect.any(Number),
        title: expect.any(String),
        author_login: expect.any(String),
        created_at: expect.any(Date),
      });
      // raw_payload must NOT be present in the summary
      expect((result[0] as unknown as Record<string, unknown>).raw_payload).toBeUndefined();
    });
  });

  describe('walkthrough_comment_id round-trip', () => {
    it('returns null when no walkthrough comment id has been set', () => {
      const pr = makePr();
      repo.save(pr);
      expect(repo.getWalkthroughCommentId(pr.node_id)).toBeNull();
    });

    it('round-trips a non-null id', () => {
      const pr = makePr();
      repo.save(pr);
      repo.setWalkthroughCommentId(pr.node_id, 123_456_789);
      expect(repo.getWalkthroughCommentId(pr.node_id)).toBe(123_456_789);
    });

    it('setting to null clears a previously set id', () => {
      const pr = makePr();
      repo.save(pr);
      repo.setWalkthroughCommentId(pr.node_id, 42);
      repo.setWalkthroughCommentId(pr.node_id, null);
      expect(repo.getWalkthroughCommentId(pr.node_id)).toBeNull();
    });

    it('does not clobber other PR columns when updating the id', () => {
      const pr = makePr({ title: 'Original' });
      repo.save(pr);
      repo.setWalkthroughCommentId(pr.node_id, 99);
      const found = repo.findByNodeId(pr.node_id);
      expect(found?.title).toBe('Original');
      expect(found?.walkthrough_comment_id).toBe(99);
    });

    it('throws when setting on a non-existent PR', () => {
      expect(() =>
        repo.setWalkthroughCommentId('PR_doesnotexist', 1),
      ).toThrow();
    });

    it('returns null for getWalkthroughCommentId on a non-existent PR', () => {
      expect(repo.getWalkthroughCommentId('PR_doesnotexist')).toBeNull();
    });
  });
});
