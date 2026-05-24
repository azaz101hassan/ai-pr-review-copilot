import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '../../src/db/database.service';
import {
  GithubWebhookPayload,
  WebhookService,
} from '../../src/webhooks/webhook.service';

function makePrPayload(
  action: string,
  overrides: Partial<GithubWebhookPayload['pull_request']> = {},
): GithubWebhookPayload {
  return {
    action,
    pull_request: {
      node_id: 'PR_kwDOTEST',
      number: 42,
      title: 'Test PR',
      state: 'open',
      head: { sha: 'a'.repeat(40) },
      base: { sha: 'b'.repeat(40) },
      user: { login: 'octocat' },
      created_at: '2026-05-24T10:00:00Z',
      updated_at: '2026-05-24T10:00:00Z',
      ...overrides,
    } as GithubWebhookPayload['pull_request'],
    repository: { full_name: 'octocat/hello-world' },
  };
}

describe('WebhookService', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let service: WebhookService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-svc-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    service = new WebhookService(db);
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('pull_request opened', () => {
    it('persists PR row and event with FK; returns processed', () => {
      const payload = makePrPayload('opened');
      const res = service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-open',
        action: 'opened',
        payload,
        rawPayload: JSON.stringify(payload),
      });

      expect(res.status).toBe('processed');
      const pr = db.findPullRequest('PR_kwDOTEST');
      expect(pr).toBeDefined();
      expect(pr?.repo_full_name).toBe('octocat/hello-world');
      expect(pr?.title).toBe('Test PR');
      expect(pr?.state).toBe('open');
      const evt = db.findWebhookEvent('d-open');
      expect(evt?.pull_request_node_id).toBe('PR_kwDOTEST');
      expect(evt?.event_name).toBe('pull_request');
      expect(evt?.action).toBe('opened');
    });
  });

  describe('pull_request synchronize', () => {
    it('upserts PR even without a prior opened', () => {
      const payload = makePrPayload('synchronize');
      const res = service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-sync',
        action: 'synchronize',
        payload,
        rawPayload: JSON.stringify(payload),
      });

      expect(res.status).toBe('processed');
      expect(db.findPullRequest('PR_kwDOTEST')?.title).toBe('Test PR');
    });

    it('updates PR fields on second synchronize after opened', () => {
      const opened = makePrPayload('opened');
      service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-open',
        action: 'opened',
        payload: opened,
        rawPayload: JSON.stringify(opened),
      });

      const synced = makePrPayload('synchronize', {
        title: 'Updated title',
        head: { sha: 'c'.repeat(40) },
      });
      service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-sync',
        action: 'synchronize',
        payload: synced,
        rawPayload: JSON.stringify(synced),
      });

      const pr = db.findPullRequest('PR_kwDOTEST');
      expect(pr?.title).toBe('Updated title');
      expect(pr?.head_sha).toBe('c'.repeat(40));
    });
  });

  describe('pull_request closed (ignored action)', () => {
    it('records event with FK when PR exists; does NOT overwrite PR row', () => {
      const opened = makePrPayload('opened', { title: 'Original' });
      service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-open',
        action: 'opened',
        payload: opened,
        rawPayload: JSON.stringify(opened),
      });

      const closed = makePrPayload('closed', {
        title: 'Should not overwrite',
        state: 'closed',
      });
      const res = service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-close',
        action: 'closed',
        payload: closed,
        rawPayload: JSON.stringify(closed),
      });

      expect(res.status).toBe('ignored-action');
      const pr = db.findPullRequest('PR_kwDOTEST');
      expect(pr?.title).toBe('Original');
      expect(pr?.state).toBe('open');
      expect(db.findWebhookEvent('d-close')?.pull_request_node_id).toBe(
        'PR_kwDOTEST',
      );
    });

    it('uses null FK when ignored-action arrives before opened (defensive)', () => {
      const closed = makePrPayload('closed');
      const res = service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-orphan',
        action: 'closed',
        payload: closed,
        rawPayload: JSON.stringify(closed),
      });

      expect(res.status).toBe('ignored-action');
      expect(db.findWebhookEvent('d-orphan')?.pull_request_node_id).toBeNull();
      expect(db.findPullRequest('PR_kwDOTEST')).toBeUndefined();
    });
  });

  describe('non-pull_request events (ignored event)', () => {
    it('inserts event with null FK and returns ignored-event', () => {
      const payload = {
        action: undefined,
        // shape-wise: GitHub push payload, simplified
      } as unknown as GithubWebhookPayload;
      const res = service.handleDelivery({
        event: 'push',
        delivery: 'd-push',
        action: null,
        payload,
        rawPayload: JSON.stringify({ ref: 'refs/heads/main' }),
      });

      expect(res.status).toBe('ignored-event');
      const evt = db.findWebhookEvent('d-push');
      expect(evt?.event_name).toBe('push');
      expect(evt?.pull_request_node_id).toBeNull();
    });

    it('handles ping event (sent by GitHub on webhook setup)', () => {
      const res = service.handleDelivery({
        event: 'ping',
        delivery: 'd-ping',
        action: null,
        payload: {},
        rawPayload: '{}',
      });

      expect(res.status).toBe('ignored-event');
      expect(db.findWebhookEvent('d-ping')).toBeDefined();
    });
  });

  describe('idempotency (duplicate X-GitHub-Delivery)', () => {
    it('returns status:duplicate without re-inserting or mutating PR row on redelivery', () => {
      const payload = makePrPayload('opened');
      const first = service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-replay',
        action: 'opened',
        payload,
        rawPayload: JSON.stringify(payload),
      });
      expect(first.status).toBe('processed');
      const eventAfterFirst = db.findWebhookEvent('d-replay');
      expect(eventAfterFirst).toBeDefined();
      const firstReceivedAt = eventAfterFirst!.received_at;

      // Replay the same delivery_id with different content. The
      // idempotency check is keyed on delivery_id alone, so even a
      // payload change must be a no-op.
      const replayed = service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-replay',
        action: 'opened',
        payload: makePrPayload('opened', { title: 'changed after replay' }),
        rawPayload: JSON.stringify({ changed: true }),
      });
      expect(replayed.status).toBe('duplicate');
      // PR row title NOT updated by the duplicate.
      expect(db.findPullRequest('PR_kwDOTEST')?.title).toBe('Test PR');
      // Event row received_at NOT changed.
      expect(db.findWebhookEvent('d-replay')?.received_at).toBe(firstReceivedAt);
    });
  });
});
