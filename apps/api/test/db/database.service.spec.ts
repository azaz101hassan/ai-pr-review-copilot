import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DatabaseService,
  PullRequestRecord,
  WebhookEventRecord,
} from '../../src/db/database.service';

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
    created_at: '2026-05-24T10:00:00Z',
    updated_at: '2026-05-24T10:00:00Z',
    raw_payload: JSON.stringify({ pull_request: { number: 42 } }),
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<WebhookEventRecord> = {},
): WebhookEventRecord {
  return {
    delivery_id: '11111111-2222-3333-4444-555555555555',
    event_name: 'pull_request',
    action: 'opened',
    pull_request_node_id: 'PR_kwDOABCDEFG',
    received_at: '2026-05-24T10:00:01Z',
    raw_payload: JSON.stringify({ action: 'opened' }),
    ...overrides,
  };
}

describe('DatabaseService', () => {
  let tmpDir: string;
  let dbPath: string;
  let service: DatabaseService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-copilot-db-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    service = new DatabaseService();
    service.open(dbPath);
  });

  afterEach(() => {
    service.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('schema bootstrap', () => {
    it('creates the pull_requests and webhook_events tables', () => {
      expect(service.hasTable('pull_requests')).toBe(true);
      expect(service.hasTable('webhook_events')).toBe(true);
    });

    it('applies the schema idempotently across reopens', () => {
      service.onApplicationShutdown();
      service.open(dbPath); // second open against the same file
      expect(service.hasTable('pull_requests')).toBe(true);
      expect(service.hasTable('webhook_events')).toBe(true);
    });

    it('enables foreign_keys', () => {
      const row = service.getDb().pragma('foreign_keys', { simple: true });
      expect(row).toBe(1);
    });
  });

  describe('pull_requests', () => {
    it('round-trips a pull request', () => {
      const pr = makePr();
      service.insertOrReplacePullRequest(pr);

      const found = service.findPullRequest(pr.node_id);
      expect(found).toEqual(pr);
    });

    it('upserts on conflict by node_id', () => {
      const original = makePr({ title: 'First title' });
      const updated = makePr({ title: 'Second title', state: 'closed' });
      service.insertOrReplacePullRequest(original);
      service.insertOrReplacePullRequest(updated);

      const found = service.findPullRequest(original.node_id);
      expect(found?.title).toBe('Second title');
      expect(found?.state).toBe('closed');
    });

    it('returns undefined for unknown node_id', () => {
      expect(service.findPullRequest('PR_doesnotexist')).toBeUndefined();
    });
  });

  describe('webhook_events', () => {
    it('round-trips an event linked to an existing PR', () => {
      const pr = makePr();
      service.insertOrReplacePullRequest(pr);
      const event = makeEvent({ pull_request_node_id: pr.node_id });
      service.insertWebhookEvent(event);

      expect(service.findWebhookEvent(event.delivery_id)).toEqual(event);
    });

    it('accepts a null pull_request_node_id (non-PR events)', () => {
      const event = makeEvent({
        delivery_id: 'evt-no-pr',
        event_name: 'push',
        action: null,
        pull_request_node_id: null,
      });
      service.insertWebhookEvent(event);

      const found = service.findWebhookEvent('evt-no-pr');
      expect(found?.pull_request_node_id).toBeNull();
    });

    it('rejects an event whose pull_request_node_id has no matching PR (FK)', () => {
      const orphan = makeEvent({
        delivery_id: 'evt-orphan',
        pull_request_node_id: 'PR_does_not_exist',
      });
      expect(() => service.insertWebhookEvent(orphan)).toThrow(
        /FOREIGN KEY/i,
      );
    });

    it('rejects duplicate delivery_id (basis for future dedup)', () => {
      const pr = makePr();
      service.insertOrReplacePullRequest(pr);
      const event = makeEvent({ pull_request_node_id: pr.node_id });
      service.insertWebhookEvent(event);

      expect(() => service.insertWebhookEvent(event)).toThrow(
        /UNIQUE constraint failed/i,
      );
    });
  });

  describe('transaction', () => {
    it('commits all writes on success', () => {
      const pr = makePr({ node_id: 'PR_txn_ok' });
      const event = makeEvent({
        delivery_id: 'd-txn-ok',
        pull_request_node_id: 'PR_txn_ok',
      });

      service.transaction(() => {
        service.insertOrReplacePullRequest(pr);
        service.insertWebhookEvent(event);
      });

      expect(service.findPullRequest('PR_txn_ok')).toBeDefined();
      expect(service.findWebhookEvent('d-txn-ok')).toBeDefined();
    });

    it('rolls back all writes if the wrapped fn throws after the first write', () => {
      expect(() => {
        service.transaction(() => {
          service.insertOrReplacePullRequest(
            makePr({ node_id: 'PR_txn_rollback' }),
          );
          throw new Error('boom — should roll back the PR insert');
        });
      }).toThrow('boom');

      // The PR insert must not survive — that's the whole point.
      expect(service.findPullRequest('PR_txn_rollback')).toBeUndefined();
    });

    it('returns the wrapped fn return value', () => {
      const result = service.transaction(() => {
        service.insertOrReplacePullRequest(makePr({ node_id: 'PR_txn_ret' }));
        return 'ok' as const;
      });
      expect(result).toBe('ok');
    });
  });
});
