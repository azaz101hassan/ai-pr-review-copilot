import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { AppModule } from '@/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;
  let tmpDir: string;
  const prevSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const prevDbPath = process.env.DATABASE_PATH;

  beforeAll(async () => {
    // Booting AppModule pulls in WebhookModule, whose signature guard
    // requires GITHUB_WEBHOOK_SECRET at construction. Stub env for the test.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-e2e-'));
    process.env.GITHUB_WEBHOOK_SECRET = 'health-test-secret';
    process.env.DATABASE_PATH = path.join(tmpDir, 'health.sqlite');

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
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

  it('GET /health returns 200 with status ok and runtime info', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });
});
