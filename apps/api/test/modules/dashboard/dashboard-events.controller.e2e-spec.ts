// SSE wire-format e2e tests for DashboardEventsController.
//
// Critical discipline (institutionalized in project memory):
// Two prior regressions on this codebase slipped through mocked tests
// because a Subject mock accepted shapes that real EventSource rejected.
// These tests use real HTTP transport + raw response-byte assertions to
// verify the exact SSE wire format that NestJS emits.
//
// NestJS @Sse() wire format (from node_modules/@nestjs/core/router/sse-stream.js):
//   - event: field appears only when SseFrame.type is set (truthy)
//   - data: field appears only when SseFrame.data is truthy (empty string is skipped)
//   - id: field is auto-incremented by NestJS on each writeMessage call
//   - Frame separator: \n (blank line)
//
// Actual wire bytes per frame type:
//   Terminal event  (type absent, data = JSON string):
//     data: {"review_id":"...","status":"completed",...}\nid: N\n\n
//
//   Keepalive heartbeat (type = 'keepalive', data = '' which is falsy):
//     event: keepalive\nid: N\n\n
//     (NestJS skips the data: line for falsy data values)
//
//   Cap-reached single frame (type = 'cap-reached', data = ''):
//     event: cap-reached\nid: N\n\n
//     (same — no data: line for falsy data)
//
// These are the literal bytes asserted in this test suite.

import {
  DynamicModule,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigModule } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule } from '@/modules/embeddings';
import {
  EMBEDDING_PROVIDER,
  IEmbeddingProvider,
} from '@/modules/embeddings/types/embedding-provider';
import {
  VECTOR_STORE,
  IVectorStore,
  VectorStoreQueryOptions,
  VectorStoreHit,
} from '@/modules/embeddings/types/vector-store';
import {
  AnalyzeDiffResult,
  ILlmReviewer,
  LLM_REVIEWER,
  PROMPT_AND_TOOL_VERSION,
} from '@/modules/reviews/types/llm-reviewer';
import { ReviewsModule } from '@/modules/reviews/reviews.module';
import { ReviewEventsService } from '@/modules/reviews/events/review-events.service';
import { DashboardModule } from '@/modules/dashboard';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
} from '@/modules/dashboard/dashboard-events.controller';
import { HealthController } from '@/system';

// ---------------------------------------------------------------------------
// Stubs for offline boot
// ---------------------------------------------------------------------------

class StubEmbeddingProvider implements IEmbeddingProvider {
  readonly modelName = 'stub-embedding';
  readonly dimension = 64;
  async embedDocuments(texts: string[]) {
    return { vectors: texts.map(() => new Array(64).fill(0) as number[]), tokensUsed: 0 };
  }
  async embedQuery() {
    return { vector: new Array(64).fill(0) as number[], tokensUsed: 0 };
  }
}

class StubVectorStore implements IVectorStore {
  async ensureCollection() { /* no-op */ }
  async upsert() { /* no-op */ }
  async query(_opts: VectorStoreQueryOptions): Promise<VectorStoreHit[]> { return []; }
  async deleteAll() { /* no-op */ }
}

class StubLlmReviewer implements ILlmReviewer {
  async analyzeDiff(): Promise<AnalyzeDiffResult> {
    return {
      findings: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      model: 'stub',
      promptVersion: PROMPT_AND_TOOL_VERSION,
      turnCount: 1,
      toolCalls: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

type EnvState = Record<string, string | undefined>;
function snapshotEnv(keys: string[]): EnvState {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}
function restoreEnv(snapshot: EnvState): void {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Test module factory
// ---------------------------------------------------------------------------

function makeTestModule(): DynamicModule {
  return {
    module: class TestAppModule {},
    imports: [
      ConfigModule,
      DatabaseModule,
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 30 }]),
      EmbeddingsModule,
      ReviewsModule.forRoot(),
      DashboardModule,
    ],
    controllers: [HealthController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  };
}

// ---------------------------------------------------------------------------
// Helper: collect raw SSE bytes for up to timeoutMs
// ---------------------------------------------------------------------------

function collectSseBytes(
  server: http.Server,
  timeoutMs: number,
): Promise<{ contentType: string; body: string; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 3001;
    let body = '';
    let contentType = '';

    const req = http.get(
      `http://127.0.0.1:${port}/dashboard/events`,
      (res) => {
        contentType = res.headers['content-type'] ?? '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ contentType, body, req }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);

    const t = setTimeout(() => { req.destroy(); resolve({ contentType, body, req }); }, timeoutMs);
    if (t.unref) t.unref();
  });
}

// ---------------------------------------------------------------------------
// Helper: open N connections concurrently and wait until all headers arrive
// ---------------------------------------------------------------------------

function openNConnections(
  server: http.Server,
  n: number,
): Promise<http.ClientRequest[]> {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 3001;
  const reqs: http.ClientRequest[] = [];
  return new Promise((resolve, reject) => {
    let ready = 0;
    for (let i = 0; i < n; i++) {
      const req = http.get(
        `http://127.0.0.1:${port}/dashboard/events`,
        () => {
          ready++;
          if (ready === n) setTimeout(() => resolve(reqs), 50);
        },
      );
      req.on('error', reject);
      reqs.push(req);
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardEventsController SSE wire format (e2e)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let envSnapshot: EnvState;
  let eventsService: ReviewEventsService;

  const SNAPSHOT_KEYS = [
    'GITHUB_WEBHOOK_SECRET',
    'VOYAGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'DATABASE_PATH',
    'ENABLE_DRY_RUN',
    'NODE_ENV',
  ];

  beforeAll(async () => {
    envSnapshot = snapshotEnv(SNAPSHOT_KEYS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-e2e-'));

    process.env.GITHUB_WEBHOOK_SECRET = 'sse-e2e-secret-0123456789abcdef';
    process.env.VOYAGE_API_KEY = 'voyage-e2e-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-e2e-key-0123456789abcdef';
    process.env.DATABASE_PATH = path.join(tmpDir, 'sse-e2e.sqlite');
    process.env.ENABLE_DRY_RUN = 'false';
    process.env.NODE_ENV = 'development';

    const moduleRef = await Test.createTestingModule({ imports: [makeTestModule()] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(new StubEmbeddingProvider())
      .overrideProvider(VECTOR_STORE)
      .useValue(new StubVectorStore())
      .overrideProvider(LLM_REVIEWER)
      .useValue(new StubLlmReviewer())
      // Override heartbeat to 100 ms so the keepalive test doesn't wait 25 s.
      .overrideProvider(SSE_HEARTBEAT_INTERVAL_MS)
      .useValue(100)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');

    eventsService = moduleRef.get(ReviewEventsService);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  }, 20_000);

  // ---------------------------------------------------------------------------
  // Content-Type
  // ---------------------------------------------------------------------------

  it('responds with Content-Type: text/event-stream', async () => {
    const { contentType, req } = await collectSseBytes(
      app.getHttpServer() as http.Server,
      200,
    );
    req.destroy();
    expect(contentType).toMatch(/^text\/event-stream/);
  }, 5_000);

  // ---------------------------------------------------------------------------
  // Keepalive heartbeat wire shape (CRITICAL)
  //
  // NestJS @Sse() wire shape for { type: 'keepalive', data: '' }:
  //   event: keepalive\nid: N\n\n
  //
  // Note: NestJS skips the `data:` line when SseFrame.data is falsy (empty
  // string). The `id:` field is auto-incremented by NestJS. The `event:`
  // line is present because type is set — this is the named channel.
  // A vanilla EventSource.onmessage does NOT fire for named-channel frames.
  // Only `addEventListener('keepalive', ...)` would receive them.
  //
  // Heartbeat interval is overridden to 100 ms via the DI token.
  // ---------------------------------------------------------------------------

  it('keepalive wire bytes are `event: keepalive\\nid: N\\n\\n` (overridden to 100 ms)', async () => {
    // Collect for 500 ms — enough for several 100ms heartbeats.
    const { contentType, body } = await collectSseBytes(
      app.getHttpServer() as http.Server,
      500,
    );

    // SSE content type must be present.
    expect(contentType).toMatch(/^text\/event-stream/);

    // The named keepalive event MUST appear (verifying the named channel).
    // Actual literal bytes verified here: event: keepalive\nid: N\n\n
    expect(body).toContain('event: keepalive');

    // Verify the `id:` field is present (NestJS auto-increments).
    expect(body).toMatch(/event: keepalive\nid: \d+\n\n/);

    // Verify a vanilla onmessage listener would NOT see keepalive frames.
    // Named-channel frames (with event: line) do not fire EventSource.onmessage.
    // Split on double-newline to get individual frames.
    const frames = body.split('\n\n').filter((f) => f.trim().length > 0);
    const keepaliveFrames = frames.filter((f) => f.includes('event: keepalive'));
    expect(keepaliveFrames.length).toBeGreaterThan(0);
    // Each keepalive frame must have the event: line (named channel marker).
    for (const frame of keepaliveFrames) {
      expect(frame).toMatch(/^[\n]*event: keepalive/m);
    }
  }, 5_000);

  // ---------------------------------------------------------------------------
  // Terminal event wire shape (CRITICAL — prevents mock/real divergence)
  //
  // NestJS @Sse() wire shape for terminal review event (no type, data = JSON):
  //   data: {"review_id":"...","status":"completed",...}\nid: N\n\n
  //
  // No `event:` line — the frame is on the default channel.
  // Browser EventSource.onmessage fires for these frames.
  //
  // This assertion proves the real wire shape is correct. A Subject mock that
  // emits an object passes silently; real EventSource would reject a missing
  // data: line or a non-JSON data value.
  // ---------------------------------------------------------------------------

  it('terminal event wire bytes are `data: <json>\\nid: N\\n\\n` (default message channel)', async () => {
    const server = app.getHttpServer() as http.Server;
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 3001;

    // The literal bytes asserted by this test for a terminal review event:
    //   data: {"review_id":"sse-e2e-rev-1","status":"completed",...}\nid: N\n\n
    // No `event:` prefix — default channel, EventSource.onmessage fires.
    const REVIEW_ID = 'sse-e2e-rev-wire';

    const received = await new Promise<string>((resolve, reject) => {
      let collected = '';

      const req = http.get(
        `http://127.0.0.1:${port}/dashboard/events`,
        (res) => {
          res.on('data', (chunk: Buffer) => {
            collected += chunk.toString();
            if (collected.includes(REVIEW_ID)) {
              req.destroy();
              resolve(collected);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);

      // Emit the event after 200 ms (connection establishment window).
      const emitTimer = setTimeout(() => {
        eventsService.emit({
          review_id: REVIEW_ID,
          pr_node_id: 'PR_wire',
          repo_full_name: 'org/wire-repo',
          author_login: 'wire-author',
          status: 'completed',
          prompt_version: 'v2',
          finding_counts: { error: 1, warning: 2, info: 3 },
          token_totals: {
            input_tokens: 5000,
            output_tokens: 300,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
          completed_at: Date.now(),
        });
      }, 200);

      const safetyTimer = setTimeout(() => {
        req.destroy();
        reject(new Error(`Timed out. Got: ${JSON.stringify(collected.slice(0, 300))}`));
      }, 4_500);

      if (emitTimer.unref) emitTimer.unref();
      if (safetyTimer.unref) safetyTimer.unref();
    });

    // 1. Must have a data: line.
    expect(received).toMatch(/data: /);

    // 2. Extract the data line containing our review_id and parse JSON.
    const dataLineMatch = received.match(/data: (.+)\n/);
    expect(dataLineMatch).not.toBeNull();
    if (dataLineMatch) {
      const parsed = JSON.parse(dataLineMatch[1]) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        review_id: REVIEW_ID,
        status: 'completed',
        finding_counts: { error: 1, warning: 2, info: 3 },
      });
    }

    // 3. This is a DEFAULT-channel frame — no `event:` line precedes the data.
    // Verify: the lines immediately surrounding the data line do not contain
    // `event: keepalive` or `event: cap-reached`.
    const lines = received.split('\n');
    const dataLineIndex = lines.findIndex((l) => l.includes(REVIEW_ID));
    if (dataLineIndex > 0) {
      // The line before the data line should NOT be a named event line.
      expect(lines[dataLineIndex - 1]).not.toMatch(/^event: keepalive/);
      expect(lines[dataLineIndex - 1]).not.toMatch(/^event: cap-reached/);
    }
  }, 10_000);

  // ---------------------------------------------------------------------------
  // Cap-reached: 11th connection receives `event: cap-reached\nid: N\n\n`
  // and the response closes (Observable completes with a single frame).
  //
  // NestJS wire shape for { type: 'cap-reached', data: '' }:
  //   event: cap-reached\nid: N\n\n  (no data: line — falsy data is skipped)
  // ---------------------------------------------------------------------------

  it('11th connection receives `event: cap-reached\\nid: N\\n\\n` and response closes', async () => {
    const server = app.getHttpServer() as http.Server;

    // Open 10 connections.
    const openConnections = await openNConnections(server, 10);

    // 11th connection should receive a single cap-reached frame + response close.
    const capFrame = await new Promise<string>((resolve, reject) => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 3001;
      let data = '';
      const req = http.get(
        `http://127.0.0.1:${port}/dashboard/events`,
        (res) => {
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          // 'end' fires when NestJS closes the response (Observable complete).
          res.on('end', () => resolve(data));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      const t = setTimeout(() => { req.destroy(); resolve(data); }, 2_000);
      if (t.unref) t.unref();
    });

    // Verify: event: cap-reached\nid: N\n\n (NestJS actual wire shape)
    expect(capFrame).toContain('event: cap-reached');
    expect(capFrame).toMatch(/event: cap-reached\nid: \d+\n\n/);

    // Clean up held connections and wait for slots to release.
    for (const req of openConnections) { req.destroy(); }
    await new Promise((r) => setTimeout(r, 300));
  }, 15_000);

  // ---------------------------------------------------------------------------
  // Slot release: releaseSlot() fires on 'close', freeing the cap slot.
  //
  // Proves that the 11th client can connect AFTER one of the 10 disconnects.
  // ---------------------------------------------------------------------------

  it('after one disconnect, previously-capped 11th client connects successfully', async () => {
    const server = app.getHttpServer() as http.Server;
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 3001;

    // Open 10 connections.
    const openConnections = await openNConnections(server, 10);

    // Verify cap is reached.
    const capFrame = await new Promise<string>((resolve, reject) => {
      let data = '';
      const req = http.get(
        `http://127.0.0.1:${port}/dashboard/events`,
        (res) => {
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve(data));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      const t = setTimeout(() => { req.destroy(); resolve(data); }, 1_000);
      if (t.unref) t.unref();
    });
    expect(capFrame).toContain('event: cap-reached');

    // Release one slot.
    openConnections[0].destroy();
    await new Promise((r) => setTimeout(r, 250));

    // 11th client should now connect (receive stream, not cap-reached).
    const successData = await new Promise<string>((resolve, reject) => {
      let data = '';
      const req = http.get(
        `http://127.0.0.1:${port}/dashboard/events`,
        (res) => {
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      const t = setTimeout(() => { req.destroy(); resolve(data); }, 600);
      if (t.unref) t.unref();
    });

    // The newly-connected 11th client should NOT receive cap-reached.
    expect(successData).not.toContain('event: cap-reached');

    // Cleanup remaining connections.
    for (let i = 1; i < openConnections.length; i++) {
      openConnections[i].destroy();
    }
    await new Promise((r) => setTimeout(r, 250));
  }, 15_000);
});
