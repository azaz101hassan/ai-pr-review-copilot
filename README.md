# AI PR Review Copilot

RAG + agentic LLM that reviews GitHub pull requests against a team knowledge base. Detects coding-standard violations, suggests fixes, and posts structured review comments back to the PR.

**Status:** Day 3 of a 10-day sprint. Today the bot can ingest GitHub PR webhooks (Day 1), semantically retrieve relevant code-style rules for a given diff via Chroma + Voyage embeddings (Day 2), **and** run an end-to-end review against a diff using Anthropic Claude with prompt-cached system prompt + forced `tool_use` for structured findings (Day 3). Agentic tool use, comment posting, and the dashboard land on later days. See [`docs/plans/01-baseline.md`](docs/plans/01-baseline.md) for the full sprint plan.

| Day | Status | What ships | Implementation plan |
|---|---|---|---|
| Day 1 | ✅ shipped | Webhook receiver + SQLite storage + 49 tests | [02-day1-baseline-implementation.md](docs/plans/02-day1-baseline-implementation.md) |
| Day 2 | ✅ shipped | Chroma + Voyage embeddings + seeded ruleset + `POST /embeddings/search` | [03-day2-rag-foundation.md](docs/plans/03-day2-rag-foundation.md) |
| Day 3 | ✅ shipped | Anthropic adapter + `ReviewsService` + `POST /reviews/dry-run` + `npm run review:dry-run` CLI ([setup](docs/setup/claude.md)) | [04-day3-claude-integration.md](docs/plans/04-day3-claude-integration.md) |
| Day 4 | ⏳ next | Agent loop (multi-turn tool use) | |

---

## Repo layout

```
ai-pr-review-copilot/
├── apps/
│   ├── api/        # NestJS — webhook receiver, SQLite storage, future RAG + agents
│   └── web/        # Next.js — dashboard placeholder (Day 7)
├── docs/
│   ├── plans/      # 10-day sprint plan + per-day implementation plans
│   └── setup/      # GitHub App + ngrok walkthrough
└── .github/
    └── workflows/  # CI (tests + next build)
```

---

## Quickstart

```bash
# 1. Install dependencies (npm workspaces installs both apps).
npm install

# 2. Copy the env template and fill in GITHUB_WEBHOOK_SECRET.
#    The webhook secret is what you'll configure in your GitHub App.
cp .env.example apps/api/.env
# then edit apps/api/.env and set GITHUB_WEBHOOK_SECRET=<your secret>

# 3. Boot the API on http://localhost:3001.
npm run dev:api

# 4. (Optional) Boot the dashboard placeholder on http://localhost:3000.
npm run dev:web
```

The API exposes:

- `GET /health` → `{ status: 'ok', uptime, timestamp }` — smoke test target.
- `POST /webhooks/github` → guarded by HMAC-SHA256 signature verification; routes `pull_request` events with action `opened` or `synchronize` into SQLite (`pull_requests` + `webhook_events` tables).
- `POST /embeddings/search` (Day 2) → body `{ diff: string, k?: number }`; returns the top-K matching rules from the seeded corpus. See [`docs/setup/embeddings.md`](docs/setup/embeddings.md) for the full retrieval-loop bring-up (Chroma + Voyage + seed).
- `POST /reviews/dry-run` (Day 3) → body `{ diff: string, k?: number, pr_node_id?: string }`; runs the full review pipeline (retrieve → Claude analyze → persist) and returns `{ review_id, findings, usage, model, prompt_version }`. Rate-limited globally at 30 req/min/IP via `@nestjs/throttler`; only registers when `ENABLE_DRY_RUN=true` (dev default). Also available as `npm run review:dry-run --workspace apps/api -- <diff-path>`. See [`docs/setup/claude.md`](docs/setup/claude.md) for the full Anthropic bring-up (API key + spend cap + model selection).

---

## Connecting a real GitHub repository

To receive PR webhooks from a real GitHub repo, follow [`docs/setup/github-app.md`](docs/setup/github-app.md). The flow is roughly:

1. Register a GitHub App (Pull requests Read & write, Contents Read, Metadata Read; subscribe to "Pull request" event).
2. Set the webhook secret to the value you put in `apps/api/.env`.
3. Run `ngrok http 3001` and paste the HTTPS URL into the App's webhook URL (suffixed with `/webhooks/github`).
4. Install the App on a test repo.
5. Open or update a PR. Watch the API log it.

The "Recent Deliveries" tab in the App's settings is the troubleshooting tool — it shows what GitHub sent, the response we returned, and a "Redeliver" button so you can replay a payload against your local server without making a fresh PR.

---

## Scripts

Root scripts run across all workspaces via npm workspaces:

| Script | What it does |
|---|---|
| `npm install` | Installs deps for the root and every `apps/*` workspace. |
| `npm test` | Runs each workspace's `test` script if defined. Only `apps/api` has tests today. |
| `npm run build` | Runs each workspace's `build` script if defined. |
| `npm run dev:api` | Boots `apps/api` in watch mode (NestJS). |
| `npm run dev:web` | Boots `apps/web` in watch mode (Next.js). |

---

## Tests

```bash
# All workspaces:
npm test

# Just apps/api:
npm test --workspace apps/api

# Watch mode (in apps/api):
cd apps/api && npx jest --watch
```

Day 2 ships with **128 tests** across 17 suites in `apps/api`. New on Day 2 (vs Day 1's 49 across 8 suites):

- `ConfigService` — 10 cases covering the four new env vars (Voyage required, Chroma URL/collection/embedding-model with defaults + validators).
- `SqliteKnowledgeSourcesRepository` and `SqliteKnowledgeChunksRepository` — 14 cases for upsert, `findByIds` order discipline, FK enforcement, `deleteBySourceId`.
- `VoyageEmbeddingProvider` — 10 cases against a mocked `fetch` for batching, asymmetric `input_type`, `VoyageRequestError` scrubbing the response body.
- `ChromaVectorStore` — 15 cases for lazy init, cosine-space collection config, distance→score conversion, URL parsing across http/https/trailing-slash.
- `CorpusLoader`, `EmbeddingsService`, `EmbeddingsController` — 19 cases for chunk normalization, indexing batching, ordering invariant (SQLite first, then Chroma), search enrichment, drift tolerance.
- `Embeddings (e2e)` — 11 cases booting the full `AppModule` against deterministic in-memory stubs for `EMBEDDING_PROVIDER` and `VECTOR_STORE`, seeding the corpus, and asserting top-K orchestration plus DTO validation (including the 50 000-character `diff` cap).

Day 1's 49 tests still pass — see the unit list in [`docs/plans/02-day1-baseline-implementation.md`](docs/plans/02-day1-baseline-implementation.md).

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | NestJS 10 (TypeScript) |
| Frontend | Next.js 14 App Router (placeholder until Day 7) |
| Storage (relational) | SQLite via `better-sqlite3` + Drizzle ORM |
| Storage (vectors) | Chroma 1.5 via Docker Compose |
| Embeddings | Voyage AI `voyage-code-3` (1024-dim, code-tuned) |
| Webhook auth | HMAC-SHA256 + `crypto.timingSafeEqual` |
| Tests | Jest + supertest |
| Monorepo | npm workspaces |
| Future LLM | Anthropic Claude (Sonnet for analysis, Opus for synthesis) — Day 3 |

---

## Day 1 troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: GITHUB_WEBHOOK_SECRET is not set` at boot | `apps/api/.env` missing or empty | Copy `.env.example` and set a real secret (`openssl rand -hex 32`). |
| Webhook deliveries return 401 in GitHub's "Recent Deliveries" tab | Webhook secret in the App config doesn't match `apps/api/.env` | Re-copy the secret from `apps/api/.env` into the GitHub App's webhook secret field. |
| `better-sqlite3` rebuild errors on `npm install` | Node version without prebuilt binaries | The local default is Node 24; if rebuilds fail, install Node 22 (`nvm install 22 && nvm use 22`) and reinstall. CI runs Node 22 for the same reason. |
| `next build` fails with type errors after editing pages | Stale `.next/types` | `rm -rf apps/web/.next && npm run build --workspace apps/web`. |
| ngrok URL changes every restart | Free-tier ngrok doesn't reserve subdomains | Either keep the same ngrok session running, or use a paid reserved domain. Update the GitHub App's webhook URL when it changes. |

---

## License

UNLICENSED. Private project during Day 1; flipping public around Day 5 when the MVP demo is recorded.
