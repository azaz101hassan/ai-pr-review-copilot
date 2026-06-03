# Security Policy

## Supported versions

This project has no formal release versioning; only `main` is supported.

## Reporting a vulnerability

The preferred route is a GitHub Security Advisory:
**https://github.com/azaz101hassan/ai-pr-review-copilot/security/advisories/new**

If you cannot use GitHub's advisory flow, email **azaz101hassan@gmail.com** with the subject line `[SECURITY] ai-pr-review-copilot`.

In either case, include:

- A clear description of the vulnerability and the affected component.
- Reproduction steps — the minimum sequence of actions or inputs that trigger the issue.
- Any proof-of-concept code, payload, or log output you have.

Please do not open a public issue for a security report.

## What you can expect

This is a solo project. Acknowledgment within 72 hours of receipt; an investigation timeline and planned fix communicated in the first reply. No SLA beyond that — a realistic estimate is more useful than a number that cannot be kept.

## Scope

In scope:

- The bot's webhook handler, including HMAC-SHA256 signature verification (`src/guards/signature-verification.guard.ts`).
- Secrets handling — env var loading, any path where a key or token could be logged or leaked.
- Prompt-injection paths into the agent review loop (`src/modules/reviews/`).
- The retrieval pipeline and any path where user-controlled diff content reaches stored queries or external APIs beyond the intended scope.
- The dashboard's authentication surface when one is added.

The repository currently has no public deployment. Scope is the code itself, not a hosted service.

## Out of scope

- Third-party dependency CVEs without a working exploit path through this codebase's actual call sites.
- Social engineering.
- Denial-of-service via large PR diffs — the size gate (`MAX_REVIEW_DIFF_LINES`) is the intended defense; bypassing the gate is in scope, but exhausting compute through normal large PRs is not.
- Reports produced by automated scanners without a human-verified reproducer.
