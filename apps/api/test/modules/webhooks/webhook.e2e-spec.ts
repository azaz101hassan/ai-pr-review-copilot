import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SqlitePullRequestsRepository } from '../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { SqliteWebhookEventsRepository } from '../../../src/infrastructure/db/repositories/sqlite-webhook-events.repository';
import {
  PULL_REQUEST_REPOSITORY,
  WEBHOOK_EVENT_REPOSITORY,
} from '@/modules/webhooks';

const SECRET = 'webhook-secret-e2e';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function prPayload(action: string) {
  return {
    action,
    pull_request: {
      node_id: 'PR_kwDOEND2END',
      number: 7,
      title: 'e2e PR',
      state: 'open',
      head: { sha: 'a'.repeat(40) },
      base: { sha: 'b'.repeat(40) },
      user: { login: 'octocat' },
      created_at: '2026-05-24T11:00:00Z',
      updated_at: '2026-05-24T11:00:00Z',
    },
    repository: { full_name: 'octocat/hello-world' },
  };
}

describe('POST /webhooks/github (e2e)', () => {
  let app: INestApplication;
  let prs: SqlitePullRequestsRepository;
  let events: SqliteWebhookEventsRepository;
  let tmpDir: string;
  const prevSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const prevDbPath = process.env.DATABASE_PATH;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-e2e-'));
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    process.env.DATABASE_PATH = path.join(tmpDir, 'e2e.sqlite');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prs = app.get(PULL_REQUEST_REPOSITORY);
    events = app.get(WEBHOOK_EVENT_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
    if (prevSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = prevSecret;
    }
    if (prevDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = prevDbPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('processes a valid pull_request.opened delivery end-to-end', async () => {
    const payload = prPayload('opened');
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-e2e-opened')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(prs.findByNodeId('PR_kwDOEND2END')).toBeDefined();
    expect(events.findByDeliveryId('d-e2e-opened')?.pull_request_node_id).toBe(
      'PR_kwDOEND2END',
    );
  });

  it('returns 401 with bad signature and writes nothing to DB', async () => {
    const payload = prPayload('opened');
    const body = JSON.stringify({ ...payload, number: 999 });

    const res = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + 'deadbeef'.repeat(8))
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-e2e-badsig')
      .send(body);

    expect(res.status).toBe(401);
    expect(events.findByDeliveryId('d-e2e-badsig')).toBeUndefined();
  });

  it('returns 401 with missing signature', async () => {
    const payload = prPayload('opened');
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-e2e-nosig')
      .send(body);

    expect(res.status).toBe(401);
    expect(events.findByDeliveryId('d-e2e-nosig')).toBeUndefined();
  });

  it('returns 400 when X-GitHub-Event header is missing (after sig passes)', async () => {
    const payload = prPayload('opened');
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .set('X-GitHub-Delivery', 'd-e2e-noevent')
      .send(body);

    expect(res.status).toBe(400);
  });

  it('records non-PR events (push) without DB writes to pull_requests', async () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      head_commit: { id: 'abc' },
    });

    const res = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'd-e2e-push')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored-event');
    expect(events.findByDeliveryId('d-e2e-push')?.pull_request_node_id).toBeNull();
  });

  it('records the ping event sent by GitHub on webhook setup', async () => {
    const body = JSON.stringify({ zen: 'Anything added dilutes everything else.' });

    const res = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .set('X-GitHub-Event', 'ping')
      .set('X-GitHub-Delivery', 'd-e2e-ping')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored-event');
  });

  it('idempotent on Redeliver: same delivery_id returns 200/duplicate, no DB churn', async () => {
    const payload = prPayload('opened');
    payload.pull_request.node_id = 'PR_kwDOREDELIVER';
    const body = JSON.stringify(payload);

    const first = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-e2e-redeliver')
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('processed');

    const second = await request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-e2e-redeliver')
      .send(body);

    // Pre-fix this was 500 (UNIQUE constraint). Now it's a successful
    // no-op so the GitHub App's "Recent Deliveries" tab shows green on
    // a Redeliver click and the documented workflow actually works.
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');
  });
});
