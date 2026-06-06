# PR Comment Surface Redesign — Implementation Plan

> **Reference spec:** `docs/plans/10-pr-comment-surface-redesign.md`
> **Branch:** `feat/pr-comment-surface-redesign` (already created)
> **Prior commit:** `b4e5428` (spec doc)

**Goal:** Redistribute PR comment content across four GitHub surfaces (Check Run, Walkthrough comment, Review body, inline comments) and add a CodeRabbit-style merge-box badge that surfaces lifecycle state from worker dequeue through completion. The KB-grounded distinguishing feature of the bot becomes visible in copy.

**Architecture:** Pure-function helpers (parse diff files, new + rewritten body formatters, new check-run output formatter) feed a refactored `reviews.processor.ts` lifecycle. A new `IWalkthroughSummarizer` LLM seam — separate from the agent loop — produces a 1-2 paragraph prose intro for the walkthrough's success body, with graceful degradation to a mechanical-only render on failure. Two nullable columns added to `reviews`; an in-memory permission cache on `IGithubAuthProvider` keeps Check API 403 handling lightweight.

**Tech Stack:** NestJS 11, TypeScript 5, Drizzle ORM (SQLite), `better-sqlite3`, Octokit, Jest 29.

---

## Conventions used in every task

- **Run commands from `apps/api/`** unless stated otherwise.
- **Path alias `@/` resolves to `apps/api/src/`** (configured in `tsconfig.json` and Jest's `moduleNameMapper`).
- **Test file paths mirror `src/` exactly** under `apps/api/test/`. No exceptions.
- **Commit shape:** `feat(reviews): <subject>` / `feat(infra): <subject>` / `docs(...): <subject>` matching the conventional-commit style on existing commits. **Never add AI-attribution trailers** (`Co-Authored-By: …` etc.) — repo rule.
- **TDD per task:** write the failing test first, run it to see it fail with the expected message, implement the minimum to make it pass, run again to see it pass, commit.
- **Lifecycle reference:** the worker step numbers throughout this plan refer to the 22-step lifecycle in §"Worker lifecycle" of the spec doc.
- **E2E test harness helpers:** the e2e tests in Tasks 25-33 reference helpers like `mockOctokit`, `jobFixture`, `lastWalkthroughBody`, `lastCheckRunPatch`, `currentReviewId`, `buildDiffWithChangedLines`. These are illustrative names — before running an e2e task, open `apps/api/test/modules/reviews/reviews.processor.e2e-spec.ts` and use the **existing fixture and helper names** from that file. Extend the harness as needed (e.g., add a `checkRunCreate` / `checkRunUpdate` interceptor to the existing mock) rather than reinventing it.

---

## Task 1: Schema columns + drizzle migration

**Files:**
- Modify: `apps/api/src/infrastructure/db/schema/reviews.ts`
- Create: `apps/api/src/infrastructure/db/migrations/0008_add_check_run_id_and_walkthrough_summary.sql` (drizzle-kit will produce the filename; verify after generation)
- Test: `apps/api/test/infrastructure/db/schema/reviews-migration.spec.ts`

- [x] **Step 1: Write the failing migration test**

```ts
// apps/api/test/infrastructure/db/schema/reviews-migration.spec.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@/config/config.service';
import { DatabaseService } from '@/infrastructure/db/database.service';

describe('reviews migration — check_run_id + walkthrough_summary columns', () => {
  let dir: string;
  let db: DatabaseService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reviews-migration-'));
    process.env.SQLITE_PATH = join(dir, 'test.sqlite');
    const config = new ConfigService();
    db = new DatabaseService(config);
    await db.open();
  });

  afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds check_run_id as a nullable INTEGER column', () => {
    const raw = db.getDb();
    const cols = raw.prepare("PRAGMA table_info('reviews')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const checkRunId = cols.find((c) => c.name === 'check_run_id');
    expect(checkRunId).toBeDefined();
    expect(checkRunId?.type.toUpperCase()).toBe('INTEGER');
    expect(checkRunId?.notnull).toBe(0);
  });

  it('adds walkthrough_summary as a nullable TEXT column', () => {
    const raw = db.getDb();
    const cols = raw.prepare("PRAGMA table_info('reviews')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const summary = cols.find((c) => c.name === 'walkthrough_summary');
    expect(summary).toBeDefined();
    expect(summary?.type.toUpperCase()).toBe('TEXT');
    expect(summary?.notnull).toBe(0);
  });
});
```

- [x] **Step 2: Run the test, confirm it fails**

```bash
npm test --workspace apps/api -- reviews-migration.spec.ts
```

Expected: FAIL with "Cannot find column check_run_id" (or similar).

- [x] **Step 3: Add columns to the schema**

Append to `apps/api/src/infrastructure/db/schema/reviews.ts`, inside the `sqliteTable('reviews', { ... })` columns block, BEFORE the `created_at` line:

```ts
    // GitHub Check Run id, cached per-review (per head_sha) so the
    // worker can PATCH the in-progress check to its terminal
    // conclusion after the agent loop completes. Null when the
    // installation has not accepted the Checks permission (the
    // C-POST returns 403; the worker logs and skips the PATCH).
    check_run_id: integer('check_run_id'),
    // 1-2 paragraph LLM-generated prose intro embedded in the
    // walkthrough's success body. Null when the summarizer call
    // failed (graceful degrade: the walkthrough renders the
    // mechanical scaffold without prose).
    walkthrough_summary: text('walkthrough_summary'),
```

- [x] **Step 4: Generate the migration**

```bash
cd apps/api && npx drizzle-kit generate --name=add_check_run_id_and_walkthrough_summary
```

Expected: a new file `apps/api/src/infrastructure/db/migrations/0008_<descriptor>.sql` (drizzle-kit picks the exact filename) plus updated `meta/_journal.json` and `meta/0008_snapshot.json`. The SQL should contain two `ALTER TABLE reviews ADD COLUMN` statements.

- [x] **Step 5: Re-run the test, confirm it passes**

```bash
npm test --workspace apps/api -- reviews-migration.spec.ts
```

Expected: PASS, both assertions green.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/infrastructure/db/schema/reviews.ts \
  apps/api/src/infrastructure/db/migrations/ \
  apps/api/test/infrastructure/db/schema/reviews-migration.spec.ts
git commit -m "feat(infra): add check_run_id and walkthrough_summary columns to reviews"
```

---

## Task 2: Repository methods — `setCheckRunId` + `setWalkthroughSummary`

**Files:**
- Modify: `apps/api/src/modules/reviews/types/review.repository.ts` (interface)
- Modify: `apps/api/src/infrastructure/db/repositories/sqlite-reviews.repository.ts` (impl)
- Test: `apps/api/test/infrastructure/db/repositories/sqlite-reviews.repository.spec.ts` (extend existing file)

- [x] **Step 1: Write the failing tests**

Add to the existing spec (find the closing `});` of the outer `describe` and insert before it):

```ts
describe('setCheckRunId', () => {
  it('persists the check_run_id on an existing row', () => {
    const id = randomUUID();
    repo.insert({ ...insertFixture(id), status: 'in_progress' });
    repo.setCheckRunId(id, 4242);
    const row = repo.findById(id);
    expect(row?.check_run_id).toBe(4242);
  });

  it('overwrites a prior check_run_id on the same row', () => {
    const id = randomUUID();
    repo.insert({ ...insertFixture(id), status: 'in_progress' });
    repo.setCheckRunId(id, 1);
    repo.setCheckRunId(id, 2);
    expect(repo.findById(id)?.check_run_id).toBe(2);
  });

  it('throws when the row does not exist', () => {
    expect(() => repo.setCheckRunId('nonexistent', 1)).toThrow(
      /no review row/i,
    );
  });
});

describe('setWalkthroughSummary', () => {
  it('persists a non-null summary', () => {
    const id = randomUUID();
    repo.insert({ ...insertFixture(id), status: 'in_progress' });
    repo.setWalkthroughSummary(id, 'This PR adds X.');
    expect(repo.findById(id)?.walkthrough_summary).toBe('This PR adds X.');
  });

  it('persists null when the summarizer call failed', () => {
    const id = randomUUID();
    repo.insert({ ...insertFixture(id), status: 'in_progress' });
    repo.setWalkthroughSummary(id, null);
    expect(repo.findById(id)?.walkthrough_summary).toBeNull();
  });
});
```

The `insertFixture(id)` helper already exists in the spec file. If `findById`'s return type doesn't currently include the new columns, that's expected — the next step fixes it.

- [x] **Step 2: Run tests, confirm they fail**

```bash
npm test --workspace apps/api -- sqlite-reviews.repository.spec.ts
```

Expected: FAIL with "setCheckRunId is not a function".

- [x] **Step 3: Add methods to the interface**

In `apps/api/src/modules/reviews/types/review.repository.ts`, inside `IReviewRepository` (before `findFiltered`):

```ts
  // Persist the GitHub-assigned check-run id once the worker POSTs
  // the in-progress check. Per-review (per head_sha), so this lives
  // on the reviews row, not the pull_requests row. Throws when the
  // row does not exist — the worker only calls this AFTER the
  // in_progress row has been inserted.
  setCheckRunId(reviewId: string, checkRunId: number): void;

  // Persist the LLM-generated walkthrough prose intro. Nullable:
  // when the summarizer call fails, the row records null and the
  // walkthrough formatter renders the mechanical scaffold alone.
  setWalkthroughSummary(reviewId: string, summary: string | null): void;
```

- [x] **Step 4: Implement in the SQLite repository**

In `apps/api/src/infrastructure/db/repositories/sqlite-reviews.repository.ts`, add the two methods inside the class:

```ts
  setCheckRunId(reviewId: string, checkRunId: number): void {
    const result = this.db.drizzle
      .update(reviews)
      .set({ check_run_id: checkRunId })
      .where(eq(reviews.id, reviewId))
      .run();
    if (result.changes === 0) {
      throw new Error(`no review row with id="${reviewId}"`);
    }
  }

  setWalkthroughSummary(reviewId: string, summary: string | null): void {
    const result = this.db.drizzle
      .update(reviews)
      .set({ walkthrough_summary: summary })
      .where(eq(reviews.id, reviewId))
      .run();
    if (result.changes === 0) {
      throw new Error(`no review row with id="${reviewId}"`);
    }
  }
```

- [x] **Step 5: Run tests, confirm they pass**

```bash
npm test --workspace apps/api -- sqlite-reviews.repository.spec.ts
```

Expected: PASS, all four new tests green.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/types/review.repository.ts \
  apps/api/src/infrastructure/db/repositories/sqlite-reviews.repository.ts \
  apps/api/test/infrastructure/db/repositories/sqlite-reviews.repository.spec.ts
git commit -m "feat(reviews): add setCheckRunId and setWalkthroughSummary repo methods"
```

---

## Task 3: `RunDryRunResult` carries retrievedRules

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.service.ts`
- Test: `apps/api/test/modules/reviews/reviews.service.spec.ts` (extend existing)

- [x] **Step 1: Write the failing test**

Add to the existing service spec (in the `describe('runDryRun')` block):

```ts
it('returns retrievedRules in the result, sourced from search hits', async () => {
  const result = await service.runDryRun({
    diff: 'diff --git a/x b/x\n+console.log(1);',
  });
  expect(result.retrievedRules).toBeDefined();
  expect(Array.isArray(result.retrievedRules)).toBe(true);
  // Each entry carries rule_id, source, title, severity
  if (result.retrievedRules.length > 0) {
    const first = result.retrievedRules[0];
    expect(first).toMatchObject({
      rule_id: expect.any(String),
      source: expect.any(String),
      title: expect.any(String),
      severity: expect.stringMatching(/^(error|warning|info)$/),
    });
  }
});
```

- [x] **Step 2: Run, confirm it fails**

```bash
npm test --workspace apps/api -- reviews.service.spec.ts -t "retrievedRules"
```

Expected: FAIL with "result.retrievedRules is undefined".

- [x] **Step 3: Extend `RunDryRunResult`**

In `reviews.service.ts`, find `export interface RunDryRunResult` and add:

```ts
  // Knowledge-base grounding surface — the rules retrieved for this
  // review's diff. Used by the worker to render the walkthrough's
  // "Rules cited" callout and to feed the walkthrough summarizer.
  // Type-mirrors SearchHit's surface for the worker's needs.
  retrievedRules: Array<{
    rule_id: string;
    source: string;
    title: string;
    severity: SeverityLevel;
  }>;
```

- [x] **Step 4: Populate it on the success path**

In `runDryRun`, after the `searchHits` array is computed (the sorted one) but before the return, build the retrievedRules list. Then add the new field to BOTH return shapes (success path and failure path — failure returns through `throw`, so only success-path needs the new field; verify).

In the success return at the bottom of `runDryRun`:

```ts
    return {
      review_id: reviewId,
      status: 'completed',
      findings: persistedFindings,
      usage: result.usage,
      model: result.model,
      prompt_version: result.promptVersion,
      turn_count: result.turnCount,
      tool_calls: result.toolCalls,
      retrievedRules: searchHits.map((hit) => ({
        rule_id: hit.rule_id,
        source: hit.source,
        title: hit.title,
        severity: resolveSeverity(hit, this.logger),
      })),
    };
```

- [x] **Step 5: Run, confirm passes**

```bash
npm test --workspace apps/api -- reviews.service.spec.ts -t "retrievedRules"
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.service.ts \
  apps/api/test/modules/reviews/reviews.service.spec.ts
git commit -m "feat(reviews): surface retrievedRules on RunDryRunResult"
```

---

## Task 4: `parse-diff-files` helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/parse-diff-files.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts` (add export)
- Test: `apps/api/test/modules/reviews/helpers/parse-diff-files.spec.ts`

This helper ships now even though the v1 success walkthrough does not render a files-changed table (the spec dropped it). The summarizer will use it internally, and Task 13 references the parsed file shape.

- [x] **Step 1: Write the failing test**

```ts
// apps/api/test/modules/reviews/helpers/parse-diff-files.spec.ts
import { parseDiffFiles } from '@/modules/reviews/helpers/parse-diff-files';

describe('parseDiffFiles', () => {
  it('returns added/removed counts per file from a unified diff', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
diff --git a/src/b.ts b/src/b.ts
index aaaa..bbbb 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,1 @@
 kept
-removed
`;
    expect(parseDiffFiles(diff)).toEqual([
      { path: 'src/a.ts', added: 1, removed: 0 },
      { path: 'src/b.ts', added: 0, removed: 1 },
    ]);
  });

  it('ignores hunk headers (@@) and file mode/diff header lines', () => {
    const diff = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1,2 @@
 a
+b
`;
    expect(parseDiffFiles(diff)).toEqual([{ path: 'x', added: 1, removed: 0 }]);
  });

  it('marks binary files with added=0 removed=0 and the path', () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
    expect(parseDiffFiles(diff)).toEqual([
      { path: 'img.png', added: 0, removed: 0, binary: true },
    ]);
  });

  it('returns an empty array for an empty diff', () => {
    expect(parseDiffFiles('')).toEqual([]);
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- parse-diff-files.spec.ts
```

Expected: FAIL with "Cannot find module".

- [x] **Step 3: Implement**

```ts
// apps/api/src/modules/reviews/helpers/parse-diff-files.ts

// Per-file +/- line counts from a unified diff. Used by the
// walkthrough summarizer to feed the LLM a compact file-level
// view of what the PR touched without re-parsing the diff inside
// the prompt.
//
// Returns one entry per `diff --git` block. The `path` is taken
// from the `b/<path>` side (the post-image), which is canonical
// for renames and deletions alike. Lines starting with `+++`,
// `---`, `@@`, `diff`, `index`, `new file mode`, etc., are not
// counted as added/removed.

export interface DiffFileEntry {
  path: string;
  added: number;
  removed: number;
  binary?: true;
}

export function parseDiffFiles(diff: string): DiffFileEntry[] {
  if (!diff) return [];
  const entries: DiffFileEntry[] = [];
  let current: DiffFileEntry | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // diff --git a/path b/path
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        if (current) entries.push(current);
        current = { path: match[2], added: 0, removed: 0 };
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }
    // Skip non-content header lines
    if (
      line.startsWith('index ') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename ')
    ) {
      continue;
    }
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  if (current) entries.push(current);
  return entries;
}
```

- [x] **Step 4: Export from the helpers barrel**

In `apps/api/src/modules/reviews/helpers/index.ts`, add:

```ts
export { parseDiffFiles, type DiffFileEntry } from './parse-diff-files';
```

- [x] **Step 5: Run, confirm passes**

```bash
npm test --workspace apps/api -- parse-diff-files.spec.ts
```

Expected: PASS, all four cases green.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/parse-diff-files.ts \
  apps/api/src/modules/reviews/helpers/index.ts \
  apps/api/test/modules/reviews/helpers/parse-diff-files.spec.ts
git commit -m "feat(reviews): add parse-diff-files helper for summarizer input"
```

---

## Task 5: `format-walkthrough-in-progress-body` helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/format-walkthrough-in-progress-body.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`
- Test: `apps/api/test/modules/reviews/helpers/format-walkthrough-in-progress-body.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/test/modules/reviews/helpers/format-walkthrough-in-progress-body.spec.ts
import { formatWalkthroughInProgressBody } from '@/modules/reviews/helpers/format-walkthrough-in-progress-body';

describe('formatWalkthroughInProgressBody', () => {
  it('emits the v1 walkthrough marker keyed by the PR node id', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_kw_42' });
    expect(body).toContain(
      '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_kw_42 -->',
    );
  });

  it('emits the mode=in-progress marker', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_x' });
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=in-progress -->');
  });

  it('contains the KB-grounded single-sentence status copy', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_x' });
    expect(body).toMatch(
      /Checking this diff against your team's knowledge base/,
    );
  });

  it('appends the permission-pending line when missingChecksPermission is true', () => {
    const body = formatWalkthroughInProgressBody({
      prNodeId: 'PR_x',
      missingChecksPermission: true,
    });
    expect(body).toMatch(/merge-box status badge is unavailable/);
  });

  it('omits the permission-pending line by default', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_x' });
    expect(body).not.toMatch(/merge-box status badge is unavailable/);
  });

  it('throws on an empty prNodeId', () => {
    expect(() => formatWalkthroughInProgressBody({ prNodeId: '' })).toThrow(
      /prNodeId is required/,
    );
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- format-walkthrough-in-progress-body.spec.ts
```

Expected: FAIL with "Cannot find module".

- [x] **Step 3: Implement**

```ts
// apps/api/src/modules/reviews/helpers/format-walkthrough-in-progress-body.ts

// Walkthrough body posted at worker dequeue, BEFORE the diff fetch
// and agent loop. PATCH-edited in place by the worker on
// completion (success, failed, or skipped). Shares the outer
// marker with the other walkthrough bodies so upsertWalkthrough
// PATCHes the same comment id across the lifecycle.

export interface FormatWalkthroughInProgressBodyInput {
  prNodeId: string;
  missingChecksPermission?: boolean;
}

export function formatWalkthroughInProgressBody(
  input: FormatWalkthroughInProgressBodyInput,
): string {
  if (!input.prNodeId) {
    throw new Error('formatWalkthroughInProgressBody: prNodeId is required.');
  }

  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=in-progress -->`;
  const header = '**AI PR Review Copilot** — review in progress';

  const lines: string[] = [
    marker,
    header,
    modeMarker,
    '',
    "_Checking this diff against your team's knowledge base. Usually 30-90 seconds on small PRs._",
  ];

  if (input.missingChecksPermission) {
    lines.push(
      '',
      '> _The merge-box status badge is unavailable until your repo admin accepts this app\'s new "Checks" permission at [github.com/settings/installations](https://github.com/settings/installations)._',
    );
  }

  return lines.join('\n');
}
```

- [x] **Step 4: Export from the helpers barrel**

```ts
export { formatWalkthroughInProgressBody } from './format-walkthrough-in-progress-body';
```

- [x] **Step 5: Run, confirm passes**

```bash
npm test --workspace apps/api -- format-walkthrough-in-progress-body.spec.ts
```

Expected: PASS, all six cases.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-walkthrough-in-progress-body.ts \
  apps/api/src/modules/reviews/helpers/index.ts \
  apps/api/test/modules/reviews/helpers/format-walkthrough-in-progress-body.spec.ts
git commit -m "feat(reviews): add in-progress walkthrough body formatter"
```

---

## Task 6: KB-tone rewrite for `format-walkthrough-failed-body`

**Files:**
- Modify: `apps/api/src/modules/reviews/helpers/format-walkthrough-failed-body.ts`
- Modify: `apps/api/test/modules/reviews/helpers/format-walkthrough-failed-body.spec.ts`

- [x] **Step 1: Update tests for the new copy**

Replace the existing copy assertions to match the spec's body template:

```ts
it('includes the KB-tone failure copy', () => {
  const body = formatWalkthroughFailedBody({
    prNodeId: 'PR_x',
    reason: 'llm_error',
  });
  expect(body).toMatch(
    /tried to check this PR against your knowledge base but did not finish/,
  );
});
```

- [x] **Step 2: Run, confirm relevant test fails**

```bash
npm test --workspace apps/api -- format-walkthrough-failed-body.spec.ts
```

Expected: FAIL on the copy assertion.

- [x] **Step 3: Update the body**

In `format-walkthrough-failed-body.ts`, change the line beginning `The bot tried to review this PR but did not finish:` to:

```ts
    `The bot tried to check this PR against your knowledge base but did not finish: ${reasonCopy}.`,
```

- [x] **Step 4: Run, confirm passes**

```bash
npm test --workspace apps/api -- format-walkthrough-failed-body.spec.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-walkthrough-failed-body.ts \
  apps/api/test/modules/reviews/helpers/format-walkthrough-failed-body.spec.ts
git commit -m "feat(reviews): KB-tone copy on failed walkthrough"
```

---

## Task 7: KB-tone rewrite for `format-walkthrough-skipped-body`

**Files:**
- Modify: `apps/api/src/modules/reviews/helpers/format-walkthrough-skipped-body.ts`
- Modify: `apps/api/test/modules/reviews/helpers/format-walkthrough-skipped-body.spec.ts`

- [x] **Step 1: Update tests**

Add an assertion for the new copy:

```ts
it('frames the skip around the KB application scope', () => {
  const body = formatWalkthroughSkippedBody({
    prNodeId: 'PR_x',
    changedLines: 1000,
    limit: 300,
  });
  expect(body).toMatch(
    /tuned to apply your team's knowledge base to small, focused PRs/,
  );
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- format-walkthrough-skipped-body.spec.ts
```

Expected: FAIL.

- [x] **Step 3: Update the body**

In `format-walkthrough-skipped-body.ts`, replace the paragraph beginning `The bot is tuned for small focused PRs` with:

```ts
      `The bot is tuned to apply your team's knowledge base to small, focused PRs (under ${input.limit} changed lines) where findings are reliable. On larger diffs quality drops and the bot tends to surface noise rather than signal — so it skips them rather than posting a low-confidence review.`,
```

- [x] **Step 4: Run, confirm passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-walkthrough-skipped-body.ts \
  apps/api/test/modules/reviews/helpers/format-walkthrough-skipped-body.spec.ts
git commit -m "feat(reviews): KB-tone copy on skipped walkthrough"
```

---

## Task 8: New `format-walkthrough-success-body` (replaces `format-walkthrough-body`)

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/format-walkthrough-success-body.ts`
- Delete: `apps/api/src/modules/reviews/helpers/format-walkthrough-body.ts` (only AFTER step 4 below confirms no other files reference it)
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`
- Test: `apps/api/test/modules/reviews/helpers/format-walkthrough-success-body.spec.ts`
- Delete: `apps/api/test/modules/reviews/helpers/format-walkthrough-body.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/test/modules/reviews/helpers/format-walkthrough-success-body.spec.ts
import {
  formatWalkthroughSuccessBody,
  type FormatWalkthroughSuccessBodyInput,
} from '@/modules/reviews/helpers/format-walkthrough-success-body';
import type { FindingWithSeverity } from '@/modules/reviews/helpers/format-review-body';

const REVIEW_ID = '11111111-1111-1111-1111-111111111111';

function baseInput(): FormatWalkthroughSuccessBodyInput {
  return {
    prNodeId: 'PR_x',
    reviewId: REVIEW_ID,
    retrievedRulesCount: 40,
    firingRules: [],
    intro: null,
    missingChecksPermission: false,
  };
}

describe('formatWalkthroughSuccessBody', () => {
  it('throws on a non-UUID reviewId', () => {
    expect(() =>
      formatWalkthroughSuccessBody({ ...baseInput(), reviewId: 'not-a-uuid' }),
    ).toThrow(/UUID/);
  });

  it('emits the walkthrough marker, mode=success, and the review-id marker', () => {
    const body = formatWalkthroughSuccessBody(baseInput());
    expect(body).toContain(
      '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_x -->',
    );
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=success -->');
    expect(body).toContain(
      `<!-- ai-pr-review-copilot:v1:review-id=${REVIEW_ID} -->`,
    );
  });

  it('includes the KB-grounding banner line citing the retrieved count', () => {
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      retrievedRulesCount: 40,
    });
    expect(body).toMatch(
      /Reviewed against your team's knowledge base — top \*\*40\*\* rules retrieved/,
    );
  });

  it('renders the LLM prose intro under a "### Summary" header when intro is non-null', () => {
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      intro: 'This PR adds the orders controller.',
    });
    expect(body).toContain('### Summary');
    expect(body).toContain('This PR adds the orders controller.');
  });

  it('omits the Summary section entirely when intro is null', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), intro: null });
    expect(body).not.toContain('### Summary');
  });

  it('omits the Rules cited details when firingRules is empty', () => {
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      firingRules: [],
    });
    expect(body).not.toContain('Rules cited');
  });

  it('renders Rules cited grouped by source with severity emoji when firingRules is non-empty', () => {
    const firingRules: FormatWalkthroughSuccessBodyInput['firingRules'] = [
      {
        rule_id: 'no-secret-in-log',
        source: 'api-conventions.json',
        title: 'Sensitive identifiers must not appear in log statements',
        severity: 'error',
      },
      {
        rule_id: 'thin-controllers',
        source: 'api-conventions.json',
        title: 'Controllers contain HTTP wiring only',
        severity: 'error',
      },
      {
        rule_id: 'bound-query-pagination',
        source: 'team-standards.json',
        title: 'Endpoints returning collections must bound a limit',
        severity: 'warning',
      },
    ];
    const body = formatWalkthroughSuccessBody({ ...baseInput(), firingRules });
    expect(body).toContain('Rules cited (3)');
    expect(body).toContain('**From `api-conventions.json`**');
    expect(body).toContain('**From `team-standards.json`**');
    expect(body).toContain('🛑 `no-secret-in-log`');
    expect(body).toContain('⚠️ `bound-query-pagination`');
  });

  it('sanitizes and truncates rule titles to 80 chars', () => {
    const long = 'X'.repeat(200);
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      firingRules: [
        {
          rule_id: 'long-title-rule',
          source: 'a.json',
          title: long,
          severity: 'info',
        },
      ],
    });
    // The 80-char prefix is present; the full 200-char title is not
    expect(body).toContain('X'.repeat(80));
    expect(body).not.toContain('X'.repeat(120));
  });

  it('appends the permission-pending line when missingChecksPermission is true', () => {
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      missingChecksPermission: true,
    });
    expect(body).toMatch(/merge-box status badge is unavailable/);
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- format-walkthrough-success-body.spec.ts
```

Expected: FAIL with "Cannot find module".

- [x] **Step 3: Implement the formatter**

```ts
// apps/api/src/modules/reviews/helpers/format-walkthrough-success-body.ts

// Success-state walkthrough body. Posted on the success path —
// after the agent loop returns findings and the summarizer
// returns either a prose intro or null. The walkthrough never
// carries counts; the review event below carries the severity
// rollup and outside-diff findings.

import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';
import type { FindingWithSeverity } from './format-review-body';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SanitizeFn = (input: string) => string;

const SEVERITY_EMOJI: Record<FindingWithSeverity['severity'], string> = {
  error: '🛑',
  warning: '⚠️',
  info: '💡',
};

export interface FormatWalkthroughSuccessBodyInput {
  prNodeId: string;
  reviewId: string;
  // Total number of rules the retriever pulled into the agent
  // loop's context. Mentioned in the banner, NOT enumerated.
  retrievedRulesCount: number;
  // Rules that produced findings — the only set we enumerate.
  // Empty list omits the "Rules cited" details entirely.
  firingRules: Array<{
    rule_id: string;
    source: string;
    title: string;
    severity: FindingWithSeverity['severity'];
  }>;
  // LLM-generated 1-2 paragraph prose intro. Null when the
  // summarizer call failed; the Summary section is omitted.
  intro: string | null;
  missingChecksPermission?: boolean;
  // Tests inject a synchronous identity sanitizer to skip the
  // ESM-only unified ecosystem under Jest's CJS runtime.
  sanitize?: SanitizeFn;
}

const TITLE_MAX = 80;

export function formatWalkthroughSuccessBody(
  input: FormatWalkthroughSuccessBodyInput,
): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatWalkthroughSuccessBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  if (!input.prNodeId) {
    throw new Error('formatWalkthroughSuccessBody: prNodeId is required.');
  }

  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;

  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=success -->`;
  const reviewMarker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;
  const header = '**AI PR Review Copilot** — review complete';

  const lines: string[] = [
    marker,
    header,
    modeMarker,
    reviewMarker,
    '',
    `> Reviewed against your team's knowledge base — top **${input.retrievedRulesCount}** rules retrieved for this diff.`,
  ];

  if (input.intro) {
    lines.push('', '### Summary', '', sanitize(input.intro));
  }

  if (input.firingRules.length > 0) {
    lines.push(
      '',
      '<details>',
      `<summary>📚 Rules cited (${input.firingRules.length})</summary>`,
      '',
    );
    const grouped = groupBySource(input.firingRules);
    for (const [source, rules] of grouped) {
      lines.push(`**From \`${source}\`**`);
      for (const rule of rules) {
        const emoji = SEVERITY_EMOJI[rule.severity];
        const safeTitle = sanitize(rule.title).slice(0, TITLE_MAX);
        lines.push(`- ${emoji} \`${rule.rule_id}\` — ${safeTitle}`);
      }
      lines.push('');
    }
    lines.push('</details>');
  }

  lines.push(
    '',
    '_See the review below for the per-line findings and severity rollup._',
  );

  if (input.missingChecksPermission) {
    lines.push(
      '',
      '> _The merge-box status badge is unavailable until your repo admin accepts this app\'s new "Checks" permission at [github.com/settings/installations](https://github.com/settings/installations)._',
    );
  }

  return lines.join('\n');
}

function groupBySource(
  rules: FormatWalkthroughSuccessBodyInput['firingRules'],
): Map<string, FormatWalkthroughSuccessBodyInput['firingRules']> {
  const out = new Map<
    string,
    FormatWalkthroughSuccessBodyInput['firingRules']
  >();
  for (const rule of rules) {
    const list = out.get(rule.source);
    if (list) list.push(rule);
    else out.set(rule.source, [rule]);
  }
  return out;
}
```

- [x] **Step 4: Find every reference to the old `formatWalkthroughBody`**

```bash
grep -rn "formatWalkthroughBody\|format-walkthrough-body" apps/api/src apps/api/test
```

Expected: references in `reviews.processor.ts`, the helpers barrel, and the old spec. Repoint the processor import to the new name (the processor's call sites change in Task 23). For now: keep the old import in `reviews.processor.ts` working by leaving the old file in place (do not delete yet).

- [x] **Step 5: Update the helpers barrel**

In `apps/api/src/modules/reviews/helpers/index.ts`, add:

```ts
export {
  formatWalkthroughSuccessBody,
  type FormatWalkthroughSuccessBodyInput,
} from './format-walkthrough-success-body';
```

Keep the existing `formatWalkthroughBody` export until Task 23 (worker switchover).

- [x] **Step 6: Run new tests**

```bash
npm test --workspace apps/api -- format-walkthrough-success-body.spec.ts
```

Expected: PASS, all 10 cases.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-walkthrough-success-body.ts \
  apps/api/src/modules/reviews/helpers/index.ts \
  apps/api/test/modules/reviews/helpers/format-walkthrough-success-body.spec.ts
git commit -m "feat(reviews): add success walkthrough body with KB-cited rules"
```

The old `format-walkthrough-body.ts` is deleted later in Task 23 once the processor stops importing it.

---

## Task 9: Rewrite `format-review-body` to carry counts + outside-diff

**Files:**
- Modify: `apps/api/src/modules/reviews/helpers/format-review-body.ts`
- Modify: `apps/api/test/modules/reviews/helpers/format-review-body.spec.ts`

- [x] **Step 1: Update the test to assert the new body**

Replace the existing review-body tests with this complete set:

```ts
import { formatReviewBody } from '@/modules/reviews/helpers/format-review-body';
import type { OutsideDiffFinding } from '@/modules/reviews/helpers/anchor-findings-to-diff';

const REVIEW_ID = '22222222-2222-2222-2222-222222222222';

describe('formatReviewBody', () => {
  it('throws on a non-UUID reviewId', () => {
    expect(() =>
      formatReviewBody({
        reviewId: 'nope',
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        retrievedRulesCount: 0,
        outsideDiff: [],
      }),
    ).toThrow(/UUID/);
  });

  it('emits the marker on every body', () => {
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 0, info: 0, total: 0 },
      retrievedRulesCount: 40,
      outsideDiff: [],
    });
    expect(body).toContain(
      `<!-- ai-pr-review-copilot:v1:review-id=${REVIEW_ID} -->`,
    );
  });

  it('zero-findings body has the KB-consulted banner and no counts table', () => {
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 0, info: 0, total: 0 },
      retrievedRulesCount: 40,
      outsideDiff: [],
    });
    expect(body).toMatch(
      /0 findings — your knowledge base was consulted \(top 40 rules retrieved\)/,
    );
    expect(body).not.toContain('| 🛑 errors |');
  });

  it('N-findings body has the banner line and the counts table', () => {
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 1, warning: 2, info: 0, total: 3 },
      retrievedRulesCount: 40,
      outsideDiff: [],
    });
    expect(body).toMatch(
      /3 findings — your knowledge base was consulted \(top 40 rules retrieved\)/,
    );
    expect(body).toContain('| 🛑 errors | ⚠️ warnings | 💡 info |');
    expect(body).toContain('| 1 | 2 | 0 |');
  });

  it('renders outside-diff findings under a CAUTION callout', () => {
    const outsideDiff: OutsideDiffFinding[] = [
      {
        finding: {
          rule_id: 'readonly-injected-deps',
          severity: 'warning',
          title: 'Injected deps should be readonly',
          message: 'Constructor param `logger` is mutable.',
          location_hint: 'src/x.ts:120-125',
          citation: null,
        },
        parsedAnchor: {
          path: 'src/x.ts',
          startLine: 120,
          endLine: 125,
        },
      },
    ];
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 1, info: 0, total: 1 },
      retrievedRulesCount: 40,
      outsideDiff,
    });
    expect(body).toContain('> [!CAUTION]');
    expect(body).toContain('Outside diff range comments (1)');
    expect(body).toContain('src/x.ts:120-125');
    expect(body).toContain('readonly-injected-deps');
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- format-review-body.spec.ts
```

Expected: FAIL on the new assertions (counts table, banner copy, CAUTION block).

- [x] **Step 3: Rewrite the formatter**

Replace the entire body of `format-review-body.ts` with:

```ts
import type { Finding } from '@/modules/reviews/types/llm-reviewer';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';
import type { FindingCounts } from './finding-counts.types';
import type { OutsideDiffFinding } from './anchor-findings-to-diff';

type SanitizeFn = (input: string) => string;

// The Review event body. Carries the severity rollup, the KB
// consultation banner, and outside-diff findings under a CAUTION
// callout. Per-line inline findings are NOT in this body — they
// land in the `comments[]` array on the GitHub createReview call.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FindingWithSeverity extends Finding {
  severity: 'error' | 'warning' | 'info';
}

export interface FormatReviewBodyInput {
  reviewId: string;
  counts: FindingCounts;
  retrievedRulesCount: number;
  outsideDiff: OutsideDiffFinding[];
  sanitize?: SanitizeFn;
}

export function formatReviewBody(input: FormatReviewBodyInput): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatReviewBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;
  const marker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  const lines: string[] = [marker, ''];

  if (input.counts.total === 0) {
    lines.push(
      `**0 findings — your knowledge base was consulted (top ${input.retrievedRulesCount} rules retrieved).**`,
      '',
      '_The diff is within scope and matched no team rules._',
      '',
      'See the walkthrough comment above for the change summary.',
    );
    return lines.join('\n');
  }

  lines.push(
    `**${input.counts.total} findings — your knowledge base was consulted (top ${input.retrievedRulesCount} rules retrieved).**`,
    '',
    '| 🛑 errors | ⚠️ warnings | 💡 info |',
    '|---|---|---|',
    `| ${input.counts.error} | ${input.counts.warning} | ${input.counts.info} |`,
  );

  if (input.outsideDiff.length > 0) {
    lines.push(
      '',
      '> [!CAUTION]',
      "> Some findings are outside the changed lines and can't be posted inline due to GitHub limitations.",
      '>',
      '> <details>',
      `> <summary>⚠️ Outside diff range comments (${input.outsideDiff.length})</summary>`,
      '>',
    );
    for (const od of input.outsideDiff) {
      const block = renderOutsideDiffEntry(od, sanitize);
      for (const blockLine of block.split('\n')) {
        lines.push(`> ${blockLine}`);
      }
      lines.push('>');
    }
    lines.push('> </details>');
  }

  lines.push(
    '',
    'See the walkthrough comment above for the change summary. Inline comments are anchored below.',
  );

  return lines.join('\n');
}

function renderOutsideDiffEntry(
  entry: OutsideDiffFinding,
  sanitize: SanitizeFn,
): string {
  const f = entry.finding;
  const title = sanitize(f.title || '(untitled)');
  const message = sanitize(f.message || '_(no message)_');
  const where = entry.parsedAnchor
    ? entry.parsedAnchor.startLine !== null
      ? entry.parsedAnchor.endLine !== null &&
        entry.parsedAnchor.startLine !== entry.parsedAnchor.endLine
        ? `${entry.parsedAnchor.path}:${entry.parsedAnchor.startLine}-${entry.parsedAnchor.endLine}`
        : `${entry.parsedAnchor.path}:${entry.parsedAnchor.startLine}`
      : entry.parsedAnchor.path
    : f.location_hint ?? '(no location)';
  return [
    `**\`${where}\`** — ${f.rule_id}`,
    '',
    message,
    '',
    `_Rule:_ \`${f.rule_id}\``,
  ].join('\n');
}
```

- [x] **Step 4: Run, confirm passes**

```bash
npm test --workspace apps/api -- format-review-body.spec.ts
```

Expected: PASS, all five cases.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-review-body.ts \
  apps/api/test/modules/reviews/helpers/format-review-body.spec.ts
git commit -m "feat(reviews): review body carries counts and outside-diff callout"
```

---

## Task 10: `format-check-run-output` helper

**Files:**
- Create: `apps/api/src/modules/reviews/helpers/format-check-run-output.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts`
- Test: `apps/api/test/modules/reviews/helpers/format-check-run-output.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
import { formatCheckRunOutput } from '@/modules/reviews/helpers/format-check-run-output';

describe('formatCheckRunOutput', () => {
  it('in_progress: title carries the KB tagline', () => {
    const out = formatCheckRunOutput({ mode: 'in-progress' });
    expect(out.title).toMatch(/Reviewing against your knowledge base/);
    expect(out.summary).toMatch(/Usually 30-90 seconds/);
  });

  it('skipped: title indicates size limit', () => {
    const out = formatCheckRunOutput({
      mode: 'skipped',
      changedLines: 1000,
      limit: 300,
    });
    expect(out.title).toMatch(/Review skipped — diff exceeds size limit/);
    expect(out.summary).toMatch(/1000 changed lines/);
  });

  it('failed: title and summary reflect the reason copy', () => {
    const out = formatCheckRunOutput({
      mode: 'failed',
      reasonCopy: 'the language-model call was rejected',
    });
    expect(out.title).toMatch(/Review could not complete/);
    expect(out.summary).toMatch(/the language-model call was rejected/);
  });

  it('success 0 findings: title + walkthrough URL in summary', () => {
    const out = formatCheckRunOutput({
      mode: 'success',
      findingsCount: 0,
      retrievedRulesCount: 40,
      walkthroughCommentUrl: 'https://github.com/o/r/pull/1#issuecomment-9',
    });
    expect(out.title).toMatch(
      /No findings — your knowledge base was consulted/,
    );
    expect(out.summary).toContain(
      'https://github.com/o/r/pull/1#issuecomment-9',
    );
  });

  it('success N findings: title cites the count + informational disclaimer in summary', () => {
    const out = formatCheckRunOutput({
      mode: 'success',
      findingsCount: 3,
      counts: { error: 1, warning: 2, info: 0, total: 3 },
      retrievedRulesCount: 40,
      walkthroughCommentUrl: 'https://example.com',
    });
    expect(out.title).toMatch(/3 findings against your knowledge base/);
    expect(out.summary).toMatch(/1E \/ 2W \/ 0I/);
    expect(out.summary).toMatch(
      /informational and does not block merges/,
    );
  });

  it('empty-diff: title indicates no diff to review', () => {
    const out = formatCheckRunOutput({ mode: 'empty-diff' });
    expect(out.title).toMatch(/No diff to review/);
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- format-check-run-output.spec.ts
```

Expected: FAIL with "Cannot find module".

- [x] **Step 3: Implement**

```ts
// apps/api/src/modules/reviews/helpers/format-check-run-output.ts
import type { FindingCounts } from './finding-counts.types';

// {title, summary} pair for the GitHub Check Run's `output` block.
// One discriminated union per lifecycle state; the worker calls
// this for both the POST (in-progress) and the PATCH (terminal).

export type FormatCheckRunOutputInput =
  | { mode: 'in-progress' }
  | { mode: 'skipped'; changedLines: number; limit: number }
  | { mode: 'failed'; reasonCopy: string }
  | { mode: 'empty-diff' }
  | {
      mode: 'success';
      findingsCount: number;
      retrievedRulesCount: number;
      walkthroughCommentUrl: string;
      counts?: FindingCounts;
    };

export interface CheckRunOutput {
  title: string;
  summary: string;
}

export function formatCheckRunOutput(
  input: FormatCheckRunOutputInput,
): CheckRunOutput {
  switch (input.mode) {
    case 'in-progress':
      return {
        title: 'Reviewing against your knowledge base',
        summary:
          "Checking this diff against your team's knowledge base. Usually 30-90 seconds on small PRs.",
      };
    case 'skipped':
      return {
        title: 'Review skipped — diff exceeds size limit',
        summary: `This PR has ${input.changedLines} changed lines, above the configured limit of ${input.limit}.`,
      };
    case 'failed':
      return {
        title: 'Review could not complete',
        summary: `${input.reasonCopy}. See the walkthrough comment for details.`,
      };
    case 'empty-diff':
      return {
        title: 'No diff to review',
        summary: 'The PR has no reviewable diff content.',
      };
    case 'success': {
      if (input.findingsCount === 0) {
        return {
          title: 'No findings — your knowledge base was consulted',
          summary: `Top ${input.retrievedRulesCount} rules retrieved; none matched. ${input.walkthroughCommentUrl}`,
        };
      }
      const counts = input.counts;
      const rollup = counts
        ? `${counts.error}E / ${counts.warning}W / ${counts.info}I. `
        : '';
      return {
        title: `${input.findingsCount} findings against your knowledge base`,
        summary: `${rollup}This check is informational and does not block merges. ${input.walkthroughCommentUrl}`,
      };
    }
  }
}
```

- [x] **Step 4: Export from barrel**

```ts
export {
  formatCheckRunOutput,
  type FormatCheckRunOutputInput,
  type CheckRunOutput,
} from './format-check-run-output';
```

- [x] **Step 5: Run, confirm passes**

```bash
npm test --workspace apps/api -- format-check-run-output.spec.ts
```

Expected: PASS, six cases.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/helpers/format-check-run-output.ts \
  apps/api/src/modules/reviews/helpers/index.ts \
  apps/api/test/modules/reviews/helpers/format-check-run-output.spec.ts
git commit -m "feat(reviews): add check-run output formatter"
```

---

## Task 11: `IWalkthroughSummarizer` interface, token, and prompt file

**Files:**
- Create: `apps/api/src/modules/reviews/types/walkthrough-summarizer.ts`
- Create: `apps/api/src/infrastructure/llm/walkthrough-summarizer.prompt.ts`
- Modify: `apps/api/src/modules/reviews/types/index.ts`

This task adds the contract and the prompt text only. The Anthropic implementation lands in Task 12.

- [x] **Step 1: Create the interface + token**

```ts
// apps/api/src/modules/reviews/types/walkthrough-summarizer.ts

// The walkthrough prose summarizer is a separate LLM seam from
// the agent loop. The agent loop produces findings; this
// summarizer produces a 1-2 paragraph plain-English description
// of what the PR does. It runs AFTER the agent loop on the
// success path and is allowed to fail without affecting the
// review row's terminal state.
//
// Mirrors the ILlmReviewer / WALKTHROUGH_SUMMARIZER pattern:
// interface and token in modules/reviews/types/; concrete
// implementation in infrastructure/llm/. Consumers inject the
// interface; the module binding picks the provider.

export const WALKTHROUGH_SUMMARIZER = Symbol('WalkthroughSummarizer');

export interface WalkthroughSummarizerInput {
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
}

export interface WalkthroughSummarizerResult {
  intro: string;
}

export interface IWalkthroughSummarizer {
  // Single one-shot LLM call. Returns the intro string on
  // success, or null when the call fails for any reason
  // (timeout, 4xx, malformed response, post-call sanity check
  // rejection). Never throws into the caller.
  summarize(
    input: WalkthroughSummarizerInput,
  ): Promise<WalkthroughSummarizerResult | null>;
}
```

- [x] **Step 2: Create the prompt file**

```ts
// apps/api/src/infrastructure/llm/walkthrough-summarizer.prompt.ts

// System prompt for the walkthrough summarizer. Tracked in the
// eval staleness paths so a prompt edit forces recapture.

export const WALKTHROUGH_SUMMARIZER_SYSTEM_PROMPT = `You are a senior engineer writing a 1-2 paragraph summary of a pull request.

You receive:
- A unified diff
- A list of findings the team's knowledge-base-grounded review identified, each with rule_id, title, and severity
- A list of rules that were retrieved from the team's knowledge base

Your job: describe what this PR DOES, in plain English, in 1-2 paragraphs (target: 80-160 words total).

Requirements:
- Focus on architecture and intent, not line counts.
- If findings exist, acknowledge them at the end of the summary in one sentence. Reflect the dominant severity. NEVER say "no issues", "clean refactor", "low risk", or "looks good" if findings.length > 0.
- Do NOT list rule_ids; the review event renders those separately.
- Do NOT use markdown headers or bullets in your output; just plain paragraph(s).
- Do NOT mention the knowledge base by name; the surrounding walkthrough already calls it out.

Output exactly the prose. No preamble, no signature, no markdown fencing.`;

export const WALKTHROUGH_SUMMARIZER_PROMPT_VERSION = 'v1';
```

- [x] **Step 3: Export the interface from the types barrel**

In `apps/api/src/modules/reviews/types/index.ts`, add:

```ts
export {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
  type WalkthroughSummarizerInput,
  type WalkthroughSummarizerResult,
} from './walkthrough-summarizer';
```

- [x] **Step 4: Verify build**

```bash
npm run build --workspace apps/api
```

Expected: clean compile.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/types/walkthrough-summarizer.ts \
  apps/api/src/infrastructure/llm/walkthrough-summarizer.prompt.ts \
  apps/api/src/modules/reviews/types/index.ts
git commit -m "feat(reviews): add walkthrough summarizer interface and prompt"
```

---

## Task 12: `AnthropicWalkthroughSummarizer` implementation

**Files:**
- Create: `apps/api/src/infrastructure/llm/anthropic-walkthrough-summarizer.ts`
- Test: `apps/api/test/infrastructure/llm/anthropic-walkthrough-summarizer.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/test/infrastructure/llm/anthropic-walkthrough-summarizer.spec.ts
import { AnthropicWalkthroughSummarizer } from '@/infrastructure/llm/anthropic-walkthrough-summarizer';

const INPUT = {
  diff: 'diff --git a/x b/x\n+console.log(1);',
  findings: [
    { rule_id: 'no-console', title: 'No console', severity: 'warning' as const },
  ],
  retrievedRules: [
    { rule_id: 'no-console', source: 'a.json', title: 'No console' },
  ],
};

function makeClientStub(returns: string | Error) {
  return {
    messages: {
      create: jest.fn().mockImplementation(async () => {
        if (returns instanceof Error) throw returns;
        return {
          content: [{ type: 'text', text: returns }],
        };
      }),
    },
  };
}

describe('AnthropicWalkthroughSummarizer', () => {
  it('returns the intro on a clean text response', async () => {
    const client = makeClientStub('This PR adds a console statement.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toEqual({ intro: 'This PR adds a console statement.' });
  });

  it('returns null when the LLM throws', async () => {
    const client = makeClientStub(new Error('boom'));
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('returns null when the LLM call times out', async () => {
    const slowClient = {
      messages: {
        create: jest
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(resolve, 5000)),
          ),
      },
    };
    const summarizer = new AnthropicWalkthroughSummarizer(slowClient as any, {
      model: 'test-model',
      timeoutMs: 50,
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('rejects a "no issues" intro when findings is non-empty', async () => {
    const client = makeClientStub('This is a clean refactor with no issues.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('accepts a "no issues" intro when findings is empty', async () => {
    const client = makeClientStub('A clean refactor with no issues.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize({ ...INPUT, findings: [] });
    expect(result).toEqual({ intro: 'A clean refactor with no issues.' });
  });

  it('caps max_tokens at 250 in the API call', async () => {
    const client = makeClientStub('Short intro.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await summarizer.summarize(INPUT);
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 250 }),
    );
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- anthropic-walkthrough-summarizer.spec.ts
```

Expected: FAIL with "Cannot find module".

- [x] **Step 3: Implement**

```ts
// apps/api/src/infrastructure/llm/anthropic-walkthrough-summarizer.ts
import type Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  IWalkthroughSummarizer,
  WalkthroughSummarizerInput,
  WalkthroughSummarizerResult,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { WALKTHROUGH_SUMMARIZER_SYSTEM_PROMPT } from './walkthrough-summarizer.prompt';

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TOKENS = 250;

// Substrings that should NOT appear in the intro when findings
// are present. Lowercased substring match; the post-call guard
// rejects the intro and returns null on any hit.
const FORBIDDEN_WHEN_FINDINGS_PRESENT = [
  'no issues',
  'clean refactor',
  'low risk',
  'looks good',
  'no problems',
];

export interface AnthropicWalkthroughSummarizerOptions {
  model: string;
  timeoutMs?: number;
}

export class AnthropicWalkthroughSummarizer
  implements IWalkthroughSummarizer
{
  private readonly logger = new Logger(AnthropicWalkthroughSummarizer.name);

  constructor(
    private readonly client: Anthropic,
    private readonly options: AnthropicWalkthroughSummarizerOptions,
  ) {}

  async summarize(
    input: WalkthroughSummarizerInput,
  ): Promise<WalkthroughSummarizerResult | null> {
    const userMessage = buildUserMessage(input);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let response: Anthropic.Messages.Message;
    try {
      response = (await Promise.race([
        this.client.messages.create({
          model: this.options.model,
          max_tokens: MAX_TOKENS,
          system: WALKTHROUGH_SUMMARIZER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`summarizer timeout after ${timeoutMs}ms`),
              ),
            timeoutMs,
          ),
        ),
      ])) as Anthropic.Messages.Message;
    } catch (err) {
      this.logger.warn(
        `summarizer.failed ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const intro = extractText(response);
    if (!intro) return null;

    if (input.findings.length > 0 && containsForbiddenPhrase(intro)) {
      this.logger.warn(
        'summarizer.rejected forbidden-phrase-with-findings',
      );
      return null;
    }
    return { intro };
  }
}

function buildUserMessage(input: WalkthroughSummarizerInput): string {
  const findingsBlock =
    input.findings.length === 0
      ? 'Findings: none.'
      : `Findings (${input.findings.length}):\n${input.findings
          .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.title}`)
          .join('\n')}`;
  const rulesBlock =
    input.retrievedRules.length === 0
      ? 'Rules retrieved: none.'
      : `Rules retrieved (${input.retrievedRules.length}):\n${input.retrievedRules
          .slice(0, 20)
          .map((r) => `- ${r.rule_id} (from ${r.source}): ${r.title}`)
          .join('\n')}`;
  return [
    '<diff>',
    input.diff,
    '</diff>',
    '',
    findingsBlock,
    '',
    rulesBlock,
    '',
    'Write the 1-2 paragraph summary now.',
  ].join('\n');
}

function extractText(response: Anthropic.Messages.Message): string | null {
  const block = response.content?.find(
    (b): b is { type: 'text'; text: string } => b.type === 'text',
  );
  if (!block) return null;
  const trimmed = block.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function containsForbiddenPhrase(intro: string): boolean {
  const lower = intro.toLowerCase();
  return FORBIDDEN_WHEN_FINDINGS_PRESENT.some((phrase) =>
    lower.includes(phrase),
  );
}
```

- [x] **Step 4: Run, confirm passes**

```bash
npm test --workspace apps/api -- anthropic-walkthrough-summarizer.spec.ts
```

Expected: PASS, six cases.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/infrastructure/llm/anthropic-walkthrough-summarizer.ts \
  apps/api/test/infrastructure/llm/anthropic-walkthrough-summarizer.spec.ts
git commit -m "feat(infra): add Anthropic walkthrough summarizer with timeout and sanity guard"
```

---

## Task 13: ConfigService env var for the summarizer model

> **What shipped (delta from this plan):** the `WALKTHROUGH_SUMMARIZER_MODEL` env-var was added (commit `e519f57`) and then dropped in a follow-up refactor (commit `10d7306`) once the summarizer was bound to follow the active LLM provider's own model env-var instead. There is no segregated summarizer-model setting in the final code. The block below is preserved for archaeology.

**Files:**
- Modify: `apps/api/src/config/config.service.ts`
- Modify: `apps/api/test/config/config.service.spec.ts`

- [x] **Step 1: Write the failing test**

Add to the existing config spec:

```ts
describe('walkthroughSummarizerModel', () => {
  it('defaults to claude-haiku-4-5-20251001 when env unset', () => {
    delete process.env.WALKTHROUGH_SUMMARIZER_MODEL;
    const config = new ConfigService();
    expect(config.walkthroughSummarizerModel).toBe('claude-haiku-4-5-20251001');
  });

  it('honours WALKTHROUGH_SUMMARIZER_MODEL when set', () => {
    process.env.WALKTHROUGH_SUMMARIZER_MODEL = 'custom-model';
    const config = new ConfigService();
    expect(config.walkthroughSummarizerModel).toBe('custom-model');
    delete process.env.WALKTHROUGH_SUMMARIZER_MODEL;
  });
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- config.service.spec.ts -t walkthroughSummarizerModel
```

Expected: FAIL.

- [x] **Step 3: Add the property**

In `apps/api/src/config/config.service.ts`, find an existing model property (e.g., `activeModel()`) and add nearby:

```ts
  // Model id passed to the walkthrough summarizer's Anthropic
  // client. Defaults to a Haiku-class model since the call is
  // short-prose-only and ~$0.001-0.003 per review. Tunable so
  // operators can downgrade to nano-tier or upgrade to Sonnet
  // for testing.
  readonly walkthroughSummarizerModel: string =
    process.env.WALKTHROUGH_SUMMARIZER_MODEL ?? 'claude-haiku-4-5-20251001';
```

- [x] **Step 4: Run, confirm passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/config/config.service.ts \
  apps/api/test/config/config.service.spec.ts
git commit -m "feat(config): add WALKTHROUGH_SUMMARIZER_MODEL env var"
```

---

## Task 14: Wire the summarizer in `ReviewsModule`

> **What shipped (delta from this plan):** the `WALKTHROUGH_SUMMARIZER` provider is **not** bound in `ReviewsModule`. Each LLM provider's infrastructure module (`infrastructure/anthropic/anthropic.module.ts`, `infrastructure/openrouter/openrouter.module.ts`) binds its own concrete implementation and exports the token. Whichever provider module is loaded for the active `LLM_PROVIDER` brings its summarizer along, so the summarizer always follows the active reviewer's provider — no cross-provider account-state bugs. Both providers also got their own summarizer implementation (`anthropic-walkthrough-summarizer.ts`, `openrouter-walkthrough-summarizer.ts`).

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.module.ts`

- [x] **Step 1: Read the existing module to confirm where the ILlmReviewer binding lives**

```bash
sed -n '1,80p' apps/api/src/modules/reviews/reviews.module.ts
```

Locate the provider that binds `LLM_REVIEWER` to its concrete class.

- [x] **Step 2: Add the WALKTHROUGH_SUMMARIZER provider**

Inside the `providers: [...]` array in `reviews.module.ts`, add:

```ts
    {
      provide: WALKTHROUGH_SUMMARIZER,
      useFactory: (config: ConfigService): IWalkthroughSummarizer => {
        const Anthropic = require('@anthropic-ai/sdk').default;
        const client = new Anthropic({
          apiKey: config.anthropicApiKey,
        });
        return new AnthropicWalkthroughSummarizer(client, {
          model: config.walkthroughSummarizerModel,
        });
      },
      inject: [ConfigService],
    },
```

And add the imports at the top:

```ts
import { WALKTHROUGH_SUMMARIZER } from './types/walkthrough-summarizer';
import { AnthropicWalkthroughSummarizer } from '@/infrastructure/llm/anthropic-walkthrough-summarizer';
import type { IWalkthroughSummarizer } from './types/walkthrough-summarizer';
```

If the project's `ConfigService` already has an existing `anthropicApiKey` getter, keep that name. Otherwise check the existing `ILlmReviewer` binding for the property name and match it.

- [x] **Step 3: Build to verify wiring**

```bash
npm run build --workspace apps/api
```

Expected: clean compile.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.module.ts
git commit -m "feat(reviews): wire WALKTHROUGH_SUMMARIZER provider"
```

---

## Task 15: Add summarizer prompt to eval staleness paths

> **What shipped (delta from this plan):** no explicit entry was needed. `SHARED_TRACKED_PATHS` in `eval/staleness.ts` already tracks the whole `apps/api/src/infrastructure/llm/` directory, which covers `walkthrough-summarizer.prompt.ts` transitively. Editing the summarizer prompt invalidates recordings via the directory match.

**Files:**
- Modify: `apps/api/src/modules/reviews/eval/staleness.ts`
- Modify: `apps/api/test/modules/reviews/eval/staleness.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
it('includes the walkthrough summarizer prompt in tracked paths', () => {
  expect(SHARED_TRACKED_PATHS).toContain(
    'apps/api/src/infrastructure/llm/walkthrough-summarizer.prompt.ts',
  );
});
```

- [x] **Step 2: Run, confirm fails**

```bash
npm test --workspace apps/api -- staleness.spec.ts -t "walkthrough summarizer prompt"
```

Expected: FAIL.

- [x] **Step 3: Add the path**

In `staleness.ts`, append to the `SHARED_TRACKED_PATHS` array:

```ts
  'apps/api/src/infrastructure/llm/walkthrough-summarizer.prompt.ts',
```

- [x] **Step 4: Run, confirm passes**

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/reviews/eval/staleness.ts \
  apps/api/test/modules/reviews/eval/staleness.spec.ts
git commit -m "feat(eval): track walkthrough-summarizer prompt for staleness invalidation"
```

---

## Task 16: GithubAuthProvider — in-memory permission cache

**Files:**
- Modify: `apps/api/src/modules/reviews/types/github-auth-provider.ts`
- Modify: `apps/api/src/infrastructure/github/app-installation-auth.provider.ts` (or whichever file implements `IGithubAuthProvider`; verify with grep)
- Test: extend the existing spec for that provider

- [x] **Step 1: Locate the implementing class**

```bash
grep -rn "implements IGithubAuthProvider" apps/api/src
```

The result identifies the concrete class file. Note the path; subsequent steps refer to it.

- [x] **Step 2: Write the failing test**

In the concrete class's test file, add:

```ts
describe('checks permission cache', () => {
  it('hasChecksPermission returns true by default', () => {
    expect(provider.hasChecksPermission(42)).toBe(true);
  });

  it('markChecksPermissionMissing flips hasChecksPermission to false', () => {
    provider.markChecksPermissionMissing(42);
    expect(provider.hasChecksPermission(42)).toBe(false);
  });

  it('is scoped per installation', () => {
    provider.markChecksPermissionMissing(42);
    expect(provider.hasChecksPermission(43)).toBe(true);
  });

  it('invalidateInstallation clears the missing-permission flag', () => {
    provider.markChecksPermissionMissing(42);
    provider.invalidateInstallation(42);
    expect(provider.hasChecksPermission(42)).toBe(true);
  });
});
```

- [x] **Step 3: Run, confirm fails**

```bash
npm test --workspace apps/api -- app-installation-auth.provider.spec.ts -t "permission cache"
```

Expected: FAIL with "markChecksPermissionMissing is not a function".

- [x] **Step 4: Add to the interface**

In `types/github-auth-provider.ts`, append to `IGithubAuthProvider`:

```ts
  // Cache of installations the worker has detected as missing
  // the "Checks" permission. The worker calls
  // markChecksPermissionMissing on the first C-POST 403; checks
  // hasChecksPermission before every subsequent C-POST and C-PATCH.
  // The set is in-memory only — it resets on worker restart, at
  // which point the next review re-detects.
  markChecksPermissionMissing(installationId: number): void;
  hasChecksPermission(installationId: number): boolean;
```

Also update `invalidateInstallation`'s doc-comment to mention the new behaviour:

```ts
  // ... existing comment ...
  // Also clears the missing-checks-permission flag for the
  // installation — a fresh install/re-auth usually means the
  // permission was re-accepted; we let the next review re-detect.
  invalidateInstallation(installationId: number): void;
```

- [x] **Step 5: Implement on the concrete class**

```ts
private readonly missingChecksPermission = new Set<number>();

markChecksPermissionMissing(installationId: number): void {
  this.missingChecksPermission.add(installationId);
}

hasChecksPermission(installationId: number): boolean {
  return !this.missingChecksPermission.has(installationId);
}
```

And inside the existing `invalidateInstallation` method body, add:

```ts
this.missingChecksPermission.delete(installationId);
```

- [x] **Step 6: Run, confirm passes**

Expected: PASS, four cases.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/reviews/types/github-auth-provider.ts \
  apps/api/src/infrastructure/github/app-installation-auth.provider.ts \
  apps/api/test/infrastructure/github/app-installation-auth.provider.spec.ts
git commit -m "feat(infra): in-memory checks-permission cache on IGithubAuthProvider"
```

---

## Task 17: Worker — extract check-run upsert helper

Before touching the lifecycle, isolate the new check-run plumbing into a private helper method on the processor so the lifecycle changes in subsequent tasks can call it cleanly.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`

- [x] **Step 1: Add the helper near the existing `upsertWalkthrough`**

```ts
  // Best-effort POST of the in-progress check run. Returns the
  // check_run_id on success, null on failure (including 403 when
  // the installation has not accepted the Checks permission).
  // The 403 path marks the installation as missing-permission so
  // subsequent C-PATCH calls are skipped without round-tripping.
  private async tryPostInProgressCheckRun(args: {
    octokit: Octokit;
    owner: string;
    repo: string;
    head_sha: string;
    installation_id: number;
  }): Promise<number | null> {
    if (!this.githubAuth.hasChecksPermission(args.installation_id)) {
      return null;
    }
    const output = formatCheckRunOutput({ mode: 'in-progress' });
    try {
      const res = await args.octokit.rest.checks.create({
        owner: args.owner,
        repo: args.repo,
        name: 'AI PR Review Copilot',
        head_sha: args.head_sha,
        status: 'in_progress',
        output,
      });
      return (res.data as { id: number }).id;
    } catch (err) {
      const status = readStatus(err);
      if (status === 403) {
        this.githubAuth.markChecksPermissionMissing(args.installation_id);
        this.logger.warn(
          `worker.check_run.permission_denied installation=${args.installation_id}`,
        );
      } else {
        this.logger.warn(
          `worker.check_run.post_failed status=${status} ${formatBriefError(err)}`,
        );
      }
      return null;
    }
  }

  // Best-effort PATCH of an existing check run. Used by both
  // the terminal-state PATCH on completion AND the sweep step
  // that retires leaked prior check runs at the start of a
  // fresh job. Idempotent against already-terminal check runs.
  private async tryPatchCheckRun(args: {
    octokit: Octokit;
    owner: string;
    repo: string;
    check_run_id: number;
    conclusion:
      | 'success'
      | 'neutral'
      | 'skipped'
      | 'failure'
      | 'cancelled'
      | 'timed_out'
      | 'action_required';
    title: string;
    summary: string;
  }): Promise<void> {
    try {
      await args.octokit.rest.checks.update({
        owner: args.owner,
        repo: args.repo,
        check_run_id: args.check_run_id,
        status: 'completed',
        conclusion: args.conclusion,
        output: { title: args.title, summary: args.summary },
      });
    } catch (err) {
      this.logger.warn(
        `worker.check_run.patch_failed id=${args.check_run_id} ${formatBriefError(err)}`,
      );
    }
  }
```

Add the import:

```ts
import { formatCheckRunOutput } from './helpers';
```

- [x] **Step 2: Build to verify wiring**

```bash
npm run build --workspace apps/api
```

Expected: clean compile (no call sites yet — they come in later tasks).

- [x] **Step 3: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts
git commit -m "feat(reviews): add check-run upsert helpers on the worker"
```

---

## Task 18: Worker — pre-allocate review_id and insert the in-progress row earlier

This task moves the `reviews` row insert from inside `runRealReview` to the worker, BEFORE any GitHub I/O. Step 6 of the lifecycle.

> **What shipped (delta from this plan):** Step 2's "skip the insert if the row already exists" approach silently drops the retrieval metadata that the service computes after the worker pre-reserves the row. The fix shipped in two commits — `22d62ae` (reserve) and `375e927` (reconcile) — replaces the skip with an explicit reconciliation pass: when the service sees an existing row, it calls a new `updateRetrievalMetadata(reviewId, { topK, retrievedChunkIds, retrievedChunkIdsHash, promptVersion })` repo method to overwrite the placeholder values. The pre-reserved row also uses `prompt_version: 'placeholder'`, which means `'placeholder'` had to be added to the `STANDALONE_VERSIONS` allowlist so the row passes validation in its reserved state.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.service.ts`
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`
- Modify: `apps/api/test/modules/reviews/reviews.service.spec.ts`

- [x] **Step 1: Add a new repo method `insertInProgress`**

In `IReviewRepository`:

```ts
  // Insert a row marked in_progress with placeholder fields that
  // get overwritten when the agent loop completes (or marked
  // failed when it doesn't). Used by the worker to reserve the
  // serialization point that the in-flight guard depends on
  // BEFORE any GitHub I/O.
  insertInProgress(args: {
    id: string;
    pr_node_id: string;
    model: string;
    created_at: Date;
  }): void;
```

In the SQLite impl:

```ts
  insertInProgress(args: {
    id: string;
    pr_node_id: string;
    model: string;
    created_at: Date;
  }): void {
    this.insert({
      id: args.id,
      pr_node_id: args.pr_node_id,
      created_by: null,
      diff_length: 0,
      model: args.model,
      prompt_version: 'placeholder',
      top_k: 0,
      retrieved_chunk_ids: '[]',
      retrieved_chunk_ids_hash: '0'.repeat(64),
      status: 'in_progress',
      error_status: null,
      error_code: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      created_at: args.created_at,
      completed_at: null,
    });
  }
```

- [x] **Step 2: Update `ReviewsService.runDryRun` to handle a pre-existing row**

Currently `runDryRun` inserts the row. Update it to check whether the row already exists (caller-provided `reviewId` points to an existing `in_progress` row), and skip the insert if so. Update the relevant logic so that on success, `markCompleted` operates on the existing row instead of inserting.

In `runDryRun`, after `validateOptionalReviewId`, before the insert block:

```ts
const reviewId = validateOptionalReviewId(input.reviewId) ?? randomUUID();
const existingRow = input.reviewId
  ? this.reviews.findById(reviewId)
  : undefined;
const startedAt = existingRow?.created_at ?? new Date();

if (!existingRow) {
  this.reviews.insert({ /* existing payload */ });
}
```

This way callers that pre-insert (the worker, from Task 18) skip the duplicate insert; callers that don't (the dry-run CLI) continue to work.

- [x] **Step 3: Update the worker `process()` to insert the row before any GitHub I/O**

In `reviews.processor.ts`, find step 5 (`const reviewId = randomUUID();`). Just after pre-allocating, insert the row:

```ts
const reviewId = randomUUID();
this.activeReviewIds.add(reviewId);
this.reviewsRepo.insertInProgress({
  id: reviewId,
  pr_node_id: data.pr_node_id,
  model: this.config.activeModel(),
  created_at: new Date(),
});
```

This insertion now precedes the existing `pulls.get` call. To match the spec's lifecycle order (pulls.get THEN insert), the `pulls.get` block must move BEFORE this insert. Reorder:

1. `pulls.get` stays where it is (step 4).
2. The insert moves to AFTER `pulls.get` but BEFORE the diff fetch and BEFORE any new check-run I/O.

Replace the relevant section with:

```ts
// Step 4 (existing): pulls.get + state checks.

// Step 5-6: pre-allocate, reserve serialization point.
const reviewId = randomUUID();
this.activeReviewIds.add(reviewId);
this.reviewsRepo.insertInProgress({
  id: reviewId,
  pr_node_id: data.pr_node_id,
  model: this.config.activeModel(),
  created_at: new Date(),
});

// Steps 7+ (new check-run + walkthrough surfaces, then diff fetch)
// will be added in subsequent tasks.
```

- [x] **Step 4: Update the failure paths to use markFailed (not standalone-failure) post-insert**

In `process()`, every path that previously called `writeStandaloneFailure(...)` AFTER the insert needs to instead call `this.reviewsRepo.markFailed(reviewId, { ... })`. The `writeStandaloneFailure` paths from before the insert (the early `pulls.get` 404 path) stay as-is.

Audit all `writeStandaloneFailure` call sites and convert any that follow the insert. The post-insert ones include:
- Diff fetch retryable failure
- MAX_DIFF_BYTES
- MAX_REVIEW_DIFF_LINES

For each, replace:

```ts
await this.writeStandaloneFailure(data, '<code>', status);
```

with:

```ts
this.reviewsRepo.markFailed(reviewId, {
  completed_at: new Date(),
  error_status: status,
  error_code: '<code>',
});
```

For the empty-diff path, replace `writeStandaloneCompletion(data)` with `markCompleted(reviewId, ...)`. Note: `markCompleted` requires usage fields; for empty-diff we pass zeros.

- [x] **Step 5: Run all worker + service tests**

```bash
npm test --workspace apps/api -- reviews.processor reviews.service
```

Expected: existing tests still pass (where applicable). Some assertions about row insert timing may need updating to expect insert before GitHub calls.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.service.ts \
  apps/api/src/modules/reviews/reviews.processor.ts \
  apps/api/src/modules/reviews/types/review.repository.ts \
  apps/api/src/infrastructure/db/repositories/sqlite-reviews.repository.ts \
  apps/api/test/modules/reviews/reviews.service.spec.ts
git commit -m "feat(reviews): insert review row before any GitHub I/O"
```

---

## Task 19: Worker — sweep prior leaked check-runs

Implements step 7 of the lifecycle: on every new job entry (after row insert, before in-progress C-POST), PATCH any prior reviews row's check_run_id to a terminal `neutral` conclusion with a "Superseded" title.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`
- Add a new repo method.
- Test: e2e in Task 26.

- [x] **Step 1: Add a repo method for finding the most-recent prior check_run_id**

In `IReviewRepository`:

```ts
  // For sweep at job entry — finds the most recent reviews row
  // for the given pr_node_id (excluding the current reviewId)
  // whose check_run_id is non-null. Used by the worker to PATCH
  // a prior leaked in_progress check-run to a terminal state
  // before posting the new in-progress check.
  findMostRecentPriorCheckRun(opts: {
    prNodeId: string;
    excludingReviewId: string;
  }): { reviewId: string; checkRunId: number } | undefined;
```

In the SQLite impl:

```ts
  findMostRecentPriorCheckRun(opts: {
    prNodeId: string;
    excludingReviewId: string;
  }): { reviewId: string; checkRunId: number } | undefined {
    const row = this.db.drizzle
      .select({
        id: reviews.id,
        check_run_id: reviews.check_run_id,
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.pr_node_id, opts.prNodeId),
          ne(reviews.id, opts.excludingReviewId),
          isNotNull(reviews.check_run_id),
        ),
      )
      .orderBy(desc(reviews.created_at))
      .limit(1)
      .get();
    if (!row || row.check_run_id == null) return undefined;
    return { reviewId: row.id, checkRunId: row.check_run_id };
  }
```

Add the needed drizzle imports (`and`, `eq`, `ne`, `isNotNull`, `desc`).

- [x] **Step 2: Call the sweep from the worker**

In `reviews.processor.ts`, after the row insert (Task 18's insert step):

```ts
// Step 7: sweep any prior leaked check-run on this PR.
const prior = this.reviewsRepo.findMostRecentPriorCheckRun({
  prNodeId: data.pr_node_id,
  excludingReviewId: reviewId,
});
if (prior) {
  await this.tryPatchCheckRun({
    octokit,
    owner: data.owner,
    repo: data.repo,
    check_run_id: prior.checkRunId,
    conclusion: 'neutral',
    title: 'Superseded by newer review on this PR.',
    summary: 'A newer review has started on this pull request.',
  });
}
```

- [x] **Step 3: Build**

```bash
npm run build --workspace apps/api
```

Expected: clean.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts \
  apps/api/src/modules/reviews/types/review.repository.ts \
  apps/api/src/infrastructure/db/repositories/sqlite-reviews.repository.ts
git commit -m "feat(reviews): sweep prior leaked check-runs at job entry"
```

---

## Task 20: Worker — in-progress C-POST and W-POST

Implements steps 8-10 of the lifecycle. The check-run goes up first (fastest, most visible); the walkthrough goes up second.

> **What shipped (delta from this plan — also applies to Tasks 21-23):** the in-progress W-POST is `createIfAbsent: true`, not an unconditional upsert. On a PR's *first* review the walkthrough comment is created in the in-progress state; on every subsequent re-review the existing walkthrough comment is left in place (showing the prior terminal result), and the **check-run** is the per-review in-progress signal. Without `createIfAbsent`, a re-review would flip a green terminal walkthrough back to "in progress," which is worse UX than leaving the prior result visible. Tasks 21-23's terminal PATCHes are unchanged — they still overwrite the existing walkthrough with the new terminal body — but they may now be PATCHing over a stale prior result rather than always over an in-progress body.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`

- [x] **Step 1: Add in-progress C-POST after the sweep**

Just after the sweep block from Task 19:

```ts
// Step 8: POST in-progress check-run.
const checkRunId = await this.tryPostInProgressCheckRun({
  octokit,
  owner: data.owner,
  repo: data.repo,
  head_sha: data.head_sha,
  installation_id: data.installation_id,
});
// Step 9: cache the check_run_id on the row.
if (checkRunId !== null) {
  this.reviewsRepo.setCheckRunId(reviewId, checkRunId);
}
```

- [x] **Step 2: Add in-progress W-POST**

Just after the C-POST block:

```ts
// Step 10: POST in-progress walkthrough — ONLY on the PR's first review
// (createIfAbsent). On re-reviews the walkthrough already exists with
// the prior terminal result; leave it in place. The check-run is the
// per-review in-progress signal.
const inProgressBody = formatWalkthroughInProgressBody({
  prNodeId: data.pr_node_id,
  missingChecksPermission: !this.githubAuth.hasChecksPermission(
    data.installation_id,
  ),
});
try {
  await this.upsertWalkthrough({
    octokit,
    owner: data.owner,
    repo: data.repo,
    pr_number: data.pr_number,
    pr_node_id: data.pr_node_id,
    body: inProgressBody,
    createIfAbsent: true,
  });
} catch (err) {
  this.logger.warn(
    `${jobLogPrefix} worker.walkthrough.in_progress_post_failed ${formatBriefError(err)}`,
  );
  // Tolerated — the marker scan path will recover on the next attempt.
}
```

Add the import:

```ts
import { formatWalkthroughInProgressBody } from './helpers';
```

- [x] **Step 3: Build**

```bash
npm run build --workspace apps/api
```

Expected: clean.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts
git commit -m "feat(reviews): post in-progress check-run and walkthrough on dequeue"
```

---

## Task 21: Worker — terminal C-PATCH on size-cap / failed / empty-diff paths

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`

- [x] **Step 1: Add a helper to PATCH the check-run in terminal states**

Before the existing `tryPostFailedWalkthrough` method, add:

```ts
private async patchCheckRunTerminal(
  octokit: Octokit,
  data: ReviewJobData,
  reviewId: string,
  output: FormatCheckRunOutputInput,
  conclusion: 'success' | 'neutral' | 'skipped',
): Promise<void> {
  const row = this.reviewsRepo.findById(reviewId);
  if (!row?.check_run_id) return;
  const formatted = formatCheckRunOutput(output);
  await this.tryPatchCheckRun({
    octokit,
    owner: data.owner,
    repo: data.repo,
    check_run_id: row.check_run_id,
    conclusion,
    title: formatted.title,
    summary: formatted.summary,
  });
}
```

Import the discriminated union type:

```ts
import { type FormatCheckRunOutputInput } from './helpers';
```

- [x] **Step 2: Call from the MAX_DIFF_BYTES branch**

In the MAX_DIFF_BYTES `if` block, after the existing `tryPostFailedWalkthrough` call:

```ts
await this.patchCheckRunTerminal(
  octokit,
  data,
  reviewId,
  { mode: 'failed', reasonCopy: 'the diff exceeds the byte-size safety cap' },
  'neutral',
);
```

- [x] **Step 3: Call from the MAX_REVIEW_DIFF_LINES branch**

After the existing `upsertWalkthrough(skipBody)` call:

```ts
await this.patchCheckRunTerminal(
  octokit,
  data,
  reviewId,
  { mode: 'skipped', changedLines, limit: this.config.maxReviewDiffLines },
  'skipped',
);
```

- [x] **Step 4: Call from the empty-diff branch**

After `writeStandaloneCompletion(...)` (or the equivalent post-Task-18 markCompleted call):

```ts
await this.patchCheckRunTerminal(
  octokit,
  data,
  reviewId,
  { mode: 'empty-diff' },
  'neutral',
);
```

For symmetry with the spec, also PATCH the walkthrough to the success body with the "no diff" summary. Compose:

```ts
const emptySuccessBody = formatWalkthroughSuccessBody({
  prNodeId: data.pr_node_id,
  reviewId,
  retrievedRulesCount: 0,
  firingRules: [],
  intro: 'No reviewable diff content on this PR.',
  missingChecksPermission: !this.githubAuth.hasChecksPermission(
    data.installation_id,
  ),
});
await this.upsertWalkthrough({
  octokit,
  owner: data.owner,
  repo: data.repo,
  pr_number: data.pr_number,
  pr_node_id: data.pr_node_id,
  body: emptySuccessBody,
});
```

- [x] **Step 5: Call from the agent-loop failure path**

In the `catch (err)` block that runs around `runRealReview`, after the existing `tryPostFailedWalkthrough` call:

```ts
await this.patchCheckRunTerminal(
  octokit,
  data,
  reviewId,
  {
    mode: 'failed',
    reasonCopy: isAnthropicErrorLike(err)
      ? 'the language-model call was rejected'
      : 'an internal error',
  },
  'neutral',
);
```

- [x] **Step 6: Build + smoke test**

```bash
npm run build --workspace apps/api
npm test --workspace apps/api -- reviews.processor
```

Expected: build clean. Tests may need updates in subsequent tasks.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts
git commit -m "feat(reviews): PATCH check-run on size-cap, empty-diff, and failure paths"
```

---

## Task 22: Worker — call summarizer + persist

Implements steps 16-17 of the lifecycle.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`

- [x] **Step 1: Inject the summarizer**

Add to the processor constructor:

```ts
@Inject(WALKTHROUGH_SUMMARIZER)
private readonly summarizer: IWalkthroughSummarizer,
```

And the imports:

```ts
import {
  WALKTHROUGH_SUMMARIZER,
  type IWalkthroughSummarizer,
} from './types/walkthrough-summarizer';
```

- [x] **Step 2: Call the summarizer after a successful `runRealReview`**

In the success branch (after the existing `result = await this.reviewsService.runRealReview(...)`), and BEFORE the walkthrough PATCH:

```ts
// Step 16: summarizer call.
const summary = await this.summarizer.summarize({
  diff,
  findings: sanitizedFindings.map((f) => ({
    rule_id: f.rule_id,
    title: f.title,
    severity: f.severity,
  })),
  retrievedRules: result.retrievedRules.map((r) => ({
    rule_id: r.rule_id,
    source: r.source,
    title: r.title,
  })),
});

// Step 17: persist.
this.reviewsRepo.setWalkthroughSummary(reviewId, summary?.intro ?? null);
```

The `sanitizedFindings` variable already exists from the current processor code (the loop that maps the LLM findings).

- [x] **Step 3: Build**

```bash
npm run build --workspace apps/api
```

Expected: clean.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/reviews/reviews.processor.ts
git commit -m "feat(reviews): call walkthrough summarizer and persist on success"
```

---

## Task 23: Worker — PATCH success walkthrough, POST review, PATCH final check-run

Implements steps 19-21 of the lifecycle. This is the largest worker change: replace today's `formatWalkthroughBody` + `formatReviewBody` call sites with the new shapes.

**Files:**
- Modify: `apps/api/src/modules/reviews/reviews.processor.ts`
- Delete: `apps/api/src/modules/reviews/helpers/format-walkthrough-body.ts`
- Delete: `apps/api/test/modules/reviews/helpers/format-walkthrough-body.spec.ts`
- Modify: `apps/api/src/modules/reviews/helpers/index.ts` (remove the old export)

- [x] **Step 1: Replace the walkthrough PATCH call**

In the success branch (after the summarizer call from Task 22), find the existing block:

```ts
const walkthroughBody = formatWalkthroughBody({ /* ... */ });
```

Replace with:

```ts
const firingRules = computeFiringRules(sanitizedFindings, result.retrievedRules);
const walkthroughBody = formatWalkthroughSuccessBody({
  prNodeId: data.pr_node_id,
  reviewId,
  retrievedRulesCount: result.retrievedRules.length,
  firingRules,
  intro: summary?.intro ?? null,
  missingChecksPermission: !this.githubAuth.hasChecksPermission(
    data.installation_id,
  ),
});
```

Add at the bottom of the file (outside the class):

```ts
function computeFiringRules(
  findings: FindingWithSeverity[],
  retrievedRules: Array<{
    rule_id: string;
    source: string;
    title: string;
    severity: 'error' | 'warning' | 'info';
  }>,
): Array<{
  rule_id: string;
  source: string;
  title: string;
  severity: 'error' | 'warning' | 'info';
}> {
  const firingRuleIds = new Set(findings.map((f) => f.rule_id));
  return retrievedRules.filter((r) => firingRuleIds.has(r.rule_id));
}
```

Update the import in `reviews.processor.ts` to use the new helper:

```ts
import {
  formatWalkthroughSuccessBody,
  // ... existing helper imports
} from './helpers';
```

And remove the old `formatWalkthroughBody` from the import list.

- [x] **Step 2: Replace the review body call**

Find the existing block:

```ts
const reviewBody = formatReviewBody({ reviewId, counts, hasOutsideDiff });
```

Replace with:

```ts
const reviewBody = formatReviewBody({
  reviewId,
  counts,
  retrievedRulesCount: result.retrievedRules.length,
  outsideDiff: partition.outsideDiff,
});
```

- [x] **Step 3: Gate the review POST on `total > 0 OR outsideDiff > 0`**

Find the existing `if (sanitizedFindings.length > 0)` and change to:

```ts
const shouldPostReview =
  sanitizedFindings.length > 0 || partition.outsideDiff.length > 0;
if (shouldPostReview) {
  // ... existing review POST code ...
}
```

This closes the "0 inline but N outside-diff" gap.

- [x] **Step 4: Add the terminal check-run PATCH**

After the review POST block (whether or not it executed), get the walkthrough comment URL from the cached id and PATCH the check-run:

```ts
const walkthroughCommentId = this.pullRequestsRepo.getWalkthroughCommentId(
  data.pr_node_id,
);
const walkthroughUrl = walkthroughCommentId
  ? `https://github.com/${data.owner}/${data.repo}/pull/${data.pr_number}#issuecomment-${walkthroughCommentId}`
  : `https://github.com/${data.owner}/${data.repo}/pull/${data.pr_number}`;

await this.patchCheckRunTerminal(
  octokit,
  data,
  reviewId,
  {
    mode: 'success',
    findingsCount: sanitizedFindings.length,
    retrievedRulesCount: result.retrievedRules.length,
    walkthroughCommentUrl: walkthroughUrl,
    counts,
  },
  'neutral',
);
```

The check-run PATCH is NOT tolerated. If it throws, the existing try/catch must convert it to `markFailed(reviewId, { error_code: 'check_run_patch_failed' })` and throw `UnrecoverableError`. Wrap the PATCH call in its own try/catch to do so:

```ts
try {
  await this.patchCheckRunTerminal(/* ... */);
} catch (err) {
  this.reviewsRepo.markFailed(reviewId, {
    completed_at: new Date(),
    error_status: readStatus(err),
    error_code: 'check_run_patch_failed',
  });
  throw new UnrecoverableError(formatBriefError(err));
}
```

(Note: `tryPatchCheckRun` swallows errors. For the terminal step, we want a *throwing* variant. Either add a `patchCheckRunTerminalStrict` private method, or change `patchCheckRunTerminal` to rethrow when called from the terminal path. Easiest: inline the call in the terminal PATCH and let it throw.)

Replace the `try { ... patchCheckRunTerminal ... } catch ...` block with:

```ts
const row = this.reviewsRepo.findById(reviewId);
if (row?.check_run_id) {
  const output = formatCheckRunOutput({
    mode: 'success',
    findingsCount: sanitizedFindings.length,
    retrievedRulesCount: result.retrievedRules.length,
    walkthroughCommentUrl: walkthroughUrl,
    counts,
  });
  try {
    await octokit.rest.checks.update({
      owner: data.owner,
      repo: data.repo,
      check_run_id: row.check_run_id,
      status: 'completed',
      conclusion: 'success',
      output,
    });
  } catch (err) {
    this.reviewsRepo.markFailed(reviewId, {
      completed_at: new Date(),
      error_status: readStatus(err),
      error_code: 'check_run_patch_failed',
    });
    throw new UnrecoverableError(formatBriefError(err));
  }
}
```

- [x] **Step 5: Delete the old walkthrough body files**

```bash
rm apps/api/src/modules/reviews/helpers/format-walkthrough-body.ts
rm apps/api/test/modules/reviews/helpers/format-walkthrough-body.spec.ts
```

Remove from `apps/api/src/modules/reviews/helpers/index.ts`:

```ts
// Delete this line:
export { formatWalkthroughBody, ... } from './format-walkthrough-body';
```

- [x] **Step 6: Build + run all tests**

```bash
npm run build --workspace apps/api
npm test --workspace apps/api
```

Expected: build clean, test suite green except for processor e2e tests that assert old behaviour (those get updated in Tasks 24-30).

- [x] **Step 7: Commit**

```bash
git add -A apps/api/src/modules/reviews apps/api/test/modules/reviews
git commit -m "feat(reviews): redirect worker to new success body, gated review, terminal check-run PATCH"
```

---

## Task 24: Update `docs/setup/github-app.md` with Checks permission

**Files:**
- Modify: `docs/setup/github-app.md`

- [x] **Step 1: Add `Checks` to the permissions table**

Find the table:

```markdown
| Permission | Access |
|---|---|
| **Pull requests** | Read & write |
| **Contents** | Read-only |
| **Metadata** | Read-only (this one is mandatory and auto-checked) |
```

Replace with:

```markdown
| Permission | Access |
|---|---|
| **Pull requests** | Read & write |
| **Contents** | Read-only |
| **Checks** | Read & write |
| **Metadata** | Read-only (this one is mandatory and auto-checked) |
```

Update the paragraph below to mention Checks:

```markdown
Pull-requests "write" is required for posting review comments. Contents "read" is required when the worker fetches the diff via Octokit. Checks "write" is required for posting the merge-box status check that shows the bot's lifecycle state (in_progress / skipped / completed) — without it the bot still works, but the check badge will be absent.
```

- [x] **Step 2: Add an upgrade note for existing installations**

Add a new section before `### Subscribe to events`:

```markdown
### Upgrading an existing installation

If you previously installed this App before the `Checks` permission
was added, GitHub will show a yellow banner on the App settings page
asking you to accept the new permissions. The bot continues to
post the walkthrough and review comments without the Checks
permission, but the merge-box badge will be absent until accepted.
The accept flow is a single click in your installation's settings.
```

- [x] **Step 3: Commit**

```bash
git add docs/setup/github-app.md
git commit -m "docs(setup): document Checks permission and existing-install upgrade"
```

---

## Task 25: E2E — in-progress surfaces fire after row insert

**Files:**
- Modify: `apps/api/test/modules/reviews/reviews.processor.e2e-spec.ts`

- [x] **Step 1: Add a test that asserts ordering**

```ts
it('inserts the review row BEFORE posting the in-progress check-run and walkthrough', async () => {
  const calls: string[] = [];
  const octokit = mockOctokit({
    onCall: (path: string) => calls.push(path),
  });
  // Stub the insert by spying on the repo
  const insertSpy = jest.spyOn(reviewsRepo, 'insertInProgress');

  await processor.process(jobFixture({ pr_node_id: 'PR_x' }));

  // The insert must run before the check-run POST and the walkthrough POST.
  const insertIdx = insertSpy.mock.invocationCallOrder[0];
  const checkPostIdx = calls.indexOf('POST /repos/.../check-runs');
  const walkthroughPostIdx = calls.indexOf(
    'POST /repos/.../issues/:n/comments',
  );
  expect(insertIdx).toBeLessThan(checkPostIdx);
  expect(checkPostIdx).toBeLessThan(walkthroughPostIdx);
});
```

(The exact `path` strings depend on the existing mockOctokit harness; the spec keeps the intent independent of the harness shape.)

- [x] **Step 2: Run, confirm passes**

```bash
npm test --workspace apps/api -- reviews.processor.e2e-spec
```

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add apps/api/test/modules/reviews/reviews.processor.e2e-spec.ts
git commit -m "test(reviews): e2e — in-progress surfaces fire after row insert"
```

---

## Task 26: E2E — success path PATCHes walkthrough → review → check-run

- [x] **Step 1: Add a test**

```ts
it('success path: walkthrough PATCH → review POST → check-run PATCH', async () => {
  const callOrder: string[] = [];
  const octokit = mockOctokit({
    onCall: (path: string, method: string) => callOrder.push(`${method} ${path}`),
  });
  // Stub runRealReview to return a single finding
  jest.spyOn(reviewsService, 'runRealReview').mockResolvedValue({
    review_id: 'r1',
    status: 'completed',
    findings: [fingerFixture({ rule_id: 'no-secret-in-log' })],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    model: 'm',
    prompt_version: 'v4',
    turn_count: 1,
    tool_calls: [],
    retrievedRules: [{ rule_id: 'no-secret-in-log', source: 'a.json', title: 'No secrets', severity: 'error' }],
  });

  await processor.process(jobFixture());

  const walkthroughPatchIdx = callOrder.findIndex((c) =>
    c.startsWith('PATCH ') && c.includes('/issues/comments/'),
  );
  const reviewPostIdx = callOrder.findIndex((c) =>
    c.includes('/pulls/') && c.includes('/reviews'),
  );
  const checkPatchIdx = callOrder.findIndex((c) =>
    c.startsWith('PATCH ') && c.includes('/check-runs/'),
  );

  expect(walkthroughPatchIdx).toBeLessThan(reviewPostIdx);
  expect(reviewPostIdx).toBeLessThan(checkPatchIdx);
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — success path ordering walkthrough → review → check-run"
```

---

## Task 27: E2E — sweep PATCHes a prior leaked check-run

- [x] **Step 1: Add a test**

```ts
it('sweep: a prior completed reviews row with check_run_id gets PATCHed before the new check-run is posted', async () => {
  // Seed the DB with a prior completed row that has a check_run_id
  reviewsRepo.insertInProgress({
    id: 'prior-id',
    pr_node_id: 'PR_x',
    model: 'm',
    created_at: new Date(Date.now() - 10_000),
  });
  reviewsRepo.markCompleted('prior-id', {
    completed_at: new Date(Date.now() - 9_000),
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    turn_count: 1,
    tool_calls: [],
    hallucinated_finding_count: 0,
    cache_hit_count: 0,
    model: 'm',
  });
  reviewsRepo.setCheckRunId('prior-id', 999);

  const patchCalls: number[] = [];
  const octokit = mockOctokit({
    onPatchCheckRun: (id: number) => patchCalls.push(id),
  });

  await processor.process(jobFixture({ pr_node_id: 'PR_x' }));

  expect(patchCalls).toContain(999);
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — sweep PATCHes prior leaked check-run"
```

---

## Task 28: E2E — 403 on check-run POST degrades gracefully

- [x] **Step 1: Add a test**

```ts
it('403 on check-run POST: marks installation, walkthrough carries permission-pending copy, no throw', async () => {
  const octokit = mockOctokit({
    checkRunCreate: () => {
      const err = new Error('Forbidden');
      (err as any).status = 403;
      throw err;
    },
  });

  await expect(
    processor.process(jobFixture({ installation_id: 999 })),
  ).resolves.not.toThrow();

  expect(githubAuth.hasChecksPermission(999)).toBe(false);

  // Verify the in-progress walkthrough body carried the permission-pending line
  const lastUpsertBody = lastWalkthroughBody();
  expect(lastUpsertBody).toMatch(/merge-box status badge is unavailable/);

  // No check_run_id on the row
  const row = reviewsRepo.findById(currentReviewId());
  expect(row?.check_run_id).toBeNull();
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — 403 on check-run POST degrades gracefully"
```

---

## Task 29: E2E — summarizer failure degrades the walkthrough

- [x] **Step 1: Add a test**

```ts
it('summarizer failure: walkthrough_summary persisted as null, walkthrough renders no prose section', async () => {
  jest.spyOn(summarizer, 'summarize').mockResolvedValue(null);

  await processor.process(jobFixture());

  const row = reviewsRepo.findById(currentReviewId());
  expect(row?.walkthrough_summary).toBeNull();

  // The success walkthrough body should NOT contain "### Summary"
  const finalBody = lastWalkthroughBody();
  expect(finalBody).not.toContain('### Summary');
  // But it should still contain the KB banner
  expect(finalBody).toMatch(/Reviewed against your team's knowledge base/);
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — summarizer failure degrades walkthrough"
```

---

## Task 30: E2E — outside-diff-only review still posts

- [x] **Step 1: Add a test**

```ts
it('outside-diff with zero anchorable findings: review event still posts with CAUTION callout', async () => {
  // Stub the agent loop to produce a single finding whose location_hint
  // anchors OUTSIDE the diff
  jest.spyOn(reviewsService, 'runRealReview').mockResolvedValue({
    /* ... a finding whose location_hint cannot be anchored to the diff hunks ... */
  } as any);
  // Stub the diff to be small enough that anchorFindingsToDiff partitions
  // the finding into outsideDiff

  const reviewPostSpy = jest.fn();
  const octokit = mockOctokit({ onCreateReview: reviewPostSpy });

  await processor.process(jobFixture());

  expect(reviewPostSpy).toHaveBeenCalledTimes(1);
  const postedBody = reviewPostSpy.mock.calls[0][0].body;
  expect(postedBody).toContain('> [!CAUTION]');
  expect(postedBody).toContain('Outside diff range comments (1)');
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — outside-diff-only review still posts"
```

---

## Task 31: E2E — size-cap and empty-diff skip paths

- [x] **Step 1: Add tests for both skip variants**

```ts
it('size-cap skip: walkthrough PATCH (skipped body), check-run PATCH (skipped), no review POST, no analyzeDiff', async () => {
  const reviewPostSpy = jest.fn();
  const analyzeSpy = jest.spyOn(llmReviewer, 'analyzeDiff');
  const octokit = mockOctokit({
    diff: buildDiffWithChangedLines(2000), // above MAX_REVIEW_DIFF_LINES default
    onCreateReview: reviewPostSpy,
  });

  await processor.process(jobFixture());

  expect(analyzeSpy).not.toHaveBeenCalled();
  expect(reviewPostSpy).not.toHaveBeenCalled();
  expect(lastWalkthroughBody()).toMatch(/review skipped/i);
  expect(lastCheckRunPatch()?.conclusion).toBe('skipped');
});

it('empty-diff: walkthrough PATCH (success body, "no reviewable diff"), check-run PATCH (skipped), no review POST', async () => {
  const reviewPostSpy = jest.fn();
  const octokit = mockOctokit({ diff: '', onCreateReview: reviewPostSpy });

  await processor.process(jobFixture());

  expect(reviewPostSpy).not.toHaveBeenCalled();
  expect(lastWalkthroughBody()).toMatch(/No reviewable diff content/);
  expect(lastCheckRunPatch()?.conclusion).toBe('skipped');
  expect(lastCheckRunPatch()?.output?.title).toMatch(/No diff to review/);
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS, both cases.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — size-cap and empty-diff skip paths"
```

---

## Task 32: E2E — agent-loop failure path

- [x] **Step 1: Add the test**

```ts
it('agent-loop failure: walkthrough PATCH (failed body), check-run PATCH (skipped), error_code persisted', async () => {
  jest
    .spyOn(reviewsService, 'runRealReview')
    .mockRejectedValue(new LlmRequestError('rate limited', { status: 429 }));

  await expect(processor.process(jobFixture())).rejects.toThrow();

  expect(lastWalkthroughBody()).toMatch(
    /tried to check this PR against your knowledge base but did not finish/,
  );
  expect(lastCheckRunPatch()?.conclusion).toBe('skipped');
  expect(lastCheckRunPatch()?.output?.title).toMatch(
    /Review could not complete/,
  );
  const row = reviewsRepo.findById(currentReviewId());
  expect(row?.status).toBe('failed');
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — agent-loop failure patches walkthrough and check-run"
```

---

## Task 33: E2E — BullMQ retry idempotence

- [x] **Step 1: Add the test**

```ts
it('BullMQ retry: the second attempt PATCHes the existing check_run_id rather than POSTing a new one', async () => {
  // First attempt: agent loop fails AFTER the check-run was POSTed.
  let checkPostCalls = 0;
  let checkPatchCalls = 0;
  const octokit = mockOctokit({
    checkRunCreate: () => {
      checkPostCalls++;
      return { data: { id: 4242 } };
    },
    checkRunUpdate: () => {
      checkPatchCalls++;
      return { data: {} };
    },
  });
  jest
    .spyOn(reviewsService, 'runRealReview')
    .mockRejectedValueOnce(new Error('transient'));

  await expect(processor.process(jobFixture())).rejects.toThrow();

  expect(checkPostCalls).toBe(1);

  // Simulate the BullMQ retry: a fresh job with the same data, but the
  // prior row was marked `failed`. The sweep at step 7 should PATCH 4242,
  // and a NEW check-run should be POSTed for the new reviewId.
  jest.spyOn(reviewsService, 'runRealReview').mockResolvedValueOnce({
    review_id: 'r2',
    status: 'completed',
    findings: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    model: 'm',
    prompt_version: 'v4',
    turn_count: 1,
    tool_calls: [],
    retrievedRules: [],
  });

  await processor.process(jobFixture());

  // Sweep should PATCH the prior 4242; new C-POST for the new attempt.
  expect(checkPatchCalls).toBeGreaterThanOrEqual(2); // sweep PATCH + terminal PATCH
  expect(checkPostCalls).toBe(2);
});
```

- [x] **Step 2: Run, confirm passes**

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git commit -am "test(reviews): e2e — BullMQ retry idempotence on check-run"
```

---

## Final review checklist (post-implementation)

Before opening the PR:

- [x] **Run the full suite:** `npm test --workspace apps/api`. All tests pass.
- [x] **Type check:** `npm run build --workspace apps/api`. Clean.
- [x] **Grep for stale references:** `grep -rn "formatWalkthroughBody" apps/api/src apps/api/test`. Empty (the old name is gone).
- [x] **Grep for the workflow-tooling tokens** in committed paths, per the repo rule: `grep -rn -i "claude\|anthropic" apps/api/src docs/plans/10-*.md | grep -v node_modules`. The only acceptable matches are runtime SDK imports (`@anthropic-ai/sdk`) and runtime-dependency references in setup docs.
- [x] **Update the operator runbook** (`docs/setup/real-pr-smoke.md`) with a note about the new merge-box check and how to verify it.
- [x] **Manual smoke**: push a small PR to the test repo, watch the merge box show in-progress → ✓, click the check, confirm the summary text and URL. Verify the walkthrough body shows the KB banner. Verify the review body shows the counts and (if any) outside-diff CAUTION callout.

If the smoke surfaces unexpected behavior, write a regression test FIRST in `reviews.processor.e2e-spec.ts`, then fix.
