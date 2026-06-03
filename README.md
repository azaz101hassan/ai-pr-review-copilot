# AI PR Review Copilot

[![CI](https://github.com/azaz101hassan/ai-pr-review-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/azaz101hassan/ai-pr-review-copilot/actions/workflows/ci.yml)

A focused-scope GitHub PR reviewer for your team's own conventions. Retrieves the relevant rules from a per-team knowledge base, runs an agentic Claude review against the diff, and posts inline comments + a walkthrough summary back to the PR.

## Scope: small-PR copilot

This bot is **not** trying to be a general-purpose PR reviewer for arbitrary diffs. Tools like [CodeRabbit](https://www.coderabbit.ai/) already do that job well, with multi-model ensembles, web search, and 50+ static analyzers. They are the recommended tool for large-PR review on this project's repos.

What this bot does instead:

- Reviews **small focused PRs** (default ≤ 500 changed lines, knob: `MAX_REVIEW_DIFF_LINES`). Above the threshold it posts a friendly "review skipped" walkthrough comment and exits — **zero LLM spend on big PRs**.
- Enforces your team's **project-specific conventions** — the rules seeded from `apps/api/seeds/` (CLAUDE.md-style standards, naming, layering, etc.). These are the things generic linters and CodeRabbit don't know about.
- Runs on **Claude Haiku** by default for cost — typical small-PR review costs ~$0.02–0.05. Set `ANTHROPIC_MODEL=claude-sonnet-4-6` if you want the precision bump on specific repos.
- Posts **inline review comments** anchored to the diff hunks plus a single PATCH-edited walkthrough comment per PR (no comment spam on `synchronize`).

The wedge: complementary to CodeRabbit, not competitive. CodeRabbit handles "review the whole PR for generic best practices." This bot handles "did you violate the team's specific written conventions on this small change?"

### Honest about its limits

The reviewer's quality is reliable on focused single-purpose diffs (the eval harness in `apps/api/src/modules/reviews/eval/` measures this — micro-F1 ≥ 0.70 on synthetic gating fixtures). On large, multi-concern PRs the retrieval averages over too much noise and recall drops; that's why the size gate exists. If the bot can't do a good job, it skips honestly rather than posting a low-confidence review.

---

## Repo layout

```
ai-pr-review-copilot/
├── apps/
│   ├── api/        # NestJS — webhook receiver, SQLite storage, future RAG + agents
│   └── web/        # Next.js — operator dashboard
├── docs/
│   ├── plans/      # implementation plans
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

# 3. Boot the API on http://localhost:4001.
npm run dev:api

# 4. (Optional) Boot the dashboard placeholder on http://localhost:4000.
npm run dev:web
```

The API exposes:

- `GET /health` → `{ status: 'ok', uptime, timestamp }` — smoke test target.
- `POST /webhooks/github` → guarded by HMAC-SHA256 signature verification; routes `pull_request` events with action `opened` or `synchronize` into SQLite (`pull_requests` + `webhook_events` tables).
- `POST /embeddings/search` → body `{ diff: string, k?: number }`; returns the top-K matching rules from the seeded corpus. See [`docs/setup/embeddings.md`](docs/setup/embeddings.md) for the full retrieval-loop bring-up (Chroma + Voyage + seed).
- `POST /reviews/dry-run` → body `{ diff: string, k?: number, pr_node_id?: string }`; runs the full review pipeline (retrieve → Claude analyze → persist) and returns `{ review_id, findings, usage, model, prompt_version }`. Rate-limited globally at 30 req/min/IP via `@nestjs/throttler`; only registers when `ENABLE_DRY_RUN=true` (dev default). Also available as `npm run review:dry-run --workspace apps/api -- <diff-path>`. See [`docs/setup/claude.md`](docs/setup/claude.md) for the full Anthropic bring-up (API key + spend cap + model selection).

---

## Connecting a real GitHub repository

To receive PR webhooks from a real GitHub repo, follow [`docs/setup/github-app.md`](docs/setup/github-app.md). The flow is roughly:

1. Register a GitHub App (Pull requests Read & write, Contents Read, Metadata Read; subscribe to "Pull request" event).
2. Set the webhook secret to the value you put in `apps/api/.env`.
3. Run `ngrok http 4001` and paste the HTTPS URL into the App's webhook URL (suffixed with `/webhooks/github`).
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

The `apps/api` suite covers config validation, repositories, the embedding pipeline, the reviewer agent loop, and end-to-end webhook→review specs. Tests run against a real on-disk SQLite database in a temporary directory; no driver mocks.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | NestJS 10 (TypeScript) |
| Frontend | Next.js 14 App Router (operator dashboard) |
| Storage (relational) | SQLite via `better-sqlite3` + Drizzle ORM |
| Storage (vectors) | Chroma 1.5 via Docker Compose |
| Embeddings | Voyage AI `voyage-code-3` (1024-dim, code-tuned) |
| Webhook auth | HMAC-SHA256 + `crypto.timingSafeEqual` |
| Tests | Jest + supertest |
| Monorepo | npm workspaces |
| LLM | Anthropic Claude Haiku (default; override via `ANTHROPIC_MODEL` env) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: GITHUB_WEBHOOK_SECRET is not set` at boot | `apps/api/.env` missing or empty | Copy `.env.example` and set a real secret (`openssl rand -hex 32`). |
| Webhook deliveries return 401 in GitHub's "Recent Deliveries" tab | Webhook secret in the App config doesn't match `apps/api/.env` | Re-copy the secret from `apps/api/.env` into the GitHub App's webhook secret field. |
| `better-sqlite3` rebuild errors on `npm install` | Node version without prebuilt binaries | The local default is Node 24; if rebuilds fail, install Node 22 (`nvm install 22 && nvm use 22`) and reinstall. CI runs Node 22 for the same reason. |
| `next build` fails with type errors after editing pages | Stale `.next/types` | `rm -rf apps/web/.next && npm run build --workspace apps/web`. |
| ngrok URL changes every restart | Free-tier ngrok doesn't reserve subdomains | Either keep the same ngrok session running, or use a paid reserved domain. Update the GitHub App's webhook URL when it changes. |

---

## License

MIT — see [LICENSE](LICENSE).
