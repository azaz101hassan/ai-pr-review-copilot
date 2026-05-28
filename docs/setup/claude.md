# Claude integration setup — Anthropic SDK + structured findings

This walks you through standing up the Day-3 review loop locally: an Anthropic API key with a workspace spend cap, a `.env` knob for the model, and the new `npm run review:dry-run` CLI plus `POST /reviews/dry-run` HTTP endpoint. Target: a working end-to-end dry-run that prints findings on a violation diff in **about 15 minutes** on a fresh clone.

> **Prerequisite:** Day 1 (webhook receiver) and Day 2 (Chroma + Voyage + seeded corpus) are already shipped on `main`. If you haven't run [`docs/setup/embeddings.md`](embeddings.md), do that first — Day 3 *retrieves* the rules Day 2 seeded.

---

## 1. Sign up for Anthropic and create an API key

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account.
2. Open **Settings → API Keys** → **Create Key**. Copy it immediately — it's only shown once.

> The key looks like `sk-ant-api03-XXXXXXXXXXX...`. It is **not** the same as the Voyage key — Anthropic and Voyage are separate billing relationships even though Anthropic owns Voyage.

---

## 2. **Required: set a workspace spend cap**

Anthropic supports a hard monthly cap. **Do this before running anything that calls the API** — it is the dollar backstop if a runaway loop or misconfigured key somehow gets out.

1. **Settings → Limits** → **Monthly spending limit**.
2. Set it to something small enough that you'd notice the alert but large enough to cover the sprint. **Suggested: $10–$25** for the Day-3 → Day-10 sprint.
3. Confirm.

Each `runDryRun` call is approximately **1–5¢** depending on cache state (cold Sonnet ~$0.04–$0.10; warm cache halves it; Haiku is ~8× cheaper across the board). The local 30 req/min/IP throttler caps per-IP burn rate; this spend cap is the dollar-amount backstop on top.

If your usage approaches **$5** during Day-3 dev work, that's already unusual — audit the iteration loop before continuing.

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

**Why:** before Day 5 ships auth, the endpoint is unauthenticated. Gating it on `ENABLE_DRY_RUN=false` outside dev forecloses the accidental-deploy-to-prod denial-of-wallet path. The CLI (`npm run review:dry-run`) is unaffected — it's process-local, no HTTP.

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
curl -sS http://localhost:3001/reviews/dry-run \
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
  "prompt_version": "v1"
}
```

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
| **`AnalyzeDiffResult` findings empty when violations are obvious** | Retrieval didn't surface the expected rule in top-K | Run `npm run query:rules --workspace apps/api -- <path>` to see what's actually retrieved. If the rule isn't in the top-K, the embeddings layer (Day 2) is the problem, not Claude. |
| **`Resolved model: claude-haiku-...` when you expected Sonnet** (or vice versa) | NODE_ENV mismatch | Verify `NODE_ENV` in the shell that booted `npm run dev:api`. Set `ANTHROPIC_MODEL` explicitly in `.env` if you want to lock the choice. |
| **Cost surprise** — `[review:dry-run] estimated cost` exceeds a couple cents per call | Cache miss (every call), or accidentally on Opus/Sonnet during iteration | Check the resolved-model line. If it's Sonnet/Opus and you're iterating, switch to Haiku. If cache_read tokens stay at 0 across calls, the system prompt likely drifted — `git diff apps/api/src/infrastructure/anthropic/anthropic-llm-reviewer.ts`. |
| **`cache(read/write)=0/0` every call** on Haiku | Haiku's prompt-cache minimum is higher than Sonnet's (~2048 vs ~1024 tokens). Our cacheable prefix (~1280 tokens) clears Sonnet but not Haiku. | Expected and intentional — padding the prompt further to clear Haiku's threshold would make every Haiku call more expensive (bigger prompt) for caching benefits that only materialise after many calls. Haiku is already ~8× cheaper than Sonnet uncached; that's the iteration economics we keep. Use Sonnet for sessions where caching matters (Day-6 eval, demos). |
| **Process crashed mid-call; row stuck in `in_progress`** | Expected — the 3-state lifecycle survives this | The startup sweep at `ReviewsService.onModuleInit()` finalises any `in_progress` row older than 5 minutes as `failed/process_terminated` on the next boot. |

---

## 9. What Day 3 does *not* yet do

- **Post comments back to GitHub.** Day 5 wires Octokit and the `pr_node_id` column. Day 3 only persists findings.
- **Multi-turn agent loop.** Day 4 introduces the agentic loop (Claude can request additional context, call sub-tools, iterate). Day 3 is single-turn forced-tool-call.
- **Webhook-triggered reviews.** Day 4 / Day 5 extend the webhook handler so `opened` / `synchronize` events drive `runDryRun()` automatically. Day 3's surface is dry-run only.
- **Authentication on `POST /reviews/dry-run`.** Day 5 introduces a unified auth strategy. Today, the endpoint is rate-limited + gated by `ENABLE_DRY_RUN`, not authenticated.
- **A cost / token telemetry dashboard.** Day 8 reads the `input_tokens`, `output_tokens`, `cache_*` columns we now write on every row.

See [`docs/plans/04-day3-claude-integration.md`](../plans/04-day3-claude-integration.md) → "Scope Boundaries" for the full deferred-work list.
