import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { SqliteWebhookEventsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-webhook-events.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';
import { WebhookEventRecord } from '@/modules/webhooks/types/webhook-event.types';

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
    created_at: '2026-05-25T10:00:00Z',
    updated_at: '2026-05-25T10:00:00Z',
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
    received_at: '2026-05-25T10:00:01Z',
    raw_payload: JSON.stringify({ action: 'opened' }),
    ...overrides,
  };
}

describe('SqliteWebhookEventsRepository', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let prs: SqlitePullRequestsRepository;
  let events: SqliteWebhookEventsRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    prs = new SqlitePullRequestsRepository(db);
    events = new SqliteWebhookEventsRepository(db);
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips an event linked to an existing PR', () => {
    const pr = makePr();
    prs.save(pr);
    const event = makeEvent({ pull_request_node_id: pr.node_id });
    events.insert(event);

    expect(events.findByDeliveryId(event.delivery_id)).toEqual(event);
  });

  it('accepts a null pull_request_node_id (non-PR events)', () => {
    const event = makeEvent({
      delivery_id: 'evt-no-pr',
      event_name: 'push',
      action: null,
      pull_request_node_id: null,
    });
    events.insert(event);

    expect(events.findByDeliveryId('evt-no-pr')?.pull_request_node_id).toBeNull();
  });

  it('rejects an event whose pull_request_node_id has no matching PR (FK)', () => {
    const orphan = makeEvent({
      delivery_id: 'evt-orphan',
      pull_request_node_id: 'PR_does_not_exist',
    });
    expect(() => events.insert(orphan)).toThrow(/FOREIGN KEY/i);
  });

  it('rejects duplicate delivery_id (basis for idempotency)', () => {
    const pr = makePr();
    prs.save(pr);
    const event = makeEvent({ pull_request_node_id: pr.node_id });
    events.insert(event);

    expect(() => events.insert(event)).toThrow(/UNIQUE constraint failed/i);
  });
});
