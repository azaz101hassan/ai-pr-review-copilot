# Plan 01 — AI PR Review Copilot (Baseline)

**Status:** Not started. Ready for Day 1.
**Created:** 2026-05-24
**Target ship date:** 2026-06-03 (10 sprint-mode days)

---

## Goal

Build a production-quality RAG + agentic LLM system that reviews GitHub pull requests against a team knowledge base. The system should detect violations of coding standards, suggest fixes, and post structured review comments back to the PR.

---

## Why This Project (vs. Alternatives Considered)

| Alternative | Rejected because |
|---|---|
| GRC document Q&A | Sample data hard to find at quality; demo less viscerally clear |
| Code documentation assistant | Generic, doesn't combine RAG + Agents naturally |
| Restaurant menu / order assistant | Domain too narrow for showcasing engineering depth |
| **AI PR Review Copilot ✓** | **Combines RAG + Agents in one coherent system; trivially demoable on any public PR; sample data is infinite (every public GitHub repo); maps to recognized product category (CodeRabbit, Greptile, Diamond)** |

---

## Stack (decided)

| Layer | Choice | Rationale |
|---|---|---|
| **LLM** | Anthropic Claude (Sonnet for analysis, Opus for synthesis) | Strong reasoning, prompt caching, generous free tier |
| **Vector DB** | Chroma (local, free) | Fastest setup, zero cost during build. Can migrate to Pinecone if scale-demo needed. |
| **Backend** | Node.js + NestJS | Well-suited for webhook handling and service composition |
| **Frontend** | Next.js | Fast deploy on Vercel, React ecosystem |
| **GitHub Integration** | GitHub App + Octokit + webhooks | Standard pattern, well-documented |
| **Hosting** | Vercel (frontend) + Railway/Fly (backend) | Both have generous free tiers |
| **Evaluation** | Ragas | Industry-standard RAG evaluation framework |
| **Observability** | Custom dashboard + logging (token cost, latency, hallucination flags) | Lightweight, demo-able |

---

## Open Decisions (resolve at start of next session)

1. **Backend framework** — proposed: **NestJS**. Alternatives: Hono (lighter), Express (simpler).
2. **Public vs private GitHub repo** — proposed: **public from Day 1** so commit history is visible. Alt: private until Day 5 MVP.
3. **Sample knowledge base seed** — Airbnb ESLint config + sample team standards file, or scrape from a real public team's PR template?

---

## 10-Day Sprint Plan

### Day 1 — Project Setup + GitHub App
**Goal:** Bot can see PRs locally via ngrok tunnel.
- Init monorepo: `apps/api` (NestJS) + `apps/web` (Next.js)
- Register GitHub App, configure webhook for PR events
- Webhook handler that receives PR open/sync events and stores diff in local SQLite
- Verify with ngrok tunnel + test PR

### Day 2 — Knowledge Base Setup
**Goal:** Can semantically retrieve relevant rules by PR diff content.
- Chroma local instance via Docker Compose
- Embedding pipeline: chunk → embed (text-embedding-3-small or Claude embeddings) → store
- Seed with real ruleset: Airbnb style guide + sample team review standards
- Manual retrieval test: paste a diff, get back top-K rules

### Day 3 — First End-to-End Review
**Goal:** First automated review running on a test PR.
- Anthropic SDK integration with **prompt caching** (per Anthropic best practices)
- Pipeline: PR diff → retrieve top-K rules → Claude analyzes → output structured JSON findings
- Run on first real test PR, store findings

### Day 4 — Agentic Layer
**Goal:** Bot acts like a reviewer fetching its own context.
- Multi-step agent loop using Claude's native tool use (or LangGraph if more clarity needed)
- Tools available to Claude: `fetch_related_file`, `fetch_function_definition`, `fetch_prior_review`
- Claude decides what context to pull before reviewing

### Day 5 — MVP Demo (HALFWAY MARK)
**Goal:** End-to-end demo from PR open → review comment posted.
- Post review back as PR comment via GitHub API (octokit)
- Record demo video
- **CHECKPOINT:** Working MVP. Re-evaluate timeline and scope.

### Day 6 — Evaluation Harness
**Goal:** Can run evaluation suite and see metrics.
- 10 test PRs (5 good, 5 bad) with expected findings
- Ragas integration: measure faithfulness + answer relevance
- Manual precision/recall scoring vs. expected findings

### Day 7 — Next.js Dashboard
**Goal:** Dashboard live at public URL.
- List of reviewed PRs, severity counts, settings page
- Deploy frontend to Vercel
- Connect to backend on Railway/Fly

### Day 8 — Observability
**Goal:** Production-grade telemetry visible.
- Log token cost per review, latency per stage, hallucination flag (when Claude cites a non-existent rule)
- Add metrics to dashboard
- Optional: Sentry for error tracking

### Day 9 — README + Blog Post
**Goal:** Written engineering artifact published.
- README with architecture diagram and decision rationale (Mermaid diagrams)
- 1500-word blog post: "Building a PR Review Copilot with Claude + Chroma — Architecture Decisions and Tradeoffs"

### Day 10 — Polish
**Goal:** Project complete and shippable.
- Fix highest-priority bugs OR add LangGraph for clearer agent loop OR add a second small AI feature
- Pin repo on GitHub profile + update profile README

---

## Success Criteria

- [ ] 1 documented AI product on GitHub (public, README complete, demo recorded)
- [ ] 1 written engineering artifact (blog post)
- [ ] Evaluation metrics shown (faithfulness + recall on test PRs)
- [ ] Live deployment (frontend + backend reachable at public URLs)
