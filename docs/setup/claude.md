# Claude integration setup — Anthropic SDK + structured findings

This walks you through standing up the review loop locally: an Anthropic API key with a workspace spend cap, a `.env` knob for the model, and the new `npm run review:dry-run` CLI plus `POST /reviews/dry-run` HTTP endpoint. Target: a working end-to-end dry-run that prints findings on a violation diff in **about 15 minutes** on a fresh clone.

> **Prerequisite:** The webhook receiver and the Chroma + Voyage + seeded corpus setup are already shipped on `main`. If you haven't run [`docs/setup/embeddings.md`](embeddings.md), do that first — the review loop *retrieves* the rules seeded there.

---

## 1. Sign up for Anthropic and create an API key

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account.
2. Open **Settings → API Keys** → **Create Key**. Copy it immediately — it's only shown once.

> The key looks like `sk-ant-api03-XXXXXXXXXXX...`. It is **not** the same as the Voyage key — Anthropic and Voyage are separate billing relationships even though Anthropic owns Voyage.

---

## 2. **Required: set a workspace spend cap**

Anthropic supports a hard monthly cap. **Do this before running anything that calls the API** — it is the dollar backstop if a runaway loop or misconfigured key somehow gets out.

1. **Settings → Limits** → **Monthly spending limit**.
2. Set it to something small enough that you'd notice the alert but large enough to cover your work. **Suggested: $10–$25**.
3. Confirm.

Each `runDryRun` call is approximately **1–5¢** depending on cache state (cold Sonnet ~$0.04–$0.10; warm cache halves it; Haiku is ~8× cheaper across the board). The local 30 req/min/IP throttler caps per-IP burn rate; this spend cap is the dollar-amount backstop on top.

If your usage approaches **$5** during a single dev session, that's already unusual — audit the iteration loop before continuing.

---

## 3. Add billing

New accounts get $5 of free credit. Add a payment method only if you've exhausted it or want to remove the rate-limit floors that apply to credit-only accounts.

---

## 4. Paste the key into `apps/api/.env`

Open `apps/api/.env` and add:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-api03-paste-your-key-here

# Optional — see "Model selection" below
# ANTHROPIC_MODEL=

# Optional — see "ENABLE_DRY_RUN gating" below
# ENABLE_DRY_RUN=
```

The API will refuse to start without `ANTHROPIC_API_KEY` — `ConfigService` validates it at boot. (Same fail-fast as `GITHUB_WEBHOOK_SECRET` and `VOYAGE_API_KEY`.)

---

## 5. Model selection

The `ANTHROPIC_MODEL` env var defaults to a **NODE_ENV-aware** choice so dev iteration stays cheap and production stays demo-quality:

| `NODE_ENV` | `ANTHROPIC_MODEL` unset | Resolved model |
| --- | --- | --- |
| `development` (default in `npm run dev:api`) | yes | `claude-haiku-4-5-20251001` (~8× cheaper than Sonnet) |
| `production` | yes | `claude-sonnet-4-6` (demo-quality output) |
| any | explicitly set | the explicit value always wins |

**Override paths:**

- **Force Haiku in dev (recommended default, already the case in dev):** leave `ANTHROPIC_MODEL` unset — Haiku is the dev default. Setting `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` explicitly is fine if you want it visible in `.env`.
- **Smoke-test production model in dev:** set `ANTHROPIC_MODEL=claude-sonnet-4-6` in `.env` before bringing up `npm run dev:api`.
- **Try Opus 4.7 for a one-off:** set `ANTHROPIC_MODEL=claude-opus-4-7` (~5× cost vs Sonnet — use sparingly).

The resolved model is **logged twice** so a misconfig surfaces immediately:

1. At NestJS startup: `[ConfigService] Resolved model: claude-haiku-4-5-20251001`
2. At the end of every CLI dry-run: `[review:dry-run] model: claude-haiku-4-5-20251001`

If you're unsure which model just ran, check the CLI line directly above the cost log.

---

## 6. `ENABLE_DRY_RUN` gating

`POST /reviews/dry-run` only registers when `ENABLE_DRY_RUN` is truthy. The default flips by environment:

| `NODE_ENV` | `ENABLE_DRY_RUN` unset | Resolved value |
| --- | --- | --- |
| `development` | yes | `true` |
| anything else | yes | `false` |
| any | `true` / `1` / `yes` (case-insensitive) | `true` |
| any | anything else (or empty) | `false` |

**Why:** the endpoint is unauthenticated in development builds. Gating it on `ENABLE_DRY_RUN=false` outside dev forecloses the accidental-deploy-to-prod denial-of-wallet path. The CLI (`npm run review:dry-run`) is unaffected — it's process-local, no HTTP.

Override to `ENABLE_DRY_RUN=false` in dev if you want to use only the CLI surface and verify the 404 behavior locally.

---

## 7. Daily — running a dry-run

### From the CLI (preferred for iteration)

```bash
npm run review:dry-run --workspace apps/api -- test/fixtures/diffs/no-var-violation.patch
```

Or pipe a real diff:

```bash
git diff main..HEAD | npm run review:dry-run --workspace apps/api
```

Optional flag: `--k=<n>` to override the retrieval top-K (default `10`, max `100`).

Output:

```
[review:dry-run] model: claude-haiku-4-5-20251001
[review:dry-run] review_id: 8c5a3...
[review:dry-run] 1 finding(s)

severity   rule_id   title                            message
---------  --------  ------------------------------   ---------------------------------------------
error      no-var    Use let or const, never var      Replace `var sum = 0;` with `let sum = 0;`…

[review:dry-run] estimated cost: $0.0142 (input 1283 / output 86 tokens, model claude-haiku-4-5-20251001)
```

The cost line is estimated from the published per-token rates for the resolved model. Use it to spot iteration-loop spend before it adds up.

### From HTTP (mirrors the CLI surface for parity testing)

Boot the API:

```bash
npm run dev:api
```

POST to `/reviews/dry-run`:

```bash
curl -sS http://localhost:4001/reviews/dry-run \
  -H 'Content-Type: application/json' \
  -d '{ "diff": "diff --git a/x.js b/x.js\n@@ -1 +1 @@\n-let x = 1\n+var x = 1\n", "k": 5 }' | jq
```

Response shape:

```json
{
  "review_id": "8c5a3f...-...",
  "status": "completed",
  "findings": [
    {
      "id": "...",
      "rule_id": "no-var",
      "severity": "error",
      "title": "Use let or const, never var",
      "message": "Replace `var` with `let` or `const`.",
      "location_hint": "src/x.js:1",
      "citation": "var x = 1;"
    }
  ],
  "usage": { "input_tokens": 1283, "output_tokens": 86, "cache_creation_input_tokens": 1100, "cache_read_input_tokens": null },
  "model": "claude-haiku-4-5-20251001",
  "prompt_version": "v3",
  "turn_count": 1,
  "tool_calls": [
    {
      "turn_idx": 1,
      "tool_name": "emit_finding",
      "input_hash": "a1b2c3d4e5f60718",
      "result_bytes": 220,
      "latency_ms": 711,
      "stop_reason": "tool_use"
    }
  ]
}
```

`turn_count` is always populated on `status: 'completed'` (1 for the degenerate single-turn case; 2-6 when the agent fetched repo context before emitting). `tool_calls` is the per-turn trace — one record per `messages.create` call. On `status: 'failed'`, `turn_count` reflects the partial loop progress and `tool_calls` carries the partial trace when the failure was loop-internal (`turn_cap_exceeded`, `malformed_emit_finding`); pre-loop failures (auth, network) leave `turn_count` at 0 and `tool_calls` null. The HTTP path uses a `NullRepoContextProvider` by default — every context fetch returns `is_error: true` and Claude falls through to `emit_finding` on turn 1. Use the CLI's `--repo=<dir>` flag for multi-turn behavior against fixture repos.

The persisted `reviews` row is queryable directly:

```bash
sqlite3 apps/api/data/app.sqlite \
  'SELECT id, status, model, input_tokens, output_tokens FROM reviews ORDER BY created_at DESC LIMIT 5;'
```

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| **401** with `errorCode='authentication_error'` | Wrong / revoked / stale key | Regenerate at the console and replace `ANTHROPIC_API_KEY`. |
| **400** with `errorCode='credit_balance_too_low'` (or the raw server message `"Your credit balance is too low …"`) | Anthropic workspace credit balance is empty | Top up at [console.anthropic.com → Billing](https://console.anthropic.com/settings/billing). The free `$5` credit on new accounts gets exhausted after a few hundred calls. Anthropic returns HTTP 400 with `invalid_request_error` for this — the adapter pattern-matches the message and surfaces the clearer `credit_balance_too_low` code. |
| **429** with `errorCode='rate_limit_error'` | Hit Anthropic's per-minute throughput | Back off; the dry-run loop is synchronous, so you'll feel it. The SDK retries twice with exponential backoff before throwing. |
| **429** with `ThrottlerException` (HTTP body) | Hit the local `@nestjs/throttler` guard (30 req/min/IP) — **not** Anthropic | Cool off 60 seconds. The CLI bypasses this. |
| **529** with `errorCode='overloaded_error'` | Anthropic capacity issue | Retry. The SDK retries twice automatically before throwing. |
| **404** on `POST /reviews/dry-run` | `ENABLE_DRY_RUN` is `false` | Set `ENABLE_DRY_RUN=true` in `apps/api/.env` (dev only) or use the CLI. |
| **`unexpected_response_shape`** error | Claude returned something other than the forced tool call (rare with `tool_choice: { type: 'tool' }`) | File a bug. Inspect logs for the actual shape; verify the model id isn't a typo. |
| **`truncated_response`** error (`stop_reason === 'max_tokens'`) | Claude ran out of room | Increase `MAX_TOKENS` in `infrastructure/anthropic/anthropic-llm-reviewer.ts` (default 4096) or trim the diff. |
| **`turn_cap_exceeded`** error | The multi-turn agent loop reached the 6-turn cap without calling `emit_finding` — usually means Claude is oscillating between tool calls or hitting repeated `is_error` results | Inspect `tool_calls_json` on the failed `reviews` row for the per-turn trace. The review is marked `failed` and no findings are persisted. If a fixture consistently hits the cap, narrow the prompt or pre-seed context the agent would otherwise have to discover. |
| **`malformed_emit_finding`** error | Claude invoked `emit_finding` but the payload failed schema validation (e.g., `findings: null`, missing `rule_id` / `title` / `message`, or non-string `location_hint` / `citation`) | Inspect `tool_calls_json` for the partial loop state. If recurring, tighten the `EMIT_FINDING_TOOL` schema or add a corrective example to `SYSTEM_PROMPT` — both edits require bumping `PROMPT_AND_TOOL_VERSION` and the `HASH_MAP` entry in the same commit. |
| **`AnalyzeDiffResult` findings empty when violations are obvious** | Retrieval didn't surface the expected rule in top-K | Run `npm run query:rules --workspace apps/api -- <path>` to see what's actually retrieved. If the rule isn't in the top-K, the embeddings layer is the problem, not Claude. |
| **`Resolved model: claude-haiku-...` when you expected Sonnet** (or vice versa) | NODE_ENV mismatch | Verify `NODE_ENV` in the shell that booted `npm run dev:api`. Set `ANTHROPIC_MODEL` explicitly in `.env` if you want to lock the choice. |
| **Cost surprise** — `[review:dry-run] estimated cost` exceeds a couple cents per call | Cache miss (every call), or accidentally on Opus/Sonnet during iteration | Check the resolved-model line. If it's Sonnet/Opus and you're iterating, switch to Haiku. If cache_read tokens stay at 0 across calls, the system prompt likely drifted — `git diff apps/api/src/infrastructure/anthropic/anthropic-llm-reviewer.ts`. |
| **`cache(read/write)=0/0` every call** on Haiku | Haiku's prompt-cache minimum is higher than Sonnet's (~2048 vs ~1024 tokens). Our cacheable prefix (~1280 tokens) clears Sonnet but not Haiku. | Expected and intentional — padding the prompt further to clear Haiku's threshold would make every Haiku call more expensive (bigger prompt) for caching benefits that only materialise after many calls. Haiku is already ~8× cheaper than Sonnet uncached; that's the iteration economics we keep. Use Sonnet for sessions where caching matters (eval runs, demos). |
| **Process crashed mid-call; row stuck in `in_progress`** | Expected — the 3-state lifecycle survives this | The startup sweep at `ReviewsService.onModuleInit()` finalises any `in_progress` row older than 5 minutes as `failed/process_terminated` on the next boot. |

---

## 9. Current limitations of the dry-run surface

- **Post comments back to GitHub.** The dry-run only persists findings locally — it does not post a Review to the PR. That path is covered by the real-PR integration; see [`docs/setup/real-pr-smoke.md`](real-pr-smoke.md).
- **Webhook-triggered reviews.** The dry-run surface is manual-only. The webhook handler drives reviews automatically once the real-PR integration is configured.
- **Authentication on `POST /reviews/dry-run`.** The endpoint is rate-limited and gated by `ENABLE_DRY_RUN`, not authenticated. Use it for local development only.
- **A cost / token telemetry dashboard.** The `input_tokens`, `output_tokens`, and `cache_*` columns are written on every row and are queryable directly from SQLite; a web UI for them is not yet shipped.

See [`docs/plans/04-day3-claude-integration.md`](../plans/04-day3-claude-integration.md) → "Scope Boundaries" for the full deferred-work list.

---

## 10. Function definition lookup — known limitations

The agent exposes a `fetch_function_definition` tool to
locate a function or method by name. The implementation
(`apps/api/src/infrastructure/repo-context/helpers/grep-function-definition.ts`)
is a **grep heuristic**, not an AST parser. It matches three line
shapes against the source:

1. `^\s*(export\s+)?(async\s+)?function\s+<name>\b`
   — top-level `function` declarations, optionally `export`ed and
   optionally `async`.
2. `^\s*(export\s+)?(const|let|var)\s+<name>\s*=`
   — arrow / function-expression assignments, optionally `export`ed.
3. `^\s+<name>\s*\(` inside a `class\s+` block
   — class methods. Tracked via brace-counting on lines that opened
   a `class X { ... }` scope.

The first matching line wins. On a hit, the helper returns up to 10
lines of context on each side (≤ 21 lines total).

### Known limitations

The agent's output stays truthful about what it found — it never invents content — but the heuristic can miss or pick a non-canonical definition in these cases:

- **TypeScript overloads.** When a function has multiple signature
  declarations followed by an implementation:
  ```ts
  function chargeCard(order: Order): Result;
  function chargeCard(order: Order, opts: Opts): Result;
  function chargeCard(order: Order, opts?: Opts): Result { /* impl */ }
  ```
  The heuristic returns the first matched line, which is the first
  overload declaration — not the implementation. The agent then
  reasons about the wrong signature.

- **Decorated methods.** A decorator line precedes the method
  declaration:
  ```ts
  class C {
    @Cached()
    chargeCard(order) { ... }
  }
  ```
  The class-method pattern matches the `chargeCard(` line itself,
  and the 10-line context window captures the decorator above it.
  But pathological setups where the decorator changes the function's
  semantics (e.g., `@Method('GET')` for an RPC, or
  `@Deprecated(' use Y ')` marking the method as removed) won't be
  flagged by the heuristic — only by the agent reading the returned
  context carefully.

- **Default-exported function expressions.** A function with no name
  at the definition site:
  ```ts
  export default function (order) { ... }
  ```
  Has nothing for the heuristic to match against. The agent calling
  `fetch_function_definition('whatever')` against such a file gets
  `{ ok: false, reason: 'not_found' }`. (The same applies to
  `export default (order) => ...`.)

- **Methods of the same name across multiple classes.** If two
  classes in the same file each define a `process()` method, the
  heuristic returns the FIRST match (top of file). The agent's
  message could end up describing the wrong class's implementation.
  The
  `apps/api/test/infrastructure/repo-context/helpers/grep-function-definition.spec.ts`
  spec pins this behavior with a dedicated case so the regression
  surface is explicit.

- **Module-level identifiers re-exported under a different name.**
  ```ts
  function _chargeCardImpl(order) { ... }
  export { _chargeCardImpl as chargeCard };
  ```
  The agent calling `fetch_function_definition('chargeCard')`
  finds nothing — the heuristic doesn't track export aliases.

### Why a heuristic, not a parser

A real parser (tree-sitter, ts-morph, the TypeScript compiler) would
close every gap above. The heuristic ships instead because:

- The value is in the multi-turn behavior, not function-lookup
  precision. A non-canonical match still lets the agent reason about
  the surrounding code.
- Tree-sitter adds a native dependency and a per-language grammar
  selection step (current fixtures are JS-only; the project will add
  Python / Ruby / Go later).
- ts-morph parses the full TypeScript program — which means the
  agent's per-tool latency would grow with codebase size in a way
  the dry-run iteration loop wouldn't tolerate.

A tree-sitter or ts-morph upgrade is a candidate future improvement
once the eval harness surfaces the gap as a real false-negative cause.
Until then, the agent's `message` field is the right place to caveat
any ambiguity (it can say "matched the first of two `process`
definitions in this file"); the heuristic itself stays simple.
