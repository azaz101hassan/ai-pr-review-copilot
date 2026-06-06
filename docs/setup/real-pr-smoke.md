# Real-PR integration setup

This walks you through wiring the real-PR loop end-to-end: Redis comes up via docker-compose, the GitHub App starts authenticating Octokit clients per installation, an allowlist gates which repos the bot actually reviews, and a single body-only Review posts back to each PR after the agent loop runs. Target: a real PR triggering a posted Review in **about 20 minutes** on top of an already-working baseline install.

> **Prerequisites:** The webhook receiver + GitHub App, Chroma + seeded corpus, Anthropic key + spend cap, and the multi-turn agent loop are all configured. If `npm run review:dry-run` and the webhook delivery flow both work, you're in the right place.

---

## 1. Bring Redis up locally

The review queue is BullMQ on top of Redis. We run it via docker-compose.

### 1.1 Set REDIS_PASSWORD in your host environment

The compose file refuses to start without it (we don't ship a default — passwordless Redis would let any process on your machine read job payloads):

```bash
# Pick anything non-trivial. Keep this same value when you fill REDIS_URL below.
export REDIS_PASSWORD=$(openssl rand -hex 16)
```

If you want this to survive shell restarts, add the export to `apps/api/.env` (the docker-compose CLI reads from there too via `--env-file`) or your `~/.zshrc`.

### 1.2 Start the redis service

```bash
docker compose --env-file apps/api/.env up -d redis
docker compose --env-file apps/api/.env ps     # both chroma and redis should be "running (healthy)"
```

Smoke-test:

```bash
docker exec -it pr-copilot-redis redis-cli ping
# PONG
```

The container binds to `127.0.0.1:6379` only — not all interfaces. If you need to expose it for a multi-machine deploy, switch to `rediss://` (the ConfigService validator accepts both schemes; loopback-only enforcement lives in this docs page).

> Data persists across `docker compose down` — the `redis-data` named volume in compose holds it. Use `docker compose down -v` to wipe and start fresh.

---

## 2. Fill in the environment variables

Open `apps/api/.env` and add the new vars below the existing block. Every one is **required at boot** — the API will refuse to start otherwise.

```bash
# ── Real-PR integration ───────────────────────────────────────────────────

# GitHub App ID — numeric, from your App's Settings → "General".
APP_ID=123456

# GitHub App PEM private key. Convert the multi-line file into a single
# .env line by replacing each newline with the literal two characters \n:
#   awk 'NR>1{printf "\\n"} {printf "%s", $0}' /path/to/private-key.pem
# Resulting one-liner goes here:
APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----

# Redis URL — REDIS_PASSWORD from step 1.1 included inline.
REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:6379

# Allowlist of repos the bot will actually review. Empty = silent (kill switch).
# Format: comma-separated owner/repo, e.g.
#   DOGFOOD_REPOS=azaz101hassan/ai-pr-review-copilot,my-org/my-fork
DOGFOOD_REPOS=

# Optional. Defaults below match production-safe behavior.
ANTHROPIC_USE_ZERO_RETENTION=true   # enroll in Anthropic's zero-retention mode
WORKER_CONCURRENCY=1                # one job at a time (per-PR serial via jobId)
SHUTDOWN_DRAIN_TIMEOUT_MS=25000     # SIGTERM grace before failing in-flight rows
MAX_DIFF_BYTES=262144               # 256 KB diff cap (above this → diff_too_large)
```

A copy with placeholder values lives in `apps/api/.env.example`. The `ConfigService` constructor validates each at boot and exits with a message naming the offending var on misconfig — no silent fallbacks.

---

## 3. Install the App on the demo target

The App needs to be installed on **two** kinds of target:

1. **An OSS fork you control** — for the recorded demo. Pick a small JS/TS repo with clear coding standards (a CLI utility, a TodoMVC clone, a docs example) and fork it into your personal account. Push 1-2 branches with planted violations matching the seeded rules in [`docs/setup/embeddings.md`](embeddings.md). This is the path the on-camera demo records.
2. **The `ai-pr-review-copilot` repo itself** — for ongoing self-review. Real PRs that the team opens on this repo get reviewed automatically.

For each:

1. Go to your App's settings → **Install App** → pick the account that owns the repo.
2. **Only select the specific repository / repositories** the App should access. Don't pick "All repositories" unless you're ready for the App to review every PR you ever open under that account.
3. After installing, add the repo's `owner/repo` token to `DOGFOOD_REPOS`. The allowlist is the kill switch — installations on repos NOT in the allowlist get gracefully ignored at the webhook (`ignored-repo` status, audit row still persists).

### Minimum App permissions

Re-check your App's permissions (Settings → **Permissions & events**). The real-PR integration requires:

| Permission | Access |
|---|---|
| **Pull requests** | Read & write |
| **Checks** | Read & write |
| **Contents** | Read |
| **Metadata** | Read |

Subscribed events: `Pull request`. (No `Push`, no `Issues`, no `Workflow run` — keep the surface narrow.)

The **Checks** permission powers the merge-box check-run lifecycle (in-progress → terminal). Installs missing it degrade gracefully — the walkthrough comment still posts — but the merge box won't show a per-review status badge.

If the permission set was wider during initial setup, narrow it now. GitHub will email installers asking them to re-accept the new permissions; for personal/test installs you can re-accept immediately.

### Merge-box "Details" link — set the Homepage URL with care

When the bot posts a check-run, GitHub renders a **Details** link on the right of the merge-box row. That link is **not** controlled by the bot — it resolves to the `external_url` GitHub attaches to every check-run, which in turn defaults to the App's **Homepage URL** (App Settings → **General** → Homepage URL).

The default-template Homepage URL is often `http://localhost:3001` (or whatever placeholder the App was created with). Left as-is, every reviewer who clicks **Details** lands on a broken page.

Options:

- **Blank it.** Clear the Homepage URL in App settings. GitHub then omits the `external_url`, and the check-run renders without a clickable **Details** link. This is the safest default for personal / demo installs.
- **Point it at a real landing page.** Set it to your team's docs or a status page once one exists.

Verify after editing: open a fresh PR, click **Details** on the bot's check-run, confirm the destination matches your intent. There is no API call or restart needed — GitHub reads the App's Homepage URL on every check-run render.

---

## 4. PEM rotation procedure

The PEM is the single secret that lets your App authenticate. If you suspect it's leaked (committed by mistake, shared in a screenshot, employee left), rotate immediately:

1. App Settings → **Private keys** → **Generate a private key**. A new `.pem` downloads.
2. Convert the new PEM to the `\n`-escaped one-liner (see the awk snippet in step 2).
3. Replace `APP_PRIVATE_KEY` in `apps/api/.env`.
4. Restart `apps/api`. The startup log should show `GitHubAppService] GitHub App probe OK — installed as "<your-app-slug>"`. **Any other line means the key didn't authenticate** — don't proceed.
5. Once you've confirmed the new key works, go back to App Settings → **Private keys** → click the **Delete** button on the OLD key. Both keys work simultaneously between steps 2 and 5; the window is intentionally narrow.

> The in-process Octokit cache holds one client per installation for the process lifetime. After a rotation, the API restart in step 4 invalidates the whole cache. There is no separate cache-eviction call — a hot rotation without a restart is not currently supported.

---

## 5. DOGFOOD_REPOS allowlist semantics

The allowlist is the bot's primary safety control. It's intentionally simple:

| Value | Behavior |
|---|---|
| Empty / unset | Bot is silent on every PR. `ignored-repo` audit row stored, no enqueue. Use this as the **kill switch**: when something's wrong, flip to empty and restart. |
| `owner/repo` | That single repo gets reviewed. |
| `owner1/repo1,owner2/repo2` | Comma-separated, no spaces inside tokens. |

`repo_full_name` is matched exactly. `azaz101hassan/ai-pr-review-copilot` is not the same as `azaz101hassan/AI-PR-REVIEW-COPILOT` (GitHub is case-insensitive on owner/repo, but our matcher is case-sensitive — keep the case identical to the GitHub URL).

To rotate the allowlist:

```bash
# Edit apps/api/.env, then restart the API process so it re-reads
# DOGFOOD_REPOS. The allowlist lives in the API's env, NOT in Redis —
# restarting Redis won't pick up the new value.
# Stop the running `npm run start:dev` and re-run it in apps/api.
```

The boot log records the parsed allowlist as part of `ReviewsModule`'s init.

---

## 6. ANTHROPIC_USE_ZERO_RETENTION

This is an opt-in to Anthropic's **zero-data-retention** mode — when `true`, Anthropic doesn't retain prompt/response data after the API call completes.

Recommendation: **`true` for production / dogfood paths**. The diff being reviewed is your code, plus team rules from your knowledge base; you almost certainly don't want it sitting in another vendor's data lake.

The flag is read at boot. Re-deploying after a flip requires a process restart. There's no per-call override.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot log says `Redis ping failed for queue "reviews"` | `REDIS_URL` points at a host that isn't running Redis, or the password is wrong | `docker compose --env-file apps/api/.env ps` to confirm `redis` is healthy; verify `REDIS_PASSWORD` in `.env` matches the one inside `REDIS_URL`. |
| Boot log says `GitHub App probe failed: 401` | `APP_ID` and `APP_PRIVATE_KEY` don't match a real App, or the PEM was corrupted during the `\n` escape | Re-download the PEM from your App settings and re-run the escape conversion in step 2. |
| Boot log says `APP_PRIVATE_KEY does not look like a PEM private key` | The env value is missing the `-----BEGIN` header — usually means the `\n` escape was eaten by your shell | Double-check the `.env` value: it should start with the literal characters `-----BEGIN`. The escape sequences should be `\n` (two chars), not real newlines. |
| Webhook returns 200 / `ignored-repo` for every PR | Repo is not in `DOGFOOD_REPOS` | Add `owner/repo` to the env var and restart. |
| Webhook returns 200 / `ignored-draft` | The PR is marked as draft on GitHub | Convert to "Ready for review" on the PR — the next `synchronize` triggers the review. |
| Webhook returns 5xx | The enqueue path failed (Redis dropped, BullMQ Lua error) | Check the API log for the underlying error. GitHub will redeliver automatically. |
| PR triggered the worker but no Review appeared, and the row is `failed/diff_too_large` | The PR's diff exceeds `MAX_DIFF_BYTES` (default 256 KB) | Raise the cap in `.env` and restart, or split the PR. 256 KB is intentionally conservative — see the implementation plan's Open Questions for the trade-off. |
| Row is `failed/pr_closed_during_review` | The PR was closed or merged between the webhook delivery and the worker picking up the job | Expected behaviour. Re-open the PR if you want it re-reviewed. |
| Row is `failed/github_api_error` with status 401 | The PEM rotated mid-process and the cached Octokit holds an expired token | Restart the API to invalidate the cache. Proactive token-rotation handling is planned for a future release. |
| Row is `failed/comment_post_failed` | The PR Review POST failed (5xx from GitHub, timeout). Findings are still in the DB. | Push an empty commit (`git commit --allow-empty -m 'retry review' && git push`) — the `synchronize` event triggers a fresh run. This is the intentional fail-fast-no-retry trade-off. |
| Row is `failed/process_terminated` | The API was SIGKILL'd or the bounded drain timed out while this row was in-flight | The boot sweep marked it failed. Re-trigger via a `synchronize` if you want a fresh attempt. |
| Worker logs show `worker.shutdown.drain_timeout` on every SIGTERM | The shutdown drain (default 25 s) isn't long enough for the in-flight review to complete | Raise `SHUTDOWN_DRAIN_TIMEOUT_MS` in `.env`. Don't go above your deployment's SIGTERM grace window (Docker default 10 min, k8s `terminationGracePeriodSeconds` default 30 s). |
| `npm run dev:api` and Redis both start, but the Review never posts | Check `worker.job.dequeued` / `worker.review.started` / `worker.review.posted` log lines — find the missing one | Each log line corresponds to a step in the processor lifecycle. Whichever line is missing tells you which step failed. |

---

## 8. Current limitations

- **Inline comments on specific lines of the diff.** This integration ships body-only Reviews — one Review per completed run, all findings under a single self-identifying header. Inline comments with `(path, line)` locations are a planned future format.
- **PAT auth mode.** Only App-installation auth is supported. The `IGithubAuthProvider` seam stays interface-stable so a `PersonalAccessTokenAuthProvider` impl can land without renegotiating consumers.
- **Visible failure signals on the PR.** When a review fails (any `failed` error_code), nothing surfaces on the PR itself. Operators watch the worker log and the `reviews` table.
- **`@bot` slash commands.** No `/pause`, `/re-review`, `/dismiss`. Manual control is via App install/uninstall or the `DOGFOOD_REPOS` env flip.
- **Cross-PR or cross-repo dedup.** The bot doesn't notice that two different PRs touch the same file with the same violation.
- **Operator notification on `credit_balance_too_low`.** The classifier emits this error code but does not surface it proactively — operators must check the `reviews` table.

See [`docs/plans/06-day5-real-pr-integration.md`](../plans/06-day5-real-pr-integration.md) → "Deferred to Follow-Up Work" for the full deferred-work list.

---

## 9. Daily — observing a live run

When a webhook delivery comes in for an allowlisted, non-draft PR, you'll see this log sequence:

```
[WebhookService] pull_request.synchronize #42 stored (azaz101hassan/ai-pr-review-copilot)
[BullMQReviewQueue] enqueue: added jobId=PR_xyz... head_sha=abc...
[ReviewsProcessor] [job=42 pr=PR_xyz...] worker.job.dequeued head_sha=abc...
[ReviewsProcessor] [job=42 pr=PR_xyz...] worker.review.started
[ReviewsProcessor] [job=42 pr=PR_xyz...] worker.review.findings_emitted count=3 review_id=...
[ReviewsProcessor] [job=42 pr=PR_xyz...] worker.review.posted url=https://github.com/.../pull/42#pullrequestreview-...
```

Then open the PR in your browser. The Review shows up with the self-identifying header `**🤖 AI PR Review Copilot** — automated review` plus the listed findings.

Inspect the persisted row:

```bash
sqlite3 apps/api/data/app.sqlite \
  'SELECT id, status, error_code, turn_count, input_tokens, output_tokens FROM reviews ORDER BY created_at DESC LIMIT 5;'
```

For the self-review install on `ai-pr-review-copilot` itself, this is how you keep tabs on the bot's behavior between PRs. If `error_code` distribution skews away from `NULL` (success), or `turn_count` clusters at the cap (6), that's a signal to tune.
