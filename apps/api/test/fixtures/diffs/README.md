# Fixture diffs

Hand-curated unified-diff fixtures used by:

- `test/modules/embeddings/embeddings.e2e-spec.ts` — retrieval quality gate (top-K must contain the expected `rule_id`). Day-3 retrieval-only fixtures live here.
- `test/modules/reviews/reviews.e2e-spec.ts` — end-to-end LLM review loop (the stub `ILlmReviewer` only emits findings whose `rule_id` is in the retrieved set, so a fixture that produces zero findings fails this gate).
- `npm run query:rules` / `npm run review:dry-run` — manual smoke from the CLI.

There are now **two categories** of fixture:

1. **Retrieval-only `.patch` fixtures (Day-3 shape).** A self-contained
   diff that violates one rule from the seeded corpus
   (`apps/api/seeds/*.json`). Wired into BOTH `embeddings.e2e-spec.ts`
   and `reviews.e2e-spec.ts`. The diff itself must carry enough
   vocabulary signal for the bag-of-words retrieval to find the right
   rule.

2. **`.repo/`-backed agent-loop fixtures (Day-4 shape).** A `.patch`
   file plus a co-located `<fixture>.repo/` directory holding the
   surrounding source the agent loop fetches via
   `FilesystemRepoContextProvider`. These fixtures exercise the
   multi-turn `tool_use` path — the agent has to call
   `fetch_related_file` / `fetch_function_definition` /
   `fetch_prior_review` to assemble the context needed to produce a
   finding. They are **exempt from the
   `embeddings.e2e-spec.ts` retrieval gate** (the violation pattern
   lives across multiple files, not in a single diff) and are wired
   only into the scenario-specific describes in `reviews.e2e-spec.ts`
   (AE1, AE1b, AE2 in the Day-4 plan).

| Fixture | Category | Violates rule(s) | Source |
| --- | --- | --- | --- |
| `eqeqeq-violation.patch` | retrieval-only | `eqeqeq` (airbnb-eslint) | Synthetic — fictional checkout flow that swaps `===` for `==`. |
| `no-var-violation.patch` | retrieval-only | `no-var` (airbnb-eslint) | Synthetic — small totalizer rewrites `let`/`const` as `var`. |
| `max-lines-violation.patch` | retrieval-only | `max-lines-per-function` (airbnb-eslint) | Synthetic — `processOrder` grows from 3 lines to ~70 lines inline. |
| `prefer-const-violation.patch` | retrieval-only | `prefer-const` (airbnb-eslint) | Synthetic — `calculateTotal` rewrites `const` bindings as `let` even though nothing is reassigned. The trailing comment makes the violation explicit so the LLM has signal without depending on flow analysis. |
| `co-authored-by-claude-violation.patch` | retrieval-only | `no-co-authored-by-claude` (team-standards) | Synthetic — a `CHANGELOG.md` entry includes the prohibited `Co-Authored-By: Claude` trailer plus the "🤖 Generated with..." marker, and a release script edit deliberately preserves the trailer. |
| `thin-controllers-violation.patch` | retrieval-only | `thin-controllers`, `no-crud-on-database-service`, `repository-pattern`, `config-service-only` (team-standards) | Synthetic — `OrdersController` inlines business logic, calls `DatabaseService.drizzle.insert(...)` directly, constructs a Stripe client inside the controller, and bypasses the repository pattern. Multi-rule violation by design so the e2e can exercise multi-finding output. |
| `silent-signature-change.patch` + `silent-signature-change.repo/` | agent-loop | `no-param-reassign` (closest retrieval match) | Day-4 — adds an `idempotencyKey` arg to ONE of five `chargeCard` call sites. The other four (three in `checkout.js`, one in `retry-queue.js`) are unchanged; the inconsistency is only visible when the agent fetches both files. |
| `dismissed-eqeqeq-rerun.patch` + `dismissed-eqeqeq-rerun.repo/` | agent-loop | `eqeqeq` (airbnb-eslint) | Day-4 — re-applies an `eqeqeq` violation at a location that `.repo/reviews.json` records as previously dismissed by the team. The agent must call `fetch_prior_review`, observe the `dismissed_at` timestamp, and emit zero findings. |

## Conventions

- **Self-contained.** Each diff must compile mentally on its own — fake file paths and SHAs are fine, real ones are not required.
- **Synthetic, not real OSS.** The original plan called these "OSS PR diffs" but real PR text introduces attribution and licensing concerns. Synthetic diffs that *look* like realistic refactors hit the same retrieval signal and the same LLM review behavior, without the noise.
- **One primary violation per file** unless the fixture is specifically there to exercise multi-rule output (currently only `thin-controllers-violation.patch`).
- **Keep the rule comment near the violation.** A small explicit comment ("Removed the filter line above.", "All of … should be `const`.") is allowed and intentional — it gives the LLM stronger signal in the stub-LLM e2e where retrieval and LLM are both deterministic stubs. Real-API smoke would pick up the violation without the hint, but the offline e2e is meant to be deterministic.

## Adding a fixture

### Retrieval-only `.patch` fixture (Day-3 shape)

1. Pick a `rule_id` from `apps/api/seeds/*.json`.
2. Write a small synthetic diff that violates it. The diff itself must be enough signal — the embedding stub in `embeddings.e2e-spec.ts` is a bag-of-words, so include the rule's vocabulary verbatim where possible.
3. Add a row to the table above with category `retrieval-only`.
4. Add the fixture's filename and expected `rule_id` to BOTH:
   - `embeddings.e2e-spec.ts` (the retrieval gate).
   - `reviews.e2e-spec.ts` (the LLM review gate — exercised through the stub `ILlmReviewer`).
5. Run `npm test --workspace apps/api`. If the fixture produces zero findings or the wrong rule, the gate fails and the fixture needs more signal.

### `.repo/`-backed agent-loop fixture (Day-4 shape)

1. Decide the multi-turn pattern the fixture demonstrates (e.g., signature change across files, prior-review dismissal).
2. Create the `.patch` and a sibling `<name>.repo/` directory.
3. Populate `.repo/src/...` with the surrounding source files the agent needs to fetch. If the fixture exercises `fetch_prior_review`, drop a `reviews.json` array at the root of `.repo/` with `PriorReviewEntry`-shaped objects (see `src/modules/reviews/types/repo-context-provider.ts`).
4. Add a row to the table above with category `agent-loop`.
5. **Do NOT add it to `embeddings.e2e-spec.ts`** — the violation lives across multiple files; the retrieval gate isn't the right contract.
6. Wire it into the relevant Day-4 AE describe in `reviews.e2e-spec.ts` (AE1, AE1b, AE2, …).
7. Run `npm test --workspace apps/api`.
