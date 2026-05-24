# GitHub App + ngrok setup

This walks you through registering a GitHub App so it can deliver pull-request webhooks to `apps/api` running locally. Target: working webhook delivery in **about 15 minutes**.

> **Why a GitHub App rather than a repo webhook?** Day 5 of the sprint will post review comments back to the PR. That requires an authentication identity GitHub trusts — a GitHub App with `pull_requests: write` permission. We register the App on Day 1 so the auth surface is in place when Day 5 starts.

---

## Prerequisites

- A GitHub account.
- A test repository (public or private) you can open a PR against. A fork of any small public repo works.
- [ngrok](https://ngrok.com/download) installed locally and authenticated (`ngrok config add-authtoken <your token>` — the free tier is enough for Day 1).
- This repo cloned and `npm install`'d.

---

## 1. Generate a webhook secret locally

```bash
openssl rand -hex 32
```

Copy the output. You'll paste it into two places: the GitHub App's settings (step 4) and `apps/api/.env` (step 6).

---

## 2. Start ngrok pointed at apps/api

```bash
ngrok http 3001
```

Leave it running. You'll see a forwarding URL like `https://ab12-203-0-113-4.ngrok-free.app` — copy the HTTPS one. The webhook endpoint you'll configure in step 4 is **that URL + `/webhooks/github`**.

> ngrok free-tier URLs change on every restart. If you stop and restart ngrok, you'll need to update the GitHub App's webhook URL.

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
| **Webhook URL** | `<your ngrok HTTPS URL>/webhooks/github` |
| **Webhook secret** | The hex string from step 1. Paste it exactly. |
| **Callback URL** | Leave blank for Day 1 (no OAuth flow yet). |
| **Setup URL** | Leave blank. |

### Repository permissions

Set:

| Permission | Access |
|---|---|
| **Pull requests** | Read & write |
| **Contents** | Read-only |
| **Metadata** | Read-only (this one is mandatory and auto-checked) |

Pull-requests "write" is required for Day 5 (posting review comments). Contents "read" will be required when Day 2 fetches the diff via Octokit.

### Subscribe to events

Check:

- ✓ **Pull request**

That's the only event Day 1 cares about. You can add more later (e.g., `Pull request review` if you want to react to human reviews).

### Where can this GitHub App be installed?

- ✓ **Only on this account** for Day 1. Flip to "Any account" later if you want others to install it.

Click **Create GitHub App** at the bottom.

---

## 5. Save the App's identity (for Day 2)

After creation, GitHub takes you to the App's settings page. Note these — you'll need them on Day 2:

- **App ID** — at the top of the page.
- **Client ID** — in "About" section.
- **Private key** — scroll to "Private keys" → "Generate a private key" → save the downloaded `.pem` file somewhere safe (e.g., `~/.config/ai-pr-review-copilot/app.pem`). **Never commit this file.**

Day 1 doesn't use the private key, but you'll thank yourself for grabbing it now.

---

## 6. Configure apps/api with the same secret

```bash
cp .env.example apps/api/.env
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
apps/api listening on http://localhost:3001
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
2. The ngrok URL is still the same as what you put in the App's webhook URL (ngrok URLs change on restart).
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

Day 1 ends here. Day 2 picks up by:

1. Adding Octokit auth-as-app (using the private key from step 5).
2. Fetching the actual unified diff for each `pull_request.opened` / `synchronize` event.
3. Standing up Chroma + an embedding pipeline so the diff can be matched against the knowledge base.

See [`docs/plans/01-baseline.md`](../plans/01-baseline.md) for the full sprint.
