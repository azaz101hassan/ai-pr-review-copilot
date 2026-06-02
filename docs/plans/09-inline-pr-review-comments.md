# 09 — Inline PR Review Comments

**Status:** Design — ready for implementation plan
**Pulled forward from:** Day 10 polish slot (see `01-baseline.md` deferred-enhancements)
**Date:** 2026-06-02

---

## Summary

Today the bot posts a single concatenated summary comment per review.
Switch to **inline per-line review comments**: every finding anchored
to its `file:line` becomes its own GitHub review thread, with a
separate top-level **Walkthrough** issue comment that holds counts
and any findings whose anchor falls outside the diff.

Prior art (CodeRabbit, GitHub Copilot code review) confirms the
two-object pattern — an editable Walkthrough issue comment plus an
inlined Review — as the format reviewers expect. Mapping our existing
freeform `location_hint` to GitHub's positional API is the only new
piece of mechanics; the rest is composition of helpers and a small
posting reorganization in the worker.

---

## Motivation

On multi-finding PRs today's single comment becomes a long scroll and
the reader can't tell which file/line each point addresses. Real
reviewers (human and bot) leave inline threads. The bot has had
file+line information available since Day 4 (`location_hint` on
`Finding`); it just hasn't been used at the posting boundary.

---

## Out of scope (v1)

- Bumping `PROMPT_AND_TOOL_VERSION` — keeps the Day-6 eval recordings
  reproducible. Anchor parsing happens server-side against the
  existing v3 freeform `location_hint`.
- `` ```suggestion `` blocks. Claude does not emit fix patches today;
  adding this would require a separate prompt/tool change.
- API-side dedup across re-reviews. Both leading bots rely on
  GitHub's native "Outdated" badge for stale inline threads; we
  match that behavior.
- Auto-resolve/dismiss of stale inline threads via the API.
- Soft re-anchoring of findings whose anchor falls outside the diff
  (e.g., to the nearest changed line). Outside-diff findings stay
  intact in the Walkthrough body section.

---

## Architecture

Two timeline objects per review run.

### 1. Walkthrough (issue comment)

A single regular issue comment per PR over its lifetime, **edited in
place** on every subsequent review run.

- Self-identified via a literal HTML-comment marker on line 1:
  ```
  <!-- ai-pr-review-copilot:walkthrough:v1:pr=<pr_node_id> -->
  ```
- Carries: the existing review header, counts breakdown (errors /
  warnings / info), a UUID-validated pointer marker for the current
  Review row, and (when non-empty) a collapsible `<details>` section
  listing findings whose `location_hint` did not map to the diff.
- The comment id is cached on `pull_requests.walkthrough_comment_id`
  (new nullable column). When the cache is empty, the worker scans
  `GET /repos/.../issues/{pr_number}/comments` for a body that
  starts with the marker and adopts it.

### 2. Inlined Review (`pulls.createReview`)

- `event: 'COMMENT'` (preserved — bot never requests changes or
  approves, same policy as both leading bots).
- `commit_id` omitted (preserved — defaults to PR branch tip,
  eliminating the stale-head-SHA window).
- `body`: slim — header + UUID marker + counts + a "see Walkthrough
  for findings outside this diff" pointer when applicable.
- `comments[]`: one entry per anchorable finding, with `path`,
  `line`, `side: 'RIGHT'`, and optionally `start_line` +
  `start_side: 'RIGHT'` when the parsed anchor is a range.
- Posted fresh on every review run. Stale prior threads age out via
  GitHub's "Outdated" badge.

### Posting order

Walkthrough first, then the inlined Review. **The Walkthrough is the
floor:** if the inlined POST fails, every finding has still reached
the PR via the Walkthrough's counts + outside-diff section. The
opposite order risks the Walkthrough never appearing if the inlined
POST succeeds and the worker then crashes.

---

## Components

The three-tier rule (`modules/` → features, `infrastructure/` →
adapters, `system/` → ops) holds. All new code is additive within
the existing reviews module plus one schema column.

### `modules/reviews/` — feature changes

| File | Status | Role |
|---|---|---|
| `helpers/parse-location-hint.ts` | new | Pure `parseLocationHint(hint: string \| null) → { path, startLine, endLine } \| null`. Tolerant of `"foo.ts"`, `"foo.ts:42"`, `"foo.ts:42-50"`, `"foo.ts:19,26"` (comma list keeps the first line as the anchor; remaining lines surface in the comment body). Returns `null` for null / empty / unparseable input. |
| `helpers/parse-diff-hunks.ts` | new | Pure parser over a unified diff string. Returns `Map<path, Array<{ startLine: number; endLine: number }>>` of RIGHT-side added/modified line ranges. Skips binary-file headers. The worker already fetches the unified diff in step 5 of `reviews.processor.ts`. |
| `helpers/anchor-findings-to-diff.ts` | new | Pure: given parsed anchors + the diff-hunk map, partitions findings into `{ anchorable, outsideDiff }`. A finding is anchorable when its path matches a changed file AND `[startLine, endLine]` intersects an in-hunk line. Range findings that partially overlap clamp `line` to the in-hunk max while keeping `startLine` as-is. |
| `helpers/format-inline-comment.ts` | new | Per-finding markdown: severity emoji prefix (`error → 🛑`, `warning → ⚠️`, `info → 💡`) + title + message + `_Rule:_ {rule_id}` + `_Citation:_` fenced block. Sanitized via the existing `sanitizeFindingMarkdown`. No suggestion blocks in v1. |
| `helpers/format-walkthrough-body.ts` | new | Builds the Walkthrough markdown: HTML marker on line 1, then header, counts table, UUID-validated pointer marker, and (when non-empty) the collapsible `<details><summary>Outside diff range comments (N)</summary>...</details>` section. |
| `helpers/format-review-body.ts` | rewritten — same name | Now emits the slim inlined-Review body: header + UUID marker + counts + a pointer to the Walkthrough when there are outside-diff findings. The per-finding rendering moves to `format-inline-comment.ts`. The exported `FindingWithSeverity` type continues to be the working shape. |
| `helpers/find-walkthrough-comment-id.ts` | new | Given an installation-scoped Octokit + PR identity, returns the `comment_id` of an existing Walkthrough comment by scanning issue comments for one whose body starts with the v1 marker. Used as a recovery path when the cache is empty. |
| `reviews.processor.ts` | modified — steps 9–10 | Step 9 parses and partitions. Step 10 splits into 10a (Walkthrough upsert) and 10b (inlined Review POST). |

### `infrastructure/db/` — schema change

| File | Status | Role |
|---|---|---|
| `schema/pull-requests.ts` | modified | Add `walkthrough_comment_id: integer('walkthrough_comment_id')` — nullable, no default. One Walkthrough per PR over its lifetime. |
| `migrations/0005_<descriptive>.sql` | generated | `drizzle-kit generate --name=add_walkthrough_comment_id_to_pull_requests` from `apps/api`. |
| `repositories/sqlite-pull-requests.repository.ts` | modified | New methods: `setWalkthroughCommentId(prNodeId: string, id: number \| null): void` and `getWalkthroughCommentId(prNodeId: string): number \| null`. |
| `types/pull-request.repository.ts` | modified | Interface gains the two methods above. |
| `types/pull-request.types.ts` | unchanged | Picks up the column automatically via `InferSelectModel`. |

No new external dependencies. Octokit already exposes
`issues.createComment`, `issues.updateComment`, `issues.listComments`,
and `pulls.createReview` with a `comments` field.

---

## Data flow (worker, steps 9–10)

Earlier steps (1–8) of `reviews.processor.ts` are unchanged.
Inputs available at step 9: `result.findings`, `diff`, `reviewId`,
`data`, `octokit`.

### Step 9 — parse and partition (pure, deterministic, no I/O)

```
diffHunks = parseDiffHunks(diff)
            // Map<path, Array<{ startLine, endLine }>>  (RIGHT side only)

partitioned = anchorFindingsToDiff({
  findings: sanitizedFindings,
  diffHunks,
})
            // { anchorable: Array<{ finding, path, line, startLine? }>,
            //   outsideDiff: Array<{ finding, parsedAnchor | null }> }

counts = countBySeverity(findings)
            // { error, warning, info, total }
```

A finding lands in `anchorable` when (a) its `location_hint` parses,
(b) the parsed `path` matches a changed file, (c) `[startLine,
endLine]` intersects at least one RIGHT-side hunk line. Otherwise
it lands in `outsideDiff`. Findings with null or unparseable
`location_hint` always go to `outsideDiff`.

For range findings (`path:42-50`) where the range partially overlaps
a hunk, `line` clamps to the in-hunk max while `startLine` keeps the
original — matches CodeRabbit's behavior. For single-line findings
outside any hunk, v1 attempts no soft re-anchor.

### Step 10a — upsert the Walkthrough

```
walkthroughBody = formatWalkthroughBody({
  reviewId, counts, outsideDiff, marker, header,
})

cachedId = pullRequestsRepo.getWalkthroughCommentId(pr_node_id)

if (cachedId) {
  try updateComment({ comment_id: cachedId, body: walkthroughBody })
  catch (404) {
    // Manually deleted. Clear cache; fall through to scan/POST.
    pullRequestsRepo.setWalkthroughCommentId(pr_node_id, null)
    cachedId = null
  }
}

if (!cachedId) {
  scannedId = findWalkthroughCommentId(octokit, owner, repo, pr_number)
  if (scannedId) {
    updateComment({ comment_id: scannedId, body: walkthroughBody })
    pullRequestsRepo.setWalkthroughCommentId(pr_node_id, scannedId)
  } else {
    posted = createComment({ issue_number: pr_number, body: walkthroughBody })
    pullRequestsRepo.setWalkthroughCommentId(pr_node_id, posted.data.id)
  }
}
```

Three paths: fast (cached), recovery (scan + cache), first run
(POST + cache). The scan defends against the cache going stale across
re-deploys or DB resets.

### Step 10b — POST the inlined Review

```
reviewBody = formatReviewBody({
  reviewId, counts, hasOutsideDiff: outsideDiff.length > 0,
})

inlineComments = anchorable.map(a => ({
  path: a.path,
  line: a.line,
  side: 'RIGHT',
  ...(a.startLine && a.startLine !== a.line
    ? { start_line: a.startLine, start_side: 'RIGHT' }
    : {}),
  body: formatInlineCommentBody(a.finding),
}))

octokit.rest.pulls.createReview({
  owner, repo, pull_number, event: 'COMMENT',
  body: reviewBody,
  comments: inlineComments,
  request: { retries: 0 },
})
```

### Zero-findings short-circuit

If `findings.length === 0`, skip step 10b entirely. PATCH the
Walkthrough with a "_No findings — the diff matched no team rules._"
body so the timeline still records that the bot ran.

### Idempotency

- Walkthrough is naturally idempotent — PATCH replaces the body.
- Inlined Review is not idempotent. Each run posts a fresh top-level
  Review with new threads. Stale threads age out via GitHub's
  "Outdated" badge — same behavior as both leading bots.

---

## Error handling

Five failure surfaces. Principle: **the Walkthrough is the floor.**
Every finding reaches the PR via the Walkthrough, even when the
inlined post fails.

### 1. Walkthrough POST/PATCH fails (step 10a)

- Retry once with one-second backoff (transient 5xx common on
  `issues.*` endpoints). Use `request: { retries: 0 }` to keep
  `@octokit/plugin-retry` out of the inner attempts so we control
  retries explicitly.
- On second failure: mark the review row `failed/comment_post_failed`
  (existing `error_code`), record `error_status`, re-throw
  `UnrecoverableError`. Findings stay durable in the DB; the operator
  re-triggers via a synchronize after diagnosis.
- 404 on PATCH is a recovery branch, not a failure: clear the cache,
  fall through to the scan/POST path.

### 2. Inlined Review POST fails (step 10b) with a non-422

- Mark the row `failed/inline_post_failed` (new `error_code`, sibling
  to `comment_post_failed`).
- Re-throw `UnrecoverableError` — per Day-5's F3 closure, no retries
  on a body-altering POST. Findings already on the PR via the
  Walkthrough.
- Do not retract or edit the Walkthrough. Its "see inline comments
  below" pointer becomes slightly inaccurate; acceptable until the
  operator re-triggers.

### 3. Inlined Review POST fails with a 422 — one bad anchor

GitHub rejects the whole call if any one inline's `line` isn't in the
diff. Our `anchorFindingsToDiff` is meant to prevent this.

- No fallback retry in v1. Reaching 422 means our anchor logic has
  a bug; log loudly so it surfaces.
- Mark `failed/inline_post_failed` with `error_status: 422`.
- Preserve Day-5's F5 closure: if the 422 is caused by the PR closing
  mid-flight, reclassify as `pr_closed_during_review`.

### 4. Unparseable `location_hint`

Not an error — a routing decision. The finding goes to `outsideDiff`
and surfaces in the Walkthrough. Log at INFO with
`anchor.unparseable hint=<...> review_id=<...> rule_id=<...>` so the
eval harness can later count this over the corpus.

### 5. The diff parser fails

`parseDiffHunks` is pure code over deterministic input. If it throws
(malformed diff we don't handle), fall back to treating every finding
as outside-diff: the Walkthrough still posts with the full finding
set, and the inlined Review POST is skipped (empty `comments[]` — no
inlines to post). Log at WARN. An empty inline review is a degenerate
success, not a failure.

### Cross-cutting telemetry

One structured log line per run:

```
worker.review.post_summary
  review_id=<uuid>
  walkthrough.posted=<created|patched|skipped>
  inline_review.posted=<true|false>
  anchorable_count=<n>
  outside_diff_count=<n>
  unparseable_count=<n>
```

This is the audit trail for the eval extension noted below. No new
metrics infrastructure for v1.

---

## Testing

Test paths mirror `src/` exactly per project convention.

### Unit specs (pure functions)

| Spec | Coverage |
|---|---|
| `test/modules/reviews/helpers/parse-location-hint.spec.ts` | All four observed shapes (`"foo.ts"`, `"foo.ts:42"`, `"foo.ts:42-50"`, `"foo.ts:19,26"`). Failure cases: empty, null, `"::"`, leading/trailing whitespace, Windows-style `"C:\\foo.ts:42"` (verifies the colon split lands the file portion correctly). |
| `test/modules/reviews/helpers/parse-diff-hunks.spec.ts` | Real unified-diff fixtures (one from `test/fixtures/eval/recordings/` plus a manually crafted multi-file diff). RIGHT-side added/modified ranges, consecutive hunks in one file, binary headers skipped. |
| `test/modules/reviews/helpers/anchor-findings-to-diff.spec.ts` | Matrix: anchor inside hunk → anchorable with same `line`; range partially overlapping → anchorable with clamped `line`; range fully outside → outsideDiff; path not in diff → outsideDiff; null `location_hint` → outsideDiff; comma-list `:19,26` → anchorable at `line=19` with both line numbers reachable to the formatter. |
| `test/modules/reviews/helpers/format-inline-comment.spec.ts` | Each severity (`error`, `warning`, `info`) produces the expected emoji + title + message + citation. Sanitizer injected as a no-op stub per the existing pattern in `format-review-body.spec.ts` (avoids the ESM-only `unified` ecosystem under Jest's CJS runtime). |
| `test/modules/reviews/helpers/format-walkthrough-body.spec.ts` | Marker on line 1; counts table accurate; zero-findings no-findings line; outside-diff section is a collapsible `<details>` and omitted when empty. UUID-regex validation throws on malformed `reviewId` — same shape as the existing `format-review-body` UUID guard. |
| `test/modules/reviews/helpers/format-review-body.spec.ts` (updated) | Existing spec adapts to the new slim-body shape: header + UUID marker + counts + Walkthrough pointer. Old per-finding-block content migrates to `format-walkthrough-body.spec.ts` where appropriate. |

### Repository spec (real SQLite, per convention)

| Spec | Coverage |
|---|---|
| `test/infrastructure/db/repositories/sqlite-pull-requests.repository.spec.ts` (updated) | `setWalkthroughCommentId` round-trips through `getWalkthroughCommentId`; nullable column accepts null; setting to null clears a previously set id; setting on a non-existent PR throws (the PR row is upserted on webhook ingestion before any worker code runs, so a missing row is a programming bug — fail loudly). |

### Worker integration spec

| Spec | Coverage |
|---|---|
| `test/modules/reviews/reviews.processor.inline.spec.ts` (new) | (a) First run with anchorable + outside-diff findings → both POSTs in order; `walkthrough_comment_id` set. (b) Second run → `updateComment` PATCH for Walkthrough; new `createReview`. (c) Zero findings → Walkthrough PATCH only, no `createReview`. (d) Walkthrough POST 502 → retry succeeds. (e) Inlined `createReview` returns 422 → row `inline_post_failed`, Walkthrough already up (assert order). (f) Cached id returns 404 on PATCH → recovery POST; cache updated. (g) Empty cache + scan finds existing comment via marker → PATCH instead of POST. |

Real SQLite in `mkdtempSync` per convention. Octokit is the only
stub. Snapshot tests
(`anthropic-llm-reviewer.snapshot.spec.ts`) are unaffected; eval
recording fixtures are unaffected.

---

## Migration / rollout

- Drizzle migration `0005` adds one nullable column to
  `pull_requests`. Backfill not required — existing PR rows get
  `NULL`, which means the first re-review run will scan for an
  existing Walkthrough (find none) and POST a fresh one. Old single-
  comment summaries on existing PRs are left as-is (GitHub keeps
  them; they age out of view).
- No prompt or tool-schema change — no eval re-recording.
- Feature gate: not needed. The change is internal to the posting
  boundary; the bot's external contract (post a review per PR push)
  is unchanged.

---

## Deferred / follow-ups

- **Anchor-validity metric in eval.** `anchor_validity_ratio =
  anchorable / total_findings` over the corpus. Add to the Day-6
  eval harness in a follow-up. The telemetry log line above is the
  audit trail this metric reads from.
- **Suggestion blocks.** Pending a Claude-side change that has
  the model emit a fix patch alongside the message. Tracked
  separately.
- **Soft re-anchoring** of outside-diff findings to the nearest
  changed line. Could improve coverage; deferred until we have data
  on how often it would fire.
- **API-side dedup / auto-resolve** of stale inline threads. Both
  leading bots skip this; revisit only if the "Outdated" badge
  proves insufficient in practice.

---

## Open questions

None at the time of writing. Decisions captured above were locked
during design review.
