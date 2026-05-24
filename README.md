# AI PR Review Copilot

RAG + agentic LLM that reviews GitHub pull requests against a team knowledge base. Detects coding-standard violations, suggests fixes, and posts structured review comments back to the PR.

**Status:** Day 1 of a 10-day sprint. Today it can *see* PRs over an ngrok tunnel and persist them locally; everything else (Chroma, Claude, agentic tool use, dashboard, deployment) lands on later days. See [`docs/plans/01-baseline.md`](docs/plans/01-baseline.md) for the full sprint plan and [`docs/plans/02-day1-baseline-implementation.md`](docs/plans/02-day1-baseline-implementation.md) for today's implementation detail.

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

Day 1 ships with **35 tests** across 5 suites in `apps/api`:

- Signature verification guard (11 unit tests covering valid signatures, missing headers, malformed prefixes, length mismatches, hex validation, missing `rawBody`).
- SQLite database service (10 unit tests covering schema idempotency, upserts, foreign-key enforcement, unique-delivery rejection).
- Webhook service (8 unit tests covering `opened`/`synchronize`/`closed`/`push`/`ping` routing with a real SQLite file).
- Webhook controller (6 e2e tests via supertest — full HTTP flow including bad-signature short-circuit).
- Health endpoint (1 e2e test).

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | NestJS 10 (TypeScript) |
| Frontend | Next.js 14 App Router (placeholder until Day 7) |
| Storage (Day 1) | SQLite via `better-sqlite3` |
| Webhook auth | HMAC-SHA256 + `crypto.timingSafeEqual` |
| Tests | Jest + supertest |
| Monorepo | npm workspaces |
| Future LLM | Anthropic Claude (Sonnet for analysis, Opus for synthesis) |
| Future vector DB | Chroma |

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
