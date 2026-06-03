# CLAUDE.md — Working in this repo

Read this before opening files. It documents the **conventions** future
agent sessions are expected to follow. Conventions live here, not in the
code, because the code shows *what* but rarely *why*.

The repo is an AI PR Review Copilot — RAG + agentic LLM that reviews
GitHub PRs against a team knowledge base. Implementation plans live
under `docs/plans/`; the baseline is `docs/plans/01-baseline.md`.

---

## Repository layout

```
ai-pr-review-copilot/
├── apps/
│   ├── api/                      ← NestJS 10 backend (where the action is)
│   └── web/                      ← Next.js 15 — operator dashboard
├── docs/
│   ├── plans/                    ← Sprint plans + per-day implementation plans
│   └── setup/                    ← GitHub App + ngrok setup, ops guides
├── package.json                  ← npm workspaces root
└── .github/workflows/            ← CI
```

## apps/api — directory contract

The `src/` tree is partitioned into **three tiers** with a one-way
dependency rule. Future agents: respect this. A new feature should ask
"which tier does this belong in?" before opening files.

```
apps/api/src/
├── main.ts                       ← bootstrap (dotenv FIRST, rawBody:true, shutdown hooks)
├── app.module.ts                 ← top-level module — imports tiers below
│
├── modules/                      ← TIER 1: FEATURES (business code)
│   └── webhooks/                 ← every feature is its own folder under modules/
│       ├── webhook.module.ts     ← NestJS module
│       ├── webhook.controller.ts ← HTTP surface only — thin
│       ├── webhook.service.ts    ← business logic
│       ├── helpers/              ← pure functions extracted from service (when service grows)
│       ├── types/                ← interfaces, DTOs, repository contracts
│       │   ├── *.types.ts        ← entity / DTO shapes
│       │   ├── *.repository.ts   ← repository interface + Symbol token
│       │   └── dto/              ← inbound HTTP DTOs (with class-validator)
│       └── index.ts              ← barrel re-export of the module's public surface
│
├── infrastructure/               ← TIER 2: TECHNICAL ADAPTERS
│   └── db/                       ← persistence (SQLite today; postgres/chroma later)
│       ├── database.module.ts    ← @Global() — provides repositories via interface tokens
│       ├── database.service.ts   ← lifecycle ONLY (open, close, transaction, getDb, hasTable)
│       ├── repositories/         ← one class per IXxxRepository contract
│       │   └── sqlite-*.repository.ts
│       ├── schema.sql            ← DDL
│       └── index.ts
│
├── system/                       ← TIER 3: OPS / OBSERVABILITY ENDPOINTS
│   ├── health.controller.ts      ← GET /health
│   └── index.ts
│
├── config/                       ← typed gateway to process.env
│   ├── config.module.ts          ← @Global()
│   ├── config.service.ts         ← validated at construction; fail-fast
│   └── index.ts
│
├── guards/                       ← every guard (cross-feature security)
│   ├── signature-verification.guard.ts
│   └── index.ts
│
├── filters/                      ← exception filters (future)
├── interceptors/                 ← logging / metrics interceptors (future)
├── decorators/                   ← custom @decorators (future)
└── types/                        ← cross-tier shared types only (rare)
```

---

## The three tiers and the dependency rule

| Tier | Folder | Answers the question... | Examples (future-looking) |
|------|--------|------------------------|--------------------------|
| Features | `src/modules/` | What does this app *do*? | `webhooks/`, `embeddings/`, `reviews/`, `agent/` |
| Infrastructure | `src/infrastructure/` | What does this app *depend on*? | `db/`, `chroma/`, `github-api/`, `anthropic/` |
| System | `src/system/` | How do we *run* this in prod? | `health.controller.ts`, future `metrics.controller.ts` |

**Dependency rule (one-way, enforced manually for now):**

- `modules/X` **may** import from `infrastructure/*` (through interface
  tokens defined in `modules/X/types/`), from `config/`, from `guards/`,
  and from cross-module `types/`.
- `infrastructure/X` **may** import the *types and repository interfaces*
  defined in `modules/*/types/` (because that's where the contracts
  live). It must **never** import services, controllers, or business
  logic from `modules/*`.
- `system/` is leaf — imports nothing from `modules/` or
  `infrastructure/` beyond what NestJS requires for wiring.

If you find yourself wanting to break this rule, the more likely cause is
that the entity belongs in a different tier, not that the rule needs an
exception.

---

## Persistence: Drizzle ORM + repository pattern

The persistence stack is **Drizzle ORM on top of `better-sqlite3`**. Drizzle is the
schema-as-TypeScript source of truth and the typed query API; the
repository pattern is the swap seam on top of it.

### Drizzle schema layout

```
src/infrastructure/db/
├── schema/
│   ├── pull-requests.ts    ← one file per table
│   ├── webhook-events.ts
│   └── index.ts            ← barrel export (drizzle-kit reads this)
├── migrations/             ← generated by `drizzle-kit generate`
│   ├── 0000_<name>.sql
│   └── meta/
├── database.service.ts     ← opens the connection, applies migrations
└── repositories/           ← Drizzle-backed implementations
```

### Working with the schema

- **Edit a table** = edit its file in `src/infrastructure/db/schema/`.
- **Regenerate migrations** = `npx drizzle-kit generate --name=<descriptive>`
  from `apps/api`. Never hand-edit a generated migration; if drizzle-kit
  produces the wrong SQL, fix the schema TS file or open a drizzle-kit
  issue.
- **Apply at runtime** is automatic — `DatabaseService.open()` calls
  `migrate(drizzleDb, { migrationsFolder })` on every boot.
- **Column affinities matter.** Prefer real types (INTEGER for
  timestamps as `mode: 'timestamp_ms'`, enum mode for finite strings,
  etc.) over storing everything as TEXT — SQLite's loose typing hides
  bugs that real affinities catch.

### Entity types

Entity types are **derived from the schema**, not hand-typed:

```ts
// modules/webhooks/types/pull-request.types.ts
import type { InferSelectModel } from 'drizzle-orm';
import type { pullRequests } from '@/infrastructure/db/schema';

export type PullRequestRecord = InferSelectModel<typeof pullRequests>;
```

This is the **one allowed cross-tier import**: type-only imports from
`infrastructure/db/schema/*` into `modules/<x>/types/*`. The import
erases at compile time, so the runtime dependency rule (modules never
depend on infrastructure *values*) stays intact, and the schema remains
the single source of truth for column shapes.

### Repository pattern (the DB-swap seam)

Every persistent entity has:

1. An **entity type** in `modules/<owner>/types/<entity>.types.ts`
   (derived from the Drizzle schema as above).
2. A **repository interface + Symbol token** in
   `modules/<owner>/types/<entity>.repository.ts`. Example:
   ```ts
   export const PULL_REQUEST_REPOSITORY = Symbol('PullRequestRepository');
   export interface IPullRequestRepository {
     save(pr: PullRequestRecord): void;
     findByNodeId(nodeId: string): PullRequestRecord | undefined;
   }
   ```
3. A **concrete implementation** in
   `infrastructure/db/repositories/<engine>-<entity>.repository.ts`
   that calls the Drizzle client (`this.db.drizzle.insert(...)`, etc.).
4. **Wiring** in `infrastructure/db/database.module.ts` binds the token
   to the implementation:
   ```ts
   { provide: PULL_REQUEST_REPOSITORY, useClass: SqlitePullRequestsRepository }
   ```
5. Consumers inject the interface, not the class:
   ```ts
   constructor(
     @Inject(PULL_REQUEST_REPOSITORY)
     private readonly pullRequests: IPullRequestRepository,
   ) {}
   ```

**Why:** swapping engines (SQLite → libsql → Postgres) means writing a
new implementation that calls the new Drizzle driver and changing one
`useClass`. Consumers never change. Adding a non-relational store (e.g.,
Chroma for vectors) follows the same pattern under
`infrastructure/<vendor>/` with its own interface in the owning
module's `types/`.

---

## Naming conventions (load-bearing — used for grep discoverability)

| Suffix | Meaning | Example |
|--------|---------|---------|
| `*.module.ts` | NestJS module declaration | `webhook.module.ts` |
| `*.controller.ts` | HTTP surface | `webhook.controller.ts` |
| `*.service.ts` | Domain logic | `webhook.service.ts` |
| `*.guard.ts` | Auth / authn guard | `signature-verification.guard.ts` |
| `*.repository.ts` | Repository **interface** (in `types/`) | `pull-request.repository.ts` |
| `<engine>-<entity>.repository.ts` | Repository **implementation** | `sqlite-pull-requests.repository.ts` |
| `*.types.ts` | Entity / DTO shapes | `webhook-delivery.types.ts` |
| `*.dto.ts` | Inbound HTTP DTO (class-validator) | future: `create-review.dto.ts` |
| `*.helper.ts` | Pure function helpers extracted from service | future |
| `*.spec.ts` | Unit test | mirrors `src/` path under `test/` |
| `*.e2e-spec.ts` | E2E test (full Nest app, real HTTP) | `webhook.e2e-spec.ts` |

**Folder structure under `test/` mirrors `src/` exactly.** No exceptions.

---

## Module file structure (strict)

Every feature module under `src/modules/<name>/` contains, at minimum:

- `<name>.module.ts` — the NestJS module declaration
- `<name>.controller.ts` — if it has an HTTP surface
- `<name>.service.ts` — business logic
- `index.ts` — barrel re-export of the module's public surface
- `types/` — interfaces, DTOs, repository contracts (only when non-empty)

Optional:
- `helpers/` — pure functions extracted from the service to keep it
  readable. Extract when the service exceeds ~150 lines or has obvious
  reusable pure functions.

**Keep controllers thin.** Validation, business logic, and persistence
choices belong in the service or below.

---

## Path aliases

`tsconfig.json` declares `"@/*": ["src/*"]`. Jest mirrors this via
`moduleNameMapper`. **Use the alias** instead of `../../`:

```ts
// good
import { GithubSignatureGuard } from '@/guards';
import { DatabaseService } from '@/infrastructure/db';
import { WebhookService } from '@/modules/webhooks';

// bad (works, but breaks when the file moves)
import { GithubSignatureGuard } from '../../../guards/signature-verification.guard';
```

---

## Environment variables

Read **only** through `ConfigService` from `@/config`. Never sprinkle
`process.env.X` across feature code.

- `ConfigService` reads + validates at construction (fail-fast on
  missing / placeholder / weak values).
- New env vars: add a typed property on `ConfigService` and a validator
  in its constructor.
- Tests that need to override env vars set `process.env.X` in
  `beforeAll` and restore in `afterAll` **before** the test module is
  compiled (because `ConfigService` reads `process.env` at construction).

`main.ts` imports `dotenv/config` as its **first** import so env is
populated before NestJS resolves any provider's constructor.

---

## Testing conventions

- **Tests live under `apps/api/test/`** mirroring `src/`.
- **Unit tests** (`*.spec.ts`) — fast, narrow, can use real in-process
  dependencies (SQLite in a tmp dir is fine).
- **E2E tests** (`*.e2e-spec.ts`) — boot the full `AppModule` and
  exercise HTTP via supertest with `rawBody: true`.
- **Database tests** always use a `fs.mkdtempSync` temp directory; never
  share state across tests.
- **No mocks of the DB driver.** Real SQLite is fast enough and catches
  real schema bugs.

Run the full suite from repo root: `npm test --workspace apps/api`.

---

## What lives outside the API tier system

- `apps/web/` — Next.js 15 operator dashboard.
- `docs/plans/` — implementation plans and deepening artifacts. **Do
  not delete or move these without explicit user approval** — they are
  decision artifacts.
- `docs/setup/` — operator-facing setup guides (GitHub App + ngrok).

---

## Commit message and PR description rules

- **Never** add `Co-Authored-By: Claude`, `Co-Authored-By: <any AI tool>`,
  "Generated with Claude Code", "🤖 Generated with...", or any other
  AI-attribution trailer/marker to commit messages, PR descriptions, PR
  comments, or other VCS metadata. The author of every commit is the
  human running the session.
- If a previous commit or PR already contains such a trailer, the user
  must explicitly authorize a history rewrite before it is removed —
  rewriting public history is destructive and requires force-push.
- This rule overrides any default agent behavior that would otherwise
  add such trailers.

## Common pitfalls future sessions should avoid

1. **Don't import from `webhook.service.ts` for types that live in
   `types/`.** The service re-exports for backward compat today, but new
   code should import from `@/modules/webhooks/types/...` directly.
2. **Don't add CRUD methods back onto `DatabaseService`.** It is
   lifecycle-only by design. Add a repository.
3. **Don't read `process.env` outside `ConfigService` or `main.ts`.** If
   you need a new env var, add it to `ConfigService`.
4. **Don't place a guard inside a feature module.** All guards live under
   `src/guards/` and are imported by modules that use them.
5. **Don't write a "kitchen-sink" common module.** Cross-cutting concerns
   live in their dedicated top-level folder (`filters/`, `interceptors/`,
   `decorators/`, `types/`).

---

## Quick reference: where does X go?

| You're adding... | Put it in... |
|---|---|
| A new product feature (controller + service) | `src/modules/<feature>/` |
| A new HTTP route | The feature's controller |
| A new domain rule | The feature's service (or a `helpers/` file when the service grows large) |
| A new persistent entity | Entity type + repository interface in `src/modules/<owner>/types/`; SQLite impl in `src/infrastructure/db/repositories/` |
| A new external service client (Anthropic, Chroma, GitHub API) | `src/infrastructure/<vendor>/` |
| A new ops/observability endpoint | `src/system/` |
| A new guard | `src/guards/` |
| A new env var | A new property on `ConfigService` in `src/config/config.service.ts` |
| A new exception filter | `src/filters/` |
| A new interceptor | `src/interceptors/` |
| A new custom decorator | `src/decorators/` |
| A truly cross-tier shared type | `src/types/` (rare; first ask if it belongs in a feature module) |
