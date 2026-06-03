# Contributing

This is a personal project maintained solo. Contributions are welcome on focused, well-scoped changes. For anything larger than a bugfix or small improvement, open an issue first so we can agree on scope before code is written — it avoids the situation where a PR lands fully-formed but points in a direction that does not fit.

## Getting set up

Follow the Quickstart in `README.md` to get the API and dashboard running locally.

## Project conventions

`CLAUDE.md` documents the directory contract for this codebase: the three-tier structure (`src/modules/` for feature code, `src/infrastructure/` for technical adapters, `src/system/` for ops endpoints), the repository pattern and where interfaces vs. implementations live, naming suffixes, path aliases, and the quick-reference table for where new code goes.

Before opening a PR that adds files, skim `CLAUDE.md` — it documents the directory contract and the questions ("which tier does this go in?", "does this need a repository?") the codebase expects new contributions to have answered.

## Before opening a PR

- `npm test --workspace apps/api` passes cleanly.
- `npx tsc --noEmit` is clean in both `apps/api` and `apps/web`.
- No new `process.env.X` reads outside `ConfigService` (`src/config/config.service.ts`).
- New persistent entities have a repository interface + Symbol token in `src/modules/<owner>/types/` and a concrete Drizzle-backed implementation in `src/infrastructure/db/repositories/`.
- New env vars are added as typed properties on `ConfigService` with fail-fast validation, not read ad-hoc from `process.env`.

## What is likely to be accepted vs. not

Likely to be accepted without prior discussion:

- Bug fixes with a clear reproducer.
- Documentation improvements or corrections.
- Additions to the seeded rule corpus in `apps/api/seeds/`.
- Performance fixes in the retrieval pipeline or the reviewer agent loop.
- Dashboard improvements that stay within the existing design direction.

Less likely to be accepted without prior discussion:

- Large architectural changes (new tiers, restructured module boundaries).
- Swapping the LLM provider abstraction or the vector store.
- Changes that require a force-push or history rewrite on `main`.

None of those are automatic rejections — open an issue first and the answer will be direct.

## Reporting bugs and proposing features

Open an issue using one of the templates in `.github/ISSUE_TEMPLATE/`. For security issues, see `SECURITY.md` instead.
