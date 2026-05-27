import { randomUUID } from 'node:crypto';
import { ChromaVectorStore } from '../../../src/infrastructure/chroma/chroma-vector-store';
import { ConfigService } from '@/config';

// Real-Chroma smoke spec. Talks to an actual ChromaDB server over
// HTTP — no mocked client, no in-memory stub. Gated by
// RUN_CHROMA_INTEGRATION=true so a local `npm test` from a developer
// who hasn't booted `docker compose up -d chroma` doesn't fail.
//
// CI sets the gate alongside a `chromadb/chroma` services container
// in .github/workflows/ci.yml.
//
// We still keep EMBEDDING_PROVIDER out of this spec — only
// ChromaVectorStore is exercised. Voyage is a paid API; this spec
// runs on every PR and must not spend tokens.
const ENABLED = process.env.RUN_CHROMA_INTEGRATION === 'true';
const describeIf = ENABLED ? describe : describe.skip;

// 64-dim toy vectors. Small enough for fast upserts, large enough to
// give cosine a meaningful surface to rank.
const DIM = 64;

function makeConfig(): ConfigService {
  return {
    chromaUrl: process.env.CHROMA_URL ?? 'http://localhost:8000',
    // Unique collection name per spec run so concurrent CI workers
    // (or repeated local runs without a `docker compose down -v`)
    // don't collide on shared state. The cost is one extra
    // ensureCollection call against the real server.
    chromaCollection: `ci-smoke-${randomUUID().slice(0, 8)}`,
  } as ConfigService;
}

function unitVector(seed: number): number[] {
  const v = new Array(DIM).fill(0) as number[];
  // Deterministic but not all-equal — every seed gets a distinct
  // basis-aligned vector so cosine similarity tells the items apart.
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.sin(seed * 0.31 + i * 0.17);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

describeIf('ChromaVectorStore — real-Chroma smoke (RUN_CHROMA_INTEGRATION=true)', () => {
  let store: ChromaVectorStore;

  beforeEach(async () => {
    store = new ChromaVectorStore(makeConfig());
    await store.ensureCollection();
  });

  afterEach(async () => {
    await store.deleteAll();
  });

  it('round-trips upsert → query against a live Chroma server', async () => {
    const items = [
      {
        id: 'rule-a',
        embedding: unitVector(1),
        document: 'document for rule a',
        metadata: { rule_id: 'a', severity: 'error' },
      },
      {
        id: 'rule-b',
        embedding: unitVector(2),
        document: 'document for rule b',
        metadata: { rule_id: 'b', severity: 'warning' },
      },
      {
        id: 'rule-c',
        embedding: unitVector(3),
        document: 'document for rule c',
        metadata: { rule_id: 'c', severity: 'info' },
      },
    ];

    await store.upsert(items);

    // Query with the exact same vector as rule-b → expect rule-b at
    // the top. The other two are still in the result set with lower
    // scores; this proves the cosine math + score conversion match
    // what the unit tests assert against the mocked client.
    const hits = await store.query({ embedding: unitVector(2), k: 3 });

    expect(hits).toHaveLength(3);
    expect(hits[0].id).toBe('rule-b');
    expect(hits[0].score).toBeGreaterThan(0.99);
    expect(hits[0].document).toBe('document for rule b');
    expect(hits[0].metadata).toMatchObject({ rule_id: 'b', severity: 'warning' });
    // Scores are sorted descending.
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    expect(hits[1].score).toBeGreaterThanOrEqual(hits[2].score);
  });

  it('upsert is idempotent — same id replaces the prior document/embedding', async () => {
    await store.upsert([
      {
        id: 'rule-x',
        embedding: unitVector(10),
        document: 'first version',
        metadata: { rule_id: 'x' },
      },
    ]);

    await store.upsert([
      {
        id: 'rule-x',
        embedding: unitVector(10),
        document: 'second version',
        metadata: { rule_id: 'x', revised: true },
      },
    ]);

    const hits = await store.query({ embedding: unitVector(10), k: 5 });

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('rule-x');
    expect(hits[0].document).toBe('second version');
    expect(hits[0].metadata).toMatchObject({ rule_id: 'x', revised: true });
  });

  it('deleteAll empties the collection without dropping it', async () => {
    await store.upsert([
      {
        id: 'rule-d',
        embedding: unitVector(20),
        document: 'd',
        metadata: { rule_id: 'd' },
      },
    ]);

    await store.deleteAll();

    const hits = await store.query({ embedding: unitVector(20), k: 5 });
    expect(hits).toEqual([]);

    // Collection still exists — subsequent upsert works without a
    // fresh ensureCollection. This is the "test isolation" guarantee
    // the seed runner depends on.
    await store.upsert([
      {
        id: 'rule-e',
        embedding: unitVector(21),
        document: 'e',
        metadata: { rule_id: 'e' },
      },
    ]);
    const hitsAfter = await store.query({ embedding: unitVector(21), k: 5 });
    expect(hitsAfter).toHaveLength(1);
    expect(hitsAfter[0].id).toBe('rule-e');
  });
});
