# RAG foundation setup — Chroma + Voyage embeddings

This walks you through standing up the Day-2 retrieval pipeline locally: a Chroma vector database via Docker Compose, a Voyage AI API key for embeddings, and a seeded corpus of code-style rules you can query from a CLI or HTTP. Target: a working `POST /embeddings/search` in **about 20 minutes** on a fresh clone.

> **Why Voyage and not OpenAI / Cohere / a local model?** The project is Anthropic-first, and Anthropic acquired Voyage in early 2025 — their embedding docs route here. `voyage-code-3` is also code-tuned, which matters when the corpus is a code-style ruleset. See [`docs/plans/03-day2-rag-foundation.md`](../plans/03-day2-rag-foundation.md) for the full rationale.

---

## Prerequisites

- The repo cloned and `npm install`'d.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running. (Day 1 didn't need Docker; Day 2 does — Chroma is the new dev dependency.)
- A working `apps/api/.env` from the Day-1 setup. If you haven't done that yet, follow [`github-app.md`](github-app.md) first.

---

## 1. Sign up for Voyage AI and create an API key

1. Go to [voyageai.com](https://www.voyageai.com/) and create an account.
2. Open your [dashboard](https://dash.voyageai.com/) → **API Keys** → **Create new secret key**. Copy it immediately — it's only shown once.
3. **Attach a payment method.** The free tier without one is capped at **3 requests/minute, 10 000 tokens/minute** — far too low to seed the corpus in one go. Once a payment method is on file the limits jump to ~2000 RPM. The sprint corpus is small enough that you won't actually be charged anything close to a dollar; the payment method is just the unlock.

> The key looks like `pa-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`. It is **not** the same as any Anthropic API key — they are separate billing relationships even though Anthropic owns Voyage.

---

## 2. Add the new env vars to `apps/api/.env`

Open `apps/api/.env` and add:

```bash
# Required
VOYAGE_API_KEY=pa-paste-your-key-here

# Optional (defaults shown — uncomment to override)
# CHROMA_URL=http://localhost:8000
# CHROMA_COLLECTION=code-style-rules
# EMBEDDING_MODEL=voyage-code-3
```

The API will refuse to start without `VOYAGE_API_KEY` — `ConfigService` validates it at boot. The other three carry sensible defaults; touch them only if you're pointing at a non-local Chroma or experimenting with a different Voyage model.

---

## 3. Start Chroma via Docker Compose

From the repo root:

```bash
docker compose up -d chroma
```

The container exposes Chroma on `localhost:8000` and persists its index at `./chroma-data/` (bind-mounted into the container, gitignored). After ~20 seconds it should report healthy:

```bash
docker compose ps
# NAME               STATUS                  PORTS
# pr-copilot-chroma  Up 25s (healthy)        0.0.0.0:8000->8000/tcp
```

Verify the heartbeat directly:

```bash
curl http://localhost:8000/api/v2/heartbeat
# {"nanosecond heartbeat": 1748284800000000000}
```

> **Heads up — the heartbeat path moved.** Old Chroma tutorials reference `/api/v1/heartbeat`; that path is removed in current builds. The healthcheck in `docker-compose.yml` already hits the v2 path; if you ever copy a Chroma snippet from elsewhere, double-check.

Stop the container with `docker compose down`. The persisted volume in `./chroma-data/` survives — to wipe it, `docker compose down -v`.

---

## 4. Seed the corpus

The seed runner reads `apps/api/seeds/*.json`, chunks each rule into a `KnowledgeChunkInput`, calls Voyage to embed every chunk in batches, and persists chunks (in SQLite) plus vectors (in Chroma):

```bash
npm run seed:knowledge --workspace apps/api
```

You should see something like:

```
[Nest] LOG [seed:knowledge] starting indexCorpus()…
[Nest] LOG [EmbeddingsService] indexCorpus: 2 sources, 44 chunks, 3148 embedding tokens
[Nest] LOG [seed:knowledge] done — sources=2, chunks=44, tokens=3148
```

Re-running is idempotent — chunks upsert by `(source_id, rule_id)`, and Chroma upserts by deterministic chunk id. The Voyage tokens *are* re-spent each run (the corpus is small enough that this is a few cents at most; future days may add an embedding cache).

---

## 5. Query from the CLI

```bash
npm run query:rules --workspace apps/api -- test/fixtures/diffs/eqeqeq-violation.patch
```

Output:

```
rule                          score   title
----------------------------  ------  -----
airbnb-eslint:eqeqeq          0.842   Use === and !==, never == or !=
airbnb-eslint:no-nested-ternary  0.514   Do not nest ternary expressions
…
```

`--k=<n>` adjusts the top-K (default 10, max 100). Pipe a diff from stdin:

```bash
git diff main..HEAD | npm run query:rules --workspace apps/api --
```

---

## 6. Query over HTTP

Boot the API (`npm run dev:api`) and POST to `/embeddings/search`:

```bash
curl -s http://localhost:4001/embeddings/search \
  -H 'Content-Type: application/json' \
  -d '{"diff":"if (count == 0) { return; }","k":5}' | jq
```

Response shape:

```json
{
  "hits": [
    {
      "rule_id": "eqeqeq",
      "source": "airbnb-eslint",
      "score": 0.842,
      "title": "Use === and !==, never == or !=",
      "document": "Use === and !==, never == or !=\n\nLoose equality…",
      "metadata": { "rule_id": "eqeqeq", "source": "airbnb-eslint", "severity": "error" }
    }
  ]
}
```

The `diff` field is capped at 50 000 chars (Voyage is per-token, the endpoint is unauthenticated; the cap prevents a runaway caller from draining the API budget). `k` is bounded 1..100.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| API refuses to start with "VOYAGE_API_KEY is missing…" | `apps/api/.env` doesn't have the key set, or the value is shorter than 16 chars. | Paste the full key from voyageai.com into `VOYAGE_API_KEY=…`. |
| `docker compose ps` shows the container as `(unhealthy)` | Healthcheck is hitting `localhost:8000/api/v2/heartbeat` inside the container; Chroma still booting, or a port collision. | Wait 20s and re-check. If still unhealthy, run `docker compose logs chroma`. Confirm no other process holds port 8000 (`lsof -i :8000`). |
| `seed:knowledge` exits with `VoyageRequestError: HTTP 429` | Free-tier rate limit (3 RPM / 10K TPM). | Attach a payment method to your Voyage account (step 1). The corpus is small enough that you won't be charged meaningfully. |
| `seed:knowledge` exits with `VoyageRequestError: HTTP 401` | The pasted API key is wrong, expired, or contains a stray space. | Regenerate at [dash.voyageai.com](https://dash.voyageai.com/) → API Keys, paste fresh. |
| `seed:knowledge` exits with `ChromaRequestError: getOrCreateCollection failed` | Chroma container isn't running, or `CHROMA_URL` points somewhere else. | `docker compose up -d chroma`, wait for healthy, retry. |
| Migration drift after pulling new commits | Old SQLite file at `apps/api/data/app.sqlite` predates a new Drizzle migration. | `rm -f apps/api/data/app.sqlite*` and re-seed. (Local dev only — production migrations are forward-only.) |
| HTTP search returns `[]` for every diff | Corpus not seeded. | `npm run seed:knowledge --workspace apps/api`. |
| `Cannot instantiate a collection with the DefaultEmbeddingFunction` printed repeatedly | A collection exists in your local Chroma volume that was created by a pre-fix version of the adapter (stored `default-embed` in its config metadata). Our adapter passes `embeddingFunction: null` on create, but doesn't rewrite the metadata on read. | Wipe the bind-mounted host directory: `docker compose down && rm -rf chroma-data/ && docker compose up -d chroma`. **Note**: `docker compose down -v` is NOT enough — `-v` only removes Docker-managed volumes, not host bind mounts. Next seed creates the collection fresh with the right config. |
| Need to fully reset local state | Re-seeding after corpus changes, or recovering from drift between SQLite chunks and Chroma vectors. | `docker compose down && rm -rf chroma-data/ apps/api/data/app.sqlite* && docker compose up -d chroma && npm run seed:knowledge --workspace apps/api`. Wipes both stores; next seed rebuilds them from `apps/api/seeds/*.json`. |

---

## What this loop does NOT do (yet)

These land on later days, intentionally:

- **No LLM analysis** — `search` returns matching rules, but doesn't write a review. Day 3 wires Claude in.
- **No GitHub posting** — review comments don't go back to PRs yet. Day 5 adds Octokit posting.
- **No auth on the search endpoint** — `POST /embeddings/search` is open, matching `/health`. Day 5's auth work covers both.
- **Whole-diff embedding only** — large diffs may suffer dilution. Per-hunk embedding is a Day-6 optimization, gated on the eval harness showing it matters.
- **No live ESLint-docs fetch** — `seeds/airbnb-rules.json` is a curated snapshot. A live "refresh" command lands alongside the Day-6 eval harness.

See [`docs/plans/03-day2-rag-foundation.md`](../plans/03-day2-rag-foundation.md) → **Scope Boundaries** for the full deferred list.
