# Fixture diffs

Hand-curated unified-diff fixtures used by:

- `test/modules/embeddings/embeddings.e2e-spec.ts` — retrieval quality gate (top-K must contain the expected `rule_id`).
- `test/modules/reviews/reviews.e2e-spec.ts` — end-to-end LLM review loop (the stub `ILlmReviewer` only emits findings whose `rule_id` is in the retrieved set, so a fixture that produces zero findings fails this gate).
- `npm run query:rules` / `npm run review:dry-run` — manual smoke from the CLI.

Each `.patch` file is a self-contained unified diff that violates **one** rule from the seeded corpus (`apps/api/seeds/*.json`). Files are kept small (under ~100 lines) so the e2e suite stays fast.

| Fixture | Violates rule(s) | Source |
| --- | --- | --- |
| `eqeqeq-violation.patch` | `eqeqeq` (airbnb-eslint) | Synthetic — fictional checkout flow that swaps `===` for `==`. |
| `no-var-violation.patch` | `no-var` (airbnb-eslint) | Synthetic — small totalizer rewrites `let`/`const` as `var`. |
| `max-lines-violation.patch` | `max-lines-per-function` (airbnb-eslint) | Synthetic — `processOrder` grows from 3 lines to ~70 lines inline. |
| `prefer-const-violation.patch` | `prefer-const` (airbnb-eslint) | Synthetic — `calculateTotal` rewrites `const` bindings as `let` even though nothing is reassigned. The trailing comment makes the violation explicit so the LLM has signal without depending on flow analysis. |
| `co-authored-by-claude-violation.patch` | `no-co-authored-by-claude` (team-standards) | Synthetic — a `CHANGELOG.md` entry includes the prohibited `Co-Authored-By: Claude` trailer plus the "🤖 Generated with..." marker, and a release script edit deliberately preserves the trailer. |
| `thin-controllers-violation.patch` | `thin-controllers`, `no-crud-on-database-service`, `repository-pattern`, `config-service-only` (team-standards) | Synthetic — `OrdersController` inlines business logic, calls `DatabaseService.drizzle.insert(...)` directly, constructs a Stripe client inside the controller, and bypasses the repository pattern. Multi-rule violation by design so the e2e can exercise multi-finding output. |

## Conventions

- **Self-contained.** Each diff must compile mentally on its own — fake file paths and SHAs are fine, real ones are not required.
- **Synthetic, not real OSS.** The original plan called these "OSS PR diffs" but real PR text introduces attribution and licensing concerns. Synthetic diffs that *look* like realistic refactors hit the same retrieval signal and the same LLM review behavior, without the noise.
- **One primary violation per file** unless the fixture is specifically there to exercise multi-rule output (currently only `thin-controllers-violation.patch`).
- **Keep the rule comment near the violation.** A small explicit comment ("Removed the filter line above.", "All of … should be `const`.") is allowed and intentional — it gives the LLM stronger signal in the stub-LLM e2e where retrieval and LLM are both deterministic stubs. Real-API smoke would pick up the violation without the hint, but the offline e2e is meant to be deterministic.

## Adding a fixture

1. Pick a `rule_id` from `apps/api/seeds/*.json`.
2. Write a small synthetic diff that violates it. The diff itself must be enough signal — the embedding stub in `embeddings.e2e-spec.ts` is a bag-of-words, so include the rule's vocabulary verbatim where possible.
3. Add a row to the table above.
4. Add the fixture's filename and expected `rule_id` to both:
   - `embeddings.e2e-spec.ts` (the retrieval gate).
   - `reviews.e2e-spec.ts` (the LLM review gate — exercised through the stub `ILlmReviewer`).
5. Run `npm test --workspace apps/api`. If the fixture produces zero findings or the wrong rule, the gate fails and the fixture needs more signal.
