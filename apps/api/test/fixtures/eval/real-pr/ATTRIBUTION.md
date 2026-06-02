# Real-PR sample attribution

These are **synthetic representative samples** modeled after common
open-source PR patterns. They are not verbatim copies of any specific
public repository's code or pull requests.

The diffs are designed to exercise the reviewer against realistic
code-change patterns found in permissively-licensed JavaScript/TypeScript
projects, while avoiding any licensing concerns.

## Samples

### real-pr-express-middleware.patch

- **Pattern modeled after:** Express.js middleware authentication PRs
  (common in MIT-licensed Node.js projects)
- **Description:** Expands an auth middleware with role checking and
  token validation. Introduces `var` declarations (violating `no-var`)
  and loose equality checks (violating `eqeqeq`).
- **Expected violations:** `no-var`, `eqeqeq`

### real-pr-react-form-handler.patch

- **Pattern modeled after:** React form component PRs in frontend
  applications (common in MIT-licensed React projects)
- **Description:** Grows a simple form into a large inline handler with
  validation, API calls, and error handling all in one function.
  Introduces `var` declarations (violating `no-var`), loose equality
  (violating `eqeqeq`), and a function body well over the
  max-lines-per-function threshold.
- **Expected violations:** `no-var`, `eqeqeq`, `max-lines-per-function`

### real-pr-utility-refactor.patch

- **Pattern modeled after:** Utility module expansion PRs in
  full-stack JavaScript projects (common in MIT/Apache 2.0 codebases)
- **Description:** Refactors and extends formatter utilities with new
  functions. Uses `let` for bindings that are never reassigned (violating
  `prefer-const`) and loose equality in a conditional (violating
  `eqeqeq`).
- **Expected violations:** `prefer-const`, `eqeqeq`

## In-repo PR samples (verbatim, not synthetic)

The two fixtures below are extracted verbatim from this repository's
own git history. They exist because the synthetic samples above test
contrived patterns, while these test the reviewer against actual diffs
it failed (or would be expected to succeed) on during dogfood smokes.

### real-pr-pr11-voyage-clean.patch

- **Source:** PR #11 (squash commit `e7b06aa`), `apps/api/src/infrastructure/voyage/voyage-embedding.provider.ts`
- **Description:** Expands the Voyage embedding provider with batching,
  retry handling, and a `VoyageRequestError` class. Net +92 / -26 lines.
  Reads its API key via `ConfigService` injection (no `process.env` direct
  reads anywhere in the changed surface).
- **Expected violations:** none (`[]`)
- **What this tests:** **precision on a real clean diff.** During the
  PR #11 dogfood smoke (2026-06-02), the reviewer hallucinated a
  `config-service-only` finding on this exact file, claiming it reads
  `process.env.VOYAGE_API_KEY` directly. It does not. This fixture
  reproduces the precision failure surface in a tractable size.

### real-pr-day5-queue-process-env.patch

- **Source:** Day-5 PR #9 (squash commit `70b96f2`),
  `apps/api/src/infrastructure/queue/queue.module.ts`
- **Description:** Introduces the BullMQ-backed `QueueModule` with a
  `SKIP_REDIS_PROBE` test escape hatch read directly via
  `process.env.SKIP_REDIS_PROBE` instead of through `ConfigService`.
  Net +195 lines (whole file).
- **Expected violations:** `config-service-only`
- **What this tests:** **recall on a real violating diff** in this
  repo's own codebase. The violation is the introduction of a direct
  `process.env` read where the project's `CLAUDE.md` rule
  (`config-service-only`) requires the typed gateway.

## Why synthetic?

The Day-6 plan defers the specific selection of real public PRs to
implementation time (see "Open Questions > Deferred to Implementation").
Synthetic samples that faithfully represent the *shape* of real-world
PRs avoid:

1. **License ambiguity** -- no need to verify that a specific repo's
   license permits redistribution of diff fragments.
2. **Contamination risk** -- synthetic diffs are guaranteed to not be
   PRs the reviewer was tuned against.
3. **Stability** -- real PRs can be edited or deleted; synthetic samples
   are self-contained and permanent.

These samples are held-out (`gates: false`) and do not affect the
deterministic gating F1. They provide independent external-validity
evidence reported under a separate heading in the eval summary.
