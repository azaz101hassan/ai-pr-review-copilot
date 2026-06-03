import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigService } from '@/config';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { SqliteWebhookEventsRepository } from '../../../src/infrastructure/db/repositories/sqlite-webhook-events.repository';
import {
  GithubWebhookPayload,
  WebhookService,
} from '@/modules/webhooks';
import type {
  EnqueueResult,
  IReviewQueue,
  ReviewJobData,
} from '@/modules/reviews/types/review-queue';

const ALLOWLISTED_REPO = 'octocat/hello-world';
const NON_ALLOWLISTED_REPO = 'someone/private-thing';

function makePrPayload(
  action: string,
  overrides: Partial<GithubWebhookPayload['pull_request']> = {},
  payloadOverrides: Partial<GithubWebhookPayload> = {},
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
    repository: { full_name: ALLOWLISTED_REPO },
    installation: { id: 99 },
    ...payloadOverrides,
  };
}

interface StubQueue extends IReviewQueue {
  calls: ReviewJobData[];
}
function makeStubQueue(
  override?: (data: ReviewJobData) => Promise<EnqueueResult>,
): StubQueue {
  const q: StubQueue = {
    calls: [],
    enqueueReview: async (data) => {
      q.calls.push(data);
      if (override) return override(data);
      return { jobId: data.pr_node_id, result: 'added' };
    },
  };
  return q;
}

// The WebhookService injects IGithubAuthProvider so it can evict
// cached Octokits on installation lifecycle events. Tests stub the
// seam and observe invalidateInstallation calls.
interface StubGithubAuth {
  forInstallation: jest.Mock;
  invalidateInstallation: jest.Mock;
}
function makeStubGithubAuth(): StubGithubAuth {
  return {
    forInstallation: jest.fn(),
    invalidateInstallation: jest.fn(),
  };
}

function makeConfig(allowlist: string[] = [ALLOWLISTED_REPO]): ConfigService {
  // ConfigService reads process.env at construction. jest.setup.ts
  // primes all required vars; we just need to override DOGFOOD_REPOS
  // per test.
  const prev = process.env.DOGFOOD_REPOS;
  process.env.DOGFOOD_REPOS = allowlist.join(',');
  try {
    return new ConfigService();
  } finally {
    if (prev === undefined) delete process.env.DOGFOOD_REPOS;
    else process.env.DOGFOOD_REPOS = prev;
  }
}

describe('WebhookService', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let prs: SqlitePullRequestsRepository;
  let events: SqliteWebhookEventsRepository;
  let queue: StubQueue;
  let githubAuth: StubGithubAuth;
  let service: WebhookService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-svc-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    prs = new SqlitePullRequestsRepository(db);
    events = new SqliteWebhookEventsRepository(db);
    queue = makeStubQueue();
    githubAuth = makeStubGithubAuth();
    service = new WebhookService(
      db,
      prs,
      events,
      queue,
      githubAuth as unknown as ConstructorParameters<typeof WebhookService>[4],
      makeConfig(),
    );
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('pull_request opened (allowlisted, non-draft)', () => {
    it('persists PR row + event, enqueues review, returns processed', async () => {
      const payload = makePrPayload('opened');
      const res = await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-open',
        action: 'opened',
        payload,
        rawPayload: JSON.stringify(payload),
      });

      expect(res.status).toBe('processed');
      const pr = prs.findByNodeId('PR_kwDOTEST');
      expect(pr).toBeDefined();
      expect(pr?.repo_full_name).toBe(ALLOWLISTED_REPO);
      expect(pr?.title).toBe('Test PR');
      expect(pr?.state).toBe('open');
      const evt = events.findByDeliveryId('d-open');
      expect(evt?.pull_request_node_id).toBe('PR_kwDOTEST');
      expect(evt?.event_name).toBe('pull_request');
      expect(evt?.action).toBe('opened');
      // Enqueue happened with the right shape (R2/R13).
      expect(queue.calls).toHaveLength(1);
      expect(queue.calls[0]).toEqual({
        pr_node_id: 'PR_kwDOTEST',
        owner: 'octocat',
        repo: 'hello-world',
        pr_number: 42,
        head_sha: 'a'.repeat(40),
        installation_id: 99,
      });
    });
  });

  describe('pull_request synchronize', () => {
    it('upserts PR even without a prior opened and enqueues', async () => {
      const payload = makePrPayload('synchronize');
      const res = await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-sync',
        action: 'synchronize',
        payload,
        rawPayload: JSON.stringify(payload),
      });

      expect(res.status).toBe('processed');
      expect(prs.findByNodeId('PR_kwDOTEST')?.title).toBe('Test PR');
      expect(queue.calls).toHaveLength(1);
    });

    it('updates PR fields on second synchronize after opened', async () => {
      const opened = makePrPayload('opened');
      await service.handleDelivery({
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
      await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-sync',
        action: 'synchronize',
        payload: synced,
        rawPayload: JSON.stringify(synced),
      });

      const pr = prs.findByNodeId('PR_kwDOTEST');
      expect(pr?.title).toBe('Updated title');
      expect(pr?.head_sha).toBe('c'.repeat(40));
      // Two enqueue calls, second with new head_sha.
      expect(queue.calls).toHaveLength(2);
      expect(queue.calls[1].head_sha).toBe('c'.repeat(40));
    });
  });

  describe('pull_request closed (ignored action)', () => {
    it('records event with FK when PR exists; does NOT overwrite PR row or enqueue', async () => {
      const opened = makePrPayload('opened', { title: 'Original' });
      await service.handleDelivery({
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
      const res = await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-close',
        action: 'closed',
        payload: closed,
        rawPayload: JSON.stringify(closed),
      });

      expect(res.status).toBe('ignored-action');
      const pr = prs.findByNodeId('PR_kwDOTEST');
      expect(pr?.title).toBe('Original');
      expect(pr?.state).toBe('open');
      expect(events.findByDeliveryId('d-close')?.pull_request_node_id).toBe(
        'PR_kwDOTEST',
      );
      // Only the opened call enqueued; closed did not.
      expect(queue.calls).toHaveLength(1);
    });

    it('uses null FK when ignored-action arrives before opened (defensive)', async () => {
      const closed = makePrPayload('closed');
      const res = await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-orphan',
        action: 'closed',
        payload: closed,
        rawPayload: JSON.stringify(closed),
      });

      expect(res.status).toBe('ignored-action');
      expect(events.findByDeliveryId('d-orphan')?.pull_request_node_id).toBeNull();
      expect(prs.findByNodeId('PR_kwDOTEST')).toBeUndefined();
      expect(queue.calls).toHaveLength(0);
    });
  });

  describe('non-pull_request events (ignored event)', () => {
    it('inserts event with null FK and returns ignored-event', async () => {
      const payload = {
        action: undefined,
      } as unknown as GithubWebhookPayload;
      const res = await service.handleDelivery({
        event: 'push',
        delivery: 'd-push',
        action: null,
        payload,
        rawPayload: JSON.stringify({ ref: 'refs/heads/main' }),
      });

      expect(res.status).toBe('ignored-event');
      const evt = events.findByDeliveryId('d-push');
      expect(evt?.event_name).toBe('push');
      expect(evt?.pull_request_node_id).toBeNull();
      expect(queue.calls).toHaveLength(0);
    });

    it('handles ping event (sent by GitHub on webhook setup)', async () => {
      const res = await service.handleDelivery({
        event: 'ping',
        delivery: 'd-ping',
        action: null,
        payload: {},
        rawPayload: '{}',
      });

      expect(res.status).toBe('ignored-event');
      expect(events.findByDeliveryId('d-ping')).toBeDefined();
    });
  });

  describe('idempotency (duplicate X-GitHub-Delivery)', () => {
    it('returns duplicate without re-inserting, mutating PR row, or re-enqueueing', async () => {
      const payload = makePrPayload('opened');
      const first = await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-replay',
        action: 'opened',
        payload,
        rawPayload: JSON.stringify(payload),
      });
      expect(first.status).toBe('processed');
      const eventAfterFirst = events.findByDeliveryId('d-replay');
      expect(eventAfterFirst).toBeDefined();
      const firstReceivedAt = eventAfterFirst!.received_at;

      const replayed = await service.handleDelivery({
        event: 'pull_request',
        delivery: 'd-replay',
        action: 'opened',
        payload: makePrPayload('opened', { title: 'changed after replay' }),
        rawPayload: JSON.stringify({ changed: true }),
      });
      expect(replayed.status).toBe('duplicate');
      expect(prs.findByNodeId('PR_kwDOTEST')?.title).toBe('Test PR');
      expect(events.findByDeliveryId('d-replay')?.received_at).toEqual(firstReceivedAt);
      // Idempotency short-circuit runs FIRST — no re-enqueue on
      // duplicate (the original processed call already enqueued).
      expect(queue.calls).toHaveLength(1);
    });
  });

  // Pre-enqueue gates: draft filter, DOGFOOD_REPOS allowlist,
  // enqueue-failure → 5xx contract.
  describe('pre-enqueue gates', () => {
    describe('draft filter', () => {
      it('opens-as-draft → persists audit row but does NOT enqueue → ignored-draft', async () => {
        const payload = makePrPayload('opened', { draft: true });
        const res = await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-draft-open',
          action: 'opened',
          payload,
          rawPayload: JSON.stringify(payload),
        });
        expect(res.status).toBe('ignored-draft');
        // Audit row still persisted (transaction commits BEFORE the
        // gate runs).
        expect(prs.findByNodeId('PR_kwDOTEST')).toBeDefined();
        expect(events.findByDeliveryId('d-draft-open')).toBeDefined();
        // No enqueue.
        expect(queue.calls).toHaveLength(0);
      });

      it('synchronize on a draft PR ALSO skips (consistent draft policy)', async () => {
        const payload = makePrPayload('synchronize', { draft: true });
        const res = await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-draft-sync',
          action: 'synchronize',
          payload,
          rawPayload: JSON.stringify(payload),
        });
        expect(res.status).toBe('ignored-draft');
        expect(queue.calls).toHaveLength(0);
      });

      it('first synchronize after draft → false enqueues normally', async () => {
        // Open as draft → skipped.
        await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-draft-open',
          action: 'opened',
          payload: makePrPayload('opened', { draft: true }),
          rawPayload: '{}',
        });
        // Synchronize once draft cleared → enqueues.
        const res = await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-promoted-sync',
          action: 'synchronize',
          payload: makePrPayload('synchronize', { draft: false }),
          rawPayload: '{}',
        });
        expect(res.status).toBe('processed');
        expect(queue.calls).toHaveLength(1);
      });
    });

    describe('DOGFOOD_REPOS allowlist', () => {
      it('non-allowlisted repo → ignored-repo, audit row persists, no enqueue', async () => {
        service = new WebhookService(
          db,
          prs,
          events,
          queue,
          githubAuth as unknown as ConstructorParameters<typeof WebhookService>[4],
          makeConfig([ALLOWLISTED_REPO]),
        );
        const payload = makePrPayload(
          'opened',
          {},
          { repository: { full_name: NON_ALLOWLISTED_REPO } },
        );
        const res = await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-outside',
          action: 'opened',
          payload,
          rawPayload: JSON.stringify(payload),
        });
        expect(res.status).toBe('ignored-repo');
        expect(prs.findByNodeId('PR_kwDOTEST')?.repo_full_name).toBe(
          NON_ALLOWLISTED_REPO,
        );
        expect(events.findByDeliveryId('d-outside')).toBeDefined();
        expect(queue.calls).toHaveLength(0);
      });

      it('empty allowlist (kill switch) → ignored-repo for every PR', async () => {
        service = new WebhookService(
          db,
          prs,
          events,
          queue,
          githubAuth as unknown as ConstructorParameters<typeof WebhookService>[4],
          makeConfig([]),
        );
        const res = await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-killswitch',
          action: 'opened',
          payload: makePrPayload('opened'),
          rawPayload: '{}',
        });
        expect(res.status).toBe('ignored-repo');
        expect(queue.calls).toHaveLength(0);
      });
    });

    describe('enqueue failure + saga ordering', () => {
      it('propagates queue errors so controller returns 5xx; audit row NOT persisted so redelivery re-enters', async () => {
        const failingQueue = makeStubQueue(async () => {
          throw new Error('ECONNREFUSED: Redis dropped');
        });
        service = new WebhookService(
          db,
          prs,
          events,
          failingQueue,
          githubAuth as unknown as ConstructorParameters<typeof WebhookService>[4],
          makeConfig(),
        );
        const payload = makePrPayload('opened');

        await expect(
          service.handleDelivery({
            event: 'pull_request',
            delivery: 'd-redis-down',
            action: 'opened',
            payload,
            rawPayload: JSON.stringify(payload),
          }),
        ).rejects.toThrow(/ECONNREFUSED/);

        // The PR row IS upserted (idempotent — safe to redo on
        // redelivery), but the audit row is NOT written because the
        // enqueue threw before its insert. The next GitHub
        // redelivery sees no audit row → re-enters the pipeline
        // rather than short-circuiting as 'duplicate'.
        expect(prs.findByNodeId('PR_kwDOTEST')).toBeDefined();
        expect(events.findByDeliveryId('d-redis-down')).toBeUndefined();
      });
    });

    describe('missing installation.id', () => {
      it('returns ignored-event when payload lacks installation.id', async () => {
        const payload = makePrPayload('opened', {}, { installation: undefined });
        const res = await service.handleDelivery({
          event: 'pull_request',
          delivery: 'd-no-install',
          action: 'opened',
          payload,
          rawPayload: JSON.stringify(payload),
        });
        expect(res.status).toBe('ignored-event');
        expect(queue.calls).toHaveLength(0);
      });
    });
  });

  // Installation-lifecycle webhook events evict the cached Octokit
  // so we don't keep retrying with a dead token.
  describe('installation lifecycle', () => {
    it('invalidates the cached Octokit on installation.deleted', async () => {
      const res = await service.handleDelivery({
        event: 'installation',
        delivery: 'd-installed-gone',
        action: 'deleted',
        payload: { installation: { id: 777 } },
        rawPayload: '{}',
      });
      expect(res.status).toBe('processed');
      expect(githubAuth.invalidateInstallation).toHaveBeenCalledWith(777);
      // Audit row still persisted.
      expect(events.findByDeliveryId('d-installed-gone')).toBeDefined();
    });

    it('invalidates the cached Octokit on installation.suspend', async () => {
      const res = await service.handleDelivery({
        event: 'installation',
        delivery: 'd-installed-suspend',
        action: 'suspend',
        payload: { installation: { id: 888 } },
        rawPayload: '{}',
      });
      expect(res.status).toBe('processed');
      expect(githubAuth.invalidateInstallation).toHaveBeenCalledWith(888);
    });

    it('does NOT invalidate on installation.created', async () => {
      const res = await service.handleDelivery({
        event: 'installation',
        delivery: 'd-installed-new',
        action: 'created',
        payload: { installation: { id: 999 } },
        rawPayload: '{}',
      });
      expect(res.status).toBe('processed');
      expect(githubAuth.invalidateInstallation).not.toHaveBeenCalled();
    });
  });
});
