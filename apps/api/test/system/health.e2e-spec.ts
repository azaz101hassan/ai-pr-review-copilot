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
  const prevVoyageKey = process.env.VOYAGE_API_KEY;
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    // Booting AppModule constructs ConfigService, which requires
    // GITHUB_WEBHOOK_SECRET, VOYAGE_API_KEY, and ANTHROPIC_API_KEY
    // at boot. Stub all three so the module compiles without leaking
    // real credentials.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-e2e-'));
    process.env.GITHUB_WEBHOOK_SECRET = 'health-test-secret-1234567890';
    process.env.VOYAGE_API_KEY = 'voyage-test-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key-0123456789abcdef';
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
    if (prevVoyageKey === undefined) {
      delete process.env.VOYAGE_API_KEY;
    } else {
      process.env.VOYAGE_API_KEY = prevVoyageKey;
    }
    if (prevAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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
