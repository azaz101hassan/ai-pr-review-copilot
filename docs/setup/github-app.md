# GitHub App + tunnel setup

This walks you through registering a GitHub App so it can deliver pull-request webhooks to `apps/api` running locally. The "tunnel" is whatever tool exposes `localhost:4001` to the public internet so GitHub can reach it — this guide supports either [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or [ngrok](https://ngrok.com/download). Target: working webhook delivery in **about 15 minutes**.

> **Why a GitHub App rather than a repo webhook?** Posting review comments back to the PR requires an authentication identity GitHub trusts — a GitHub App with `pull_requests: write` permission. Registering the App upfront means the auth surface is ready when the real-PR integration is wired.

---

## Prerequisites

- A GitHub account.
- A test repository (public or private) you can open a PR against. A fork of any small public repo works.
- A public-URL tunnel for `apps/api` (step 2 lists two options — pick one):
  - [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) — quickest start, no account required for `trycloudflare.com` URLs.
  - [ngrok](https://ngrok.com/download) — requires `ngrok config add-authtoken <your token>` once; free tier is sufficient.
- This repo cloned and `npm install`'d.

---

## 1. Generate a webhook secret locally

```bash
openssl rand -hex 32
```

Copy the output. You'll paste it into two places: the GitHub App's settings (step 4) and `apps/api/.env` (step 6).

---

## 2. Tunnel apps/api to a public URL

GitHub delivers webhooks over HTTPS to a public hostname. `apps/api` listens on `localhost:4001`, so it needs a tunnel. Pick one of the two options below.

### Option A — cloudflared (quickest start)

```bash
cloudflared tunnel --url http://localhost:4001
```

Leave it running. The first lines of output include a forwarding URL like `https://jail-encyclopedia-election-vacuum.trycloudflare.com` — copy that HTTPS URL. No Cloudflare account is required for these ephemeral `trycloudflare.com` URLs.

### Option B — ngrok

```bash
ngrok http 4001
```

Leave it running. The dashboard shows a forwarding URL like `https://ab12-203-0-113-4.ngrok-free.app` — copy the HTTPS one.

### Both options

The webhook endpoint you'll configure in step 4 is **that URL + `/webhooks/github`**.

> Free-tier tunnel URLs (both cloudflared `trycloudflare.com` and ngrok) change on every restart. Either restart the tunnel and update the GitHub App's webhook URL whenever the URL rotates, or upgrade to a stable named tunnel / paid plan on whichever service you picked.

---

## 3. Open the GitHub App creation form

Go to [github.com/settings/apps/new](https://github.com/settings/apps/new) (this creates a personal App on your account; for org-owned Apps the URL is `github.com/organizations/<org>/settings/apps/new`).

---

## 4. Fill in the form

| Field | Value |
|---|---|
| **GitHub App name** | Any unique name, e.g. `ai-pr-review-copilot-<your-username>-dev`. The "-dev" suffix lets you create a separate prod App later without name collisions. |
| **Homepage URL** | `https://github.com/<your-username>/ai-pr-review-copilot` (or any URL — it just has to be valid). |
| **Webhook → Active** | ✓ checked |
| **Webhook URL** | `<your tunnel HTTPS URL>/webhooks/github` (the cloudflared or ngrok URL from step 2) |
| **Webhook secret** | The hex string from step 1. Paste it exactly. |
| **Callback URL** | Leave blank (no OAuth flow needed for webhook-only mode). |
| **Setup URL** | Leave blank. |

### Repository permissions

Set:

| Permission | Access |
|---|---|
| **Pull requests** | Read & write |
| **Contents** | Read-only |
| **Metadata** | Read-only (this one is mandatory and auto-checked) |

Pull-requests "write" is required for posting review comments. Contents "read" is required when the worker fetches the diff via Octokit.

### Subscribe to events

Check:

- ✓ **Pull request**

That's the only event the webhook receiver handles. You can add more later (e.g., `Pull request review` if you want to react to human reviews).

### Where can this GitHub App be installed?

- ✓ **Only on this account** to start. Flip to "Any account" later if you want others to install it.

Click **Create GitHub App** at the bottom.

---

## 5. Save the App's identity

After creation, GitHub takes you to the App's settings page. Note these — you'll need them for subsequent setup steps:

- **App ID** — at the top of the page.
- **Client ID** — in "About" section.
- **Private key** — scroll to "Private keys" → "Generate a private key" → save the downloaded `.pem` file somewhere safe (e.g., `~/.config/ai-pr-review-copilot/app.pem`). **Never commit this file.**

The webhook-only setup doesn't use the private key immediately, but you'll need it for the real-PR integration step.

---

## 6. Configure apps/api with the same secret

```bash
cp apps/api/.env.example apps/api/.env
```

Open `apps/api/.env` and paste the hex string from step 1 into `GITHUB_WEBHOOK_SECRET=`. The two values **must match exactly**; a mismatch shows up as 401 in GitHub's "Recent Deliveries" tab.

---

## 7. Install the App on a test repo

In the App's settings, click **Install App** in the left sidebar → choose the account → select either "All repositories" or a specific test repo. Click **Install**.

---

## 8. Boot apps/api and open a test PR

```bash
npm run dev:api
```

You should see:

```
apps/api listening on http://localhost:4001
[Nest] DatabaseService SQLite ready at /…/data/app.sqlite
```

Now open or update a PR on the test repo. Within a second or two you should see the API log a `pull_request.opened` (or `synchronize`) and store the row.

---

## 9. Verify with the "Recent Deliveries" tab

In the App's settings → **Advanced** → **Recent Deliveries**. Each delivery shows:

- Status code (200 = stored, 401 = signature mismatch, 400 = missing header).
- Request headers + payload (full JSON).
- A **Redeliver** button — invaluable for testing without making fresh PRs.

If you see 401s, check:

1. The webhook secret in step 1 matches `apps/api/.env` exactly (no trailing newline).
2. The tunnel URL is still the same as what you put in the App's webhook URL (free-tier cloudflared and ngrok URLs change on restart).
3. `apps/api` is actually running (not crashed).

---

## 10. Sanity-check the database

```bash
sqlite3 apps/api/data/app.sqlite '.schema'
sqlite3 apps/api/data/app.sqlite 'SELECT delivery_id, event_name, action, pull_request_node_id FROM webhook_events ORDER BY received_at DESC LIMIT 5;'
```

You should see your recent deliveries.

---

## What's next

This completes the GitHub App registration and webhook receiver setup. The remaining setup steps build on this App install:

1. **Embeddings pipeline** — Chroma + Voyage so diffs can be matched against the seeded rule corpus. See [`docs/setup/embeddings.md`](embeddings.md).
2. **Claude integration** — the Anthropic SDK so retrieved rules drive the review. See [`docs/setup/claude.md`](claude.md).
3. **Multi-turn agent loop** — fetches repo context across multiple turns before emitting findings (covered in the Claude integration setup).
4. **Real-PR integration** — activates this App's webhook delivery: the private key from step 5 now mints installation-scoped Octokit clients, the worker fetches the unified diff for each `pull_request.opened` / `synchronize` event, runs the agent loop, and POSTs a body-only Review back to the PR. Full setup: [`docs/setup/real-pr-smoke.md`](real-pr-smoke.md).

See [`docs/plans/01-baseline.md`](../plans/01-baseline.md) for the overall project plan.
