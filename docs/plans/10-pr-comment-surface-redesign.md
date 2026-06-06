# 10 — PR Comment Surface Redesign

**Status:** Design — ready for implementation plan
**Date:** 2026-06-06
**Predecessor:** `09-inline-pr-review-comments.md` (the existing
walkthrough + inline-review architecture this redesign builds on)

---

## Summary

The bot currently posts a single PATCH-edited **Walkthrough** issue
comment carrying the severity counts and outside-diff details, plus a
GitHub **Review** event whose body is a one-line pointer to the
walkthrough and whose `comments[]` array carries inline per-line
findings.

This redesign redistributes content across surfaces and adds a fourth:
a GitHub **Check Run** that surfaces a CodeRabbit-style merge-box
badge. The walkthrough becomes lifecycle- and scope-focused (no
counts); the review body carries the findings rollup and any
outside-diff entries; the check run carries the in-progress /
skipped / completed signal that appears in the merge box, branch
protection UI, and commit list.

The redesign also foregrounds the bot's distinguishing feature in
copy: every finding is grounded to a `rule_id` from the team's
knowledge base, and the walkthrough now makes that grounding
visible.

---

## Motivation

Three problems with today's surface:

1. **No "the bot is working" signal.** Today's walkthrough only
   appears after the worker decides skip / fail / success. There is
   no signal at PR-open time that the bot has accepted the work.
   A team installing the bot for the first time sees nothing for
   ~30-90 seconds, then a comment lands.
2. **Counts in the walkthrough are the wrong tenant.** The
   walkthrough is conceptually "where is the bot in its workflow
   and what did it see at a high level?" The counts are
   conceptually "what did the review find?" Mixing them means the
   walkthrough body has to change shape for every state, and
   readers parsing severity totals have to skip past lifecycle
   copy.
3. **No merge-box presence.** Every professional PR reviewer
   (CodeRabbit, Copilot, Greptile, Sourcery, Qodo Merge) posts a
   check-run that renders in GitHub's merge box. Without it the bot
   is invisible in the place reviewers look first. With it, the
   "AI PR Review Copilot" name appears alongside CI and
   branch-protection checks, where it belongs.

A separate motivation: the bot has a real differentiator that the
current copy buries — every finding ties to a `rule_id` in the
team's knowledge base. CodeRabbit and Copilot review against general
training; this bot reviews against the team's owned corpus. The
redesign makes that legible.

---

## Goals

- Add a GitHub Check Run posted at worker dequeue and PATCH-updated
  through the lifecycle (in_progress → skipped / completed).
- Add an in-progress walkthrough body posted at worker dequeue and
  PATCH-edited to its terminal body on completion.
- Move severity counts and outside-diff findings from the walkthrough
  to the review body.
- Add a CodeRabbit-style 1-2 paragraph LLM-generated prose summary to
  the walkthrough's success body, plus a "Rules cited" callout that
  makes the KB-grounding visible.
- Use `conclusion=neutral` consistently on the check run — never
  `failure` — so the bot never blocks merges. Informational, not a
  verdict.

## Non-goals

- A blocking-on-severity mode (e.g., "fail check on any error
  finding"). The check is informational only for v1. A per-team
  config knob is future work.
- A "show all retrieved rules" view (collapsed details listing
  the full K=40 retrieved set). Default is firing-rules only; the
  full list is a future feature flag, see Open follow-ups.
- Re-rendering the GitHub-native files-changed list as a separate
  walkthrough section. GitHub already renders that list above the
  PR in three places — duplicating it is noise without signal.
- Editing the agent loop or its prompt. The summarizer is a
  separate post-loop LLM call; the agent's `PROMPT_AND_TOOL_VERSION`
  is not touched and the captured eval recordings stay valid.

---

## Design decisions locked

Each of these was vetted in an adversarial review pass before this
spec was written. They are not up for renegotiation during
implementation.

| Decision | Choice | Rationale |
|---|---|---|
| Surface count | 4 (check run, walkthrough, review body, inline comments) | One surface per concern: lifecycle signal, narrative, findings rollup, per-line citation |
| Check-run conclusion | `neutral` for both 0-finding and N-finding terminal states | A green ✓ above 3 errors is a contradiction; consistent neutral is honest |
| Check-run blocking | Never blocking | `conclusion=neutral` cannot satisfy branch protection's "required check passes" by design |
| Walkthrough success copy | Hybrid: mechanical scaffold (KB callout, "Rules cited" details) + LLM prose intro (1-2 paragraphs, Haiku-class) | The mechanical bits are honest and zero-cost; the prose intro is the warm voice that CodeRabbit users expect |
| Summarizer input | Receives `diff + findings + retrievedRules`, not just diff | Prevents the contradiction case where the summary says "clean refactor" while the review shows 3 errors |
| Summarizer failure | Walkthrough renders the mechanical scaffold without prose; no row failure | The prose intro is a polish layer; the audit row is what's load-bearing |
| Rules-cited panel | Firing rules only, by default | At K=40-100 the full retrieved list is noise; the LLM only meaningfully attends to a few. Listing all of them oversells what "checked" means |
| In-progress walkthrough body | Single sentence | "Review in progress — checking this diff against your team's knowledge base." No spinner GIF, no fortune |
| Posting order at dequeue | Row insert → check-run POST → walkthrough POST | Row insert is the de-facto serialization point that the in-flight guard depends on; posting GitHub surfaces before it opens a concurrent-webhook race |
| Posting order at completion | Walkthrough PATCH → review POST → check-run PATCH | When the merge-box badge flips ✓ the conversation tab is already fully updated |
| Outside-diff findings | Move from walkthrough to review body | Conceptually they are findings, not scope; they belong with the counts |

---

## Surface map × lifecycle states

Four surfaces, five states. **C** = Check Run. **W** = Walkthrough.
**R** = Review event with inline comments.

| State | C | W | R |
|---|---|---|---|
| **In-progress** (worker dequeue) | POST `status=in_progress`, title "Reviewing against your knowledge base" | POST in-progress body | not posted |
| **Skipped** (size cap exceeded) | PATCH `conclusion=skipped`, title "Review skipped — diff exceeds size limit" | PATCH skipped body | not posted |
| **Failed** (bot error or `MAX_DIFF_BYTES` system cap) | PATCH `conclusion=neutral`, title "Review could not complete" | PATCH failed body | not posted |
| **Empty diff** (no reviewable changes) | PATCH `conclusion=neutral`, title "No diff to review" | PATCH success body (summary: "No reviewable diff content on this PR.", zero rules cited) | not posted |
| **Success, 0 findings, 0 outside-diff** | PATCH `conclusion=neutral`, title "No findings — your knowledge base was consulted" | PATCH success body | POST review with "0 findings" body, no inline |
| **Success, N findings or M outside-diff** | PATCH `conclusion=neutral`, title "N findings against your knowledge base" | PATCH success body | POST review with counts table + outside-diff callout + N inline |

The success-with-outside-diff-but-zero-inline case is explicit: the
review event posts whenever **total finding count > 0**, not when
**anchorable count > 0**. This closes a hole where outside-diff
findings would otherwise vanish on a PR whose diff is too sparse to
anchor any of them.

---

## Body templates

### In-progress walkthrough

```markdown
<!-- ai-pr-review-copilot:walkthrough:v1:pr=<pr_node_id> -->
**AI PR Review Copilot** — review in progress
<!-- ai-pr-review-copilot:v1:mode=in-progress -->

_Checking this diff against your team's knowledge base. Usually 30-90 seconds on small PRs._
```

### Skipped walkthrough (size cap)

```markdown
<!-- ai-pr-review-copilot:walkthrough:v1:pr=<pr_node_id> -->
**AI PR Review Copilot** — review skipped
<!-- ai-pr-review-copilot:v1:mode=size-skipped -->

This PR has **<N> changed lines**, which exceeds the configured limit of **<limit>** for this reviewer.

The bot is tuned to apply your team's knowledge base to small, focused PRs (under <limit> changed lines) where findings are reliable. On larger diffs quality drops and the bot tends to surface noise rather than signal — so it skips them rather than posting a low-confidence review.

_No findings were generated. To get a review on this work, consider breaking it into smaller PRs._
```

### Failed walkthrough

```markdown
<!-- ai-pr-review-copilot:walkthrough:v1:pr=<pr_node_id> -->
**AI PR Review Copilot** — review could not complete
<!-- ai-pr-review-copilot:v1:mode=failed -->

The bot tried to check this PR against your knowledge base but did not finish: <reason copy>.

_No findings were generated. The audit log records the underlying error code for the operator to inspect._
```

### Success walkthrough (the centrepiece)

```markdown
<!-- ai-pr-review-copilot:walkthrough:v1:pr=<pr_node_id> -->
**AI PR Review Copilot** — review complete
<!-- ai-pr-review-copilot:v1:mode=success -->
<!-- ai-pr-review-copilot:v1:review-id=<uuid> -->

> Reviewed against your team's knowledge base — top **<K>** rules retrieved for this diff.

### Summary

<1-2 paragraph LLM-generated prose. Plain-English description of what
the PR does. Explicitly acknowledges the finding count and dominant
severity when applicable. Falls back to the mechanical scaffold alone
if the summarizer call failed.>

<details>
<summary>📚 Rules cited (<N>)</summary>

**From `api-conventions.json`**
- 🛑 `no-secret-in-log` — Sensitive identifiers must not appear in log statements
- 🛑 `thin-controllers` — Controllers contain HTTP wiring only; business logic lives in services

**From `team-standards.json`**
- ⚠️ `bound-query-pagination` — Endpoints returning collections must accept and bound a `limit` query param

</details>

_See the review below for the per-line findings and severity rollup._
```

Four subtle but load-bearing properties:

- The "Rules cited" callout lists **only firing rules**, grouped by
  source. The total retrieved set (e.g., 40) is mentioned in the
  banner line but not enumerated. Listing all 40 oversells how
  thoroughly each was "checked"; listing the firing ones is
  honest and useful.
- The "Rules cited" callout is **omitted entirely** when no rules
  fired (0-findings success path). An empty `<details>` block
  reads as broken UI; the banner line alone carries the
  KB-consulted signal in that case.
- Rule titles are passed through `sanitizeFindingMarkdown` and
  truncated to 80 chars before rendering. Seed corpus titles are
  customer-owned and may contain arbitrary markdown.
- The walkthrough never carries counts. The summary prose may
  reference counts ("the bot found 3 issues") but the numeric
  rollup lives in the review body.

### Review body — 0 findings

```markdown
<!-- ai-pr-review-copilot:v1:review-id=<uuid> -->

**0 findings — your knowledge base was consulted (top <K> rules retrieved).**

_The diff is within scope and matched no team rules._

See the walkthrough comment above for the change summary.
```

### Review body — N findings (with outside-diff)

```markdown
<!-- ai-pr-review-copilot:v1:review-id=<uuid> -->

**<N> findings — your knowledge base was consulted (top <K> rules retrieved).**

| 🛑 errors | ⚠️ warnings | 💡 info |
|---|---|---|
| 1 | 2 | 0 |

> [!CAUTION]
> Some findings are outside the changed lines and can't be posted inline due to GitHub limitations.
>
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary>
>
> **`apps/api/src/modules/orders/orders.service.ts:120-125`** — readonly-injected-deps
>
> Injected dependencies should be declared `readonly`. The constructor parameter `logger` is currently mutable.
>
> _Rule:_ `readonly-injected-deps`
>
> </details>

See the walkthrough comment above for the change summary. Inline comments are anchored below.
```

### Inline comment (unchanged)

Today's `formatInlineCommentBody` shape is correct and is preserved
verbatim:

```markdown
🛑 **<title>**

<message>

_Citation:_
```
<citation>
```
_Rule:_ `<rule_id>`
```

### Check-run output

The check run's `output.title` and `output.summary` per state:

| State | `output.title` | `output.summary` (first line) |
|---|---|---|
| in-progress | "Reviewing against your knowledge base" | "Checking this diff against your team's knowledge base. Usually 30-90 seconds." |
| skipped | "Review skipped — diff exceeds size limit" | "This PR has <N> changed lines, above the configured limit of <limit>." |
| failed | "Review could not complete" | "<reason copy>. See the walkthrough comment for details." |
| success, 0 findings | "No findings — your knowledge base was consulted" | "Top <K> rules retrieved; none matched. <walkthrough URL>" |
| success, N findings | "<N> findings against your knowledge base" | "<errors>E / <warnings>W / <info>I. This check is informational and does not block merges. <walkthrough URL>" |

The "informational, does not block merges" note in the N-findings
summary is intentional: it heads off the question a repo admin will
ask the first time they see a green-but-not-passing check sitting
above flagged errors.

---

## Architecture

### File layout

```
apps/api/src/
├── infrastructure/
│   ├── db/
│   │   └── schema/
│   │       └── reviews.ts                              ← EDIT: add 2 columns
│   └── llm/
│       ├── walkthrough-summarizer.prompt.ts            ← NEW: system prompt for the summarizer
│       └── anthropic-walkthrough-summarizer.ts         ← NEW: IWalkthroughSummarizer implementation
└── modules/
    └── reviews/
        ├── helpers/
        │   ├── format-walkthrough-in-progress-body.ts  ← NEW
        │   ├── format-walkthrough-success-body.ts      ← RENAMED + REWRITTEN (was: format-walkthrough-body.ts)
        │   ├── format-walkthrough-failed-body.ts       ← EDIT: KB-tone copy
        │   ├── format-walkthrough-skipped-body.ts      ← EDIT: KB-tone copy
        │   ├── format-review-body.ts                   ← REWRITTEN: counts + outside-diff move here
        │   ├── format-check-run-output.ts              ← NEW: {title, summary} per mode
        │   └── format-inline-comment.ts                ← unchanged
        ├── types/
        │   ├── walkthrough-summarizer.ts               ← NEW: IWalkthroughSummarizer + token
        │   └── review.repository.ts                    ← EDIT: 2 new methods (see below)
        ├── reviews.service.ts                          ← EDIT: thread retrievedRules, persist walkthrough_summary
        ├── reviews.processor.ts                        ← EDIT: heaviest — new posting orchestration
        └── reviews.module.ts                           ← EDIT: provide WALKTHROUGH_SUMMARIZER
```

The infrastructure-tier placement of the summarizer follows the
existing seam established by `ILlmReviewer`: interface and token live
in `modules/reviews/types/`, the Anthropic-flavoured implementation
lives in `infrastructure/llm/`. The summarizer does not import
`ReviewsService` or `ILlmReviewer`; it is a standalone one-shot
LLM caller.

### New repository methods on `IReviewRepository`

```ts
// Persist the GitHub-assigned check-run id when the worker POSTs the
// in-progress check. Per-review (per head_sha), so it lives on the
// reviews row, not the pull_requests row.
setCheckRunId(reviewId: string, checkRunId: number): void;

// Persist the LLM-generated walkthrough prose intro. Nullable —
// when the summarizer call fails, the row records null and the
// walkthrough formatter renders the mechanical scaffold alone.
setWalkthroughSummary(reviewId: string, summary: string | null): void;
```

### New columns on `reviews`

```ts
check_run_id: integer('check_run_id'),                  // nullable
walkthrough_summary: text('walkthrough_summary'),       // nullable
```

Generated as a single `drizzle-kit generate --name=add_check_run_id_and_walkthrough_summary`
migration. Both nullable; no backfill required.

### `IWalkthroughSummarizer`

```ts
export const WALKTHROUGH_SUMMARIZER = Symbol('WalkthroughSummarizer');

export interface IWalkthroughSummarizer {
  summarize(input: {
    diff: string;
    findings: Array<{
      rule_id: string;
      title: string;
      severity: 'error' | 'warning' | 'info';
    }>;
    retrievedRules: Array<{
      rule_id: string;
      source: string;
      title: string;
    }>;
  }): Promise<{ intro: string } | null>;
}
```

Implementation contract:

- Single non-tool LLM call to a Haiku-class model (default
  `claude-haiku-4-5-20251001`; tunable via
  `WALKTHROUGH_SUMMARIZER_MODEL`).
- `max_tokens` cap at 250 to bound cost and length.
- Hard 1.5-second timeout. Slow Haiku must not stretch the
  success-path budget.
- On any failure (timeout, 4xx, malformed response, unparseable
  output), returns `null`. Never throws into the worker.
- Output passes through `sanitizeFindingMarkdown` before being
  embedded in the walkthrough body.
- A post-call sanity check rejects the summary (returns `null`)
  if it claims "no issues" / "clean" / "low risk" / similar
  while `findings.length > 0`. The substring-match list lives in
  the implementation file and is unit-tested.

### `RunDryRunResult` extension

`reviews.service.ts` already has the retrieved hits in scope inside
`runDryRun`. The seam grows by one field:

```ts
export interface RunDryRunResult {
  // ... existing fields
  retrievedRules: Array<{
    rule_id: string;
    source: string;
    title: string;
    severity: SeverityLevel;
  }>;
}
```

This does not touch `AnalyzeDiffInput` or any prompt-hash surface.
Verified by reading `anthropic-llm-reviewer.ts` and
`llm-reviewer.ts`; the hash inputs are `SYSTEM_PROMPT + JSON.stringify(tools)`.

---

## Worker lifecycle

Step-by-step, with every external call annotated and every error
branch documented. **C** = check-run API call. **W** = walkthrough
issue-comment API call. **R** = review API call.

```
[Job entry]
  1. Read job.data; log dequeue.
  2. Per-PR guard via findRecentInProgressForPr → early return if hit.
  3. Octokit init via githubAuth.forInstallation(installation_id).
  4. pulls.get; on 404 / 410 / 401 → standalone-failure row + UnrecoverableError.
                  on retryable status → standalone-failure row + throw classified error.
                  Skip in-progress surfaces: we have no confirmed PR yet.

[Pre-allocate + reserve serialization point]
  5. Pre-allocate reviewId (UUID).
  6. Reserve the in_progress row via reviewsRepo.insert(...) BEFORE any
     GitHub surface POST. The row's existence is what the guard at
     step 2 depends on; posting surfaces before it opens a
     concurrent-webhook race where two synchronize deliveries both
     reach step 8 simultaneously and both POST a check-run, leaking
     the first one.

[Sweep prior leaked check-runs on this PR]
  7. Find the most recent prior reviews row for the same
     pr_node_id whose check_run_id is non-null. If one exists,
     PATCH that check-run to `conclusion=neutral` with
     `output.title="Superseded by newer review on this PR."` Best
     effort: failure logs and continues. This sweeps leaked
     in_progress check-runs from prior crashed attempts so they
     do not sit in the merge box forever. Idempotent against
     check-runs already PATCHed to a terminal conclusion — the
     GitHub API accepts the no-op.

[In-progress surfaces]
  8. C-POST check-run (status=in_progress). Skip entirely if
     the in-memory permission cache already marks this installation
     as missing the Checks permission.
        On 403 (permission not accepted): record the
        installation in the in-memory missing-permission set; log;
        checkRunId stays null. Skip every subsequent C-PATCH for
        this review.
        On other failure: log; checkRunId stays null.
  9. setCheckRunId(reviewId, checkRunId) — only if POST succeeded.
 10. W-POST walkthrough (in-progress body) via upsertWalkthrough.
        On failure: log; continue. The marker scan path recovers
        if a previous attempt left a comment.

[Diff fetch]
 11. Fetch unified diff via mediaType.
        On retryable failure: PATCH C to neutral, PATCH W to failed,
        standalone-failure row, throw.

[Size + empty pre-checks]
 12. MAX_DIFF_BYTES (system safety cap) → standalone-failure,
     PATCH W to failed, PATCH C to neutral with "review could
     not complete" title, return.
 13. MAX_REVIEW_DIFF_LINES (product policy cap) → standalone-skipped,
     PATCH W to skipped, PATCH C to skipped, return.
 14. Empty diff → standalone-completion. PATCH W to the success
     body with summary = "No reviewable diff content on this PR."
     and zero rules cited (no agent loop ran, no retrievedRules
     available). PATCH C to neutral with "no diff to review"
     title. Return.

[Agent loop]
 15. runRealReview → returns findings + retrievedRules + usage + model.
        On failure (terminal or retryable): PATCH W to failed,
        PATCH C to neutral with "review could not complete" title,
        re-throw original error (BullMQ retry honours backoff).

[Summarizer + final surfaces]
 16. summarizer.summarize({ diff, findings, retrievedRules }) — bounded
     by 1.5-second timeout. Returns { intro } or null.
 17. setWalkthroughSummary(reviewId, summary?.intro ?? null).
 18. Compute counts via countBySeverity(findings) and partition via
     anchorFindingsToDiff(findings, hunks).
 19. PATCH W (success body — KB callout + intro + "Rules cited"
     details). NOT tolerated; failure → markFailed
     comment_post_failed, PATCH C to neutral, throw UnrecoverableError.
 20. POST R (event=COMMENT, body = counts + outside-diff CAUTION,
     comments = inline) — but only if findings.length > 0
     OR outsideDiff.length > 0. The N-findings-but-no-anchorable
     case must still POST so the outside-diff findings land
     somewhere.
        On failure: existing PR-state recheck path. NOT tolerated.
 21. PATCH C (conclusion=neutral, title per state, output.summary
     includes walkthrough URL). NOT tolerated; failure → markFailed
     check_run_patch_failed, throw UnrecoverableError. (Without this
     guard, a leaked in_progress check-run sits in the merge box
     forever for that head_sha.)
 22. Log post_summary; remove reviewId from activeReviewIds in finally.
```

Three notes that should stay legible to future editors of this file:

- **Why C-PATCH at step 21 is not tolerated:** a stale in_progress
  check-run is operator-visible (it sits in the merge box) and not
  user-blocking, but it never recovers on its own. Subsequent
  pushes change `head_sha`, so each push leaks one stale check-run.
  Treating the PATCH as load-bearing keeps the lifecycle clean.
- **Why the row insert (step 6) moved earlier:** the original
  proposal had row insert inside `runRealReview`. Posting GitHub
  surfaces before that insert created a window where two concurrent
  jobs (rapid `synchronize` deliveries) both passed the in-flight
  guard. Inserting the row before any GitHub I/O closes that
  window because the second attempt's guard sees the row.
- **Why the sweep at step 7 happens before the new C-POST at
  step 8:** if a prior attempt crashed after C-POST but before
  C-PATCH, the prior check-run is stuck at `in_progress`. The
  guard at step 2 might let a fresh attempt through (the prior
  row was eventually marked `failed` by the shutdown drain), and
  that fresh attempt would post a new check-run for a new
  `head_sha` while the prior `head_sha`'s check-run leaks
  forever. The sweep PATCHes the prior check-run to neutral
  before the new POST, so the merge box of the prior commit gets
  a terminal conclusion.

---

## Error handling and degradation

Principle: the audit row in `reviews` is the only load-bearing
record. External surfaces are best-effort with logging, except
where listed below.

| Surface | Failure tolerance | Recovery |
|---|---|---|
| Reviews row insert / update | Not tolerated | Existing markFailedSafely + boot sweep |
| In-progress check-run POST | Tolerated. 403 marks installation as missing-permission; everything else logs and skips subsequent C-PATCH | None — badge missing for that PR, walkthrough copy carries an opt-in line |
| In-progress walkthrough POST | Tolerated | Next attempt's marker scan recovers |
| Summarizer call | Tolerated | Walkthrough renders mechanical scaffold without prose |
| Success walkthrough PATCH | Not tolerated | markFailed comment_post_failed, PATCH check-run, throw |
| Review POST | Not tolerated | Existing path preserved |
| Final check-run PATCH | Not tolerated | markFailed check_run_patch_failed, throw |

### Installation-scoped permission cache

There is no `installations` table in the current schema, and v1
does not add one. The permission cache lives in memory on the
existing `IGithubAuthProvider` singleton, which already caches
Octokit instances per installation_id:

```ts
private readonly missingChecksPermission = new Set<number>();

markChecksPermissionMissing(installationId: number): void { ... }
hasChecksPermission(installationId: number): boolean { ... }  // returns false iff in the set
```

Set membership is added on the first C-POST 403 for that
installation. Worker skips both C-POST and every subsequent
C-PATCH when `hasChecksPermission` returns false.

The cache resets on worker restart, which is the acceptable
failure mode for v1: the next review attempt re-detects the 403,
re-marks the installation, and continues. The user-visible
behaviour does not change — the badge stays absent, the
walkthrough still surfaces the permission-pending line on the
detection round-trip.

A persistent `installations` table is listed under Open follow-ups
for when the bot starts tracking other installation-scoped
metadata.

### Permission-pending walkthrough copy

When `hasChecksPermission(installation_id)` returns false (the
installation is in the in-memory missing-permission set), the
success and in-progress walkthrough bodies include one extra
line at the bottom:

> _The merge-box status badge is unavailable until your repo
> admin accepts this app's new "Checks" permission at
> [github.com/settings/installations](https://github.com/settings/installations)._

This is the one user-visible cue that the missing badge is not a
bug; it's a one-click admin action.

---

## Persistence and migration

### Schema changes

**`reviews` table** — two nullable columns added:

```ts
check_run_id: integer('check_run_id'),
walkthrough_summary: text('walkthrough_summary'),
```

No other tables change. The permission cache is in-memory only
(see Error handling), so v1 does not introduce an `installations`
table.

Both new columns are nullable, so the migration is purely
additive — no backfill, no downtime, no read-path adjustments
for pre-migration rows.

### Drizzle-kit generation

One migration file produced via:

```bash
npx drizzle-kit generate --name=add_check_run_id_and_walkthrough_summary
```

The migration is applied automatically on boot via
`DatabaseService.open()`'s existing `migrate()` call.

### Eval staleness paths

The captured-recording staleness check in
`apps/api/src/modules/reviews/eval/staleness.ts` enumerates a
slice of source paths whose change invalidates the cache. The new
summarizer prompt file must be added to that slice so summarizer
prompt drift cannot slip past CI:

```ts
const SHARED_TRACKED_PATHS = [
  // ... existing entries
  'apps/api/src/infrastructure/llm/walkthrough-summarizer.prompt.ts',
];
```

The agent-loop surface is unaffected: no entry in `SHARED_TRACKED_PATHS`
needs to change for the agent-loop side of this redesign because
`AnalyzeDiffInput` and the system prompt hash do not change.

---

## GitHub App permissions migration

### What changes

The App manifest at `github.com/settings/apps/<app-name>` adds:

| Permission | Access |
|---|---|
| **Checks** | Read & write |

Existing scope keeps:

| Permission | Access |
|---|---|
| **Pull requests** | Read & write |
| **Contents** | Read-only |
| **Metadata** | Read-only |

### Rollout sequence

1. **Before the implementation PR is merged.** Update the App
   manifest in GitHub's web UI to add the new permission. This is
   a 30-second click; no code involved. New permissions surface as
   pending acceptance for existing installations; nothing breaks.
2. **In the implementation PR.** Update `docs/setup/github-app.md`
   so new installers add the permission at first install.
3. **After the implementation PR is merged.** Existing
   installations see a yellow banner on the GitHub App settings
   page prompting acceptance. They continue to receive reviews
   (walkthrough, inline) until they accept; the check-run badge
   is absent until then.

### Existing-installation experience

- The walkthrough success and in-progress bodies render the
  permission-pending line described above when the installation
  hasn't accepted yet.
- The 403 cache prevents repeated round-trips on every PR.
- A future `installation` event for the same installation
  clears the cache, so the badge starts appearing the moment
  acceptance lands without code changes.

---

## Testing strategy

### Unit tests

One spec per new or rewritten helper:

- `format-walkthrough-in-progress-body.spec.ts`
- `format-walkthrough-success-body.spec.ts` — covers: KB callout
  presence, "Rules cited" lists only firing rules, rules grouped by
  source, titles sanitized and truncated, mode marker emitted,
  LLM intro embedded verbatim when present and absent when null,
  permission-pending copy emitted only when the flag is false
- `format-walkthrough-failed-body.spec.ts` — updated KB-tone copy
- `format-walkthrough-skipped-body.spec.ts` — updated KB-tone copy
- `format-review-body.spec.ts` — counts table, KB consultation
  line, outside-diff CAUTION block, 0-findings degenerate case
- `format-check-run-output.spec.ts` — title + summary per mode,
  walkthrough URL embedded on success, "informational" disclaimer
  on N-findings summary

### Service-level tests

- `walkthrough-summarizer.spec.ts` — mocks the LLM client; covers:
  prompt shape includes diff + findings + rule metadata; max_tokens
  cap honoured; 1.5-second timeout enforced; failure returns null
  without throwing; sanity-check rejects "clean" / "no issues"
  output when findings count > 0; output passes through
  sanitizer
- `reviews.service.spec.ts` (additions) — `RunDryRunResult` carries
  `retrievedRules`; `setCheckRunId` and `setWalkthroughSummary`
  called with correct args on the success path

### Worker e2e tests

Added to `reviews.processor.e2e-spec.ts`:

- **Lifecycle: in-progress surfaces fire after row insert, before
  diff fetch.** Stub Octokit; assert ordering: row insert →
  check-runs POST → issues.createComment.
- **Lifecycle: success path patches all three surfaces in order**
  (walkthrough PATCH → review POST → check-run PATCH).
- **Lifecycle: skip path patches walkthrough and check-run, never
  invokes analyzeDiff.**
- **Lifecycle: agent-loop failure patches walkthrough (failed body)
  and check-run (neutral / "review could not complete").**
- **Degradation: check-run POST returns 403 → installation flag
  set to false, completion C-PATCH skipped, no throw, walkthrough
  carries permission-pending line.**
- **Degradation: summarizer throws → walkthrough_summary persisted
  null, walkthrough renders without prose.**
- **Outside-diff with zero anchorable findings still posts the
  review** (closes the lifecycle gap).
- **Idempotence: simulated BullMQ retry mid-loop → second attempt
  PATCHes existing check_run_id and walkthrough_comment_id rather
  than creating duplicates.**
- **Stale check-run cleanup: previous-attempt check-run is PATCHed
  to stale on a new push to the same PR** — implementation note:
  the new job entry scans for any prior `completed` rows with
  non-null check_run_id and PATCHes them to neutral / stale title
  before posting the new in-progress check.

### Migration test

A small spec opens an empty SQLite, runs all migrations including
the new one, and asserts the two new columns (`check_run_id`,
`walkthrough_summary`) exist and are nullable.

### Not tested in v1

- The exact prose content of the LLM intro (non-deterministic; the
  eval harness is the right venue, in a follow-up).
- The visual rendering of check-run badges in the GitHub UI (manual
  smoke on a real PR is the only viable check).
- Real GitHub Checks API responses (mocked in unit; manual smoke
  covers real-world behaviour).

---

## Open follow-ups (deferred from v1)

1. **"Show all retrieved rules" feature flag.** A config knob that
   expands the "Rules cited" block to list all K retrieved rules
   (sorted by relevance score), not just the firing ones. Useful
   for teams that want maximum transparency; off by default to
   avoid wall-of-text on K=100 corpora.
2. **Blocking-on-severity mode.** A config knob per installation
   that flips the check-run conclusion to `failure` when any
   error-severity finding fires. Lets a team that wants the bot
   gating merges opt in explicitly.
3. **Periodic stale check-run sweep.** Background job that finds
   reviews rows whose check_run_id is non-null and whose status
   is `completed` but whose head_sha is no longer the PR's head,
   and PATCHes them to neutral / stale. Belt-and-braces against
   the rare PATCH failure that the inline scan doesn't catch.
4. **Summarizer quality judge in eval harness.** A faithfulness
   judge for the prose intro, parallel to the existing finding
   faithfulness judge. Scores whether the intro accurately
   reflects the diff and the findings.
5. **Walkthrough copy localization.** Today the bodies are
   English-only. Surface a `LOCALE` config and load templates
   per locale.
6. **Persistent `installations` table.** When the bot starts
   tracking installation-scoped metadata beyond the permission
   cache (suspended state, plan tier, per-installation feature
   flags), promote the in-memory cache to a real table and
   listen for `installation` webhook events to keep it fresh.

---

## References

- `09-inline-pr-review-comments.md` — the prior surface design this
  builds on
- `docs/setup/github-app.md` — App permissions configuration
- `apps/api/src/modules/reviews/eval/staleness.ts` — the
  tracked-paths slice that needs the new summarizer prompt
- `CLAUDE.md` (repo root) — directory contract and dependency
  rules; this design respects the modules-→-infrastructure
  one-way rule
