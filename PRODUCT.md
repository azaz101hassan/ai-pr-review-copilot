# Product

## Register

product

## Users

The developer who installed the AI PR Review Copilot on their organisation,
working from a desktop browser during their normal weekday. They open the
dashboard to answer a single class of question: "Is the bot doing the
right thing on the PRs it sees?" Primary jobs on any given visit:

1. Confirm at a glance that reviews are flowing end-to-end (webhook →
   BullMQ → agent loop → GitHub review comment).
2. Narrow the picture to a single repo, author, or time window when
   something feels off.
3. Inspect a single review's findings, the chunks it pulled from the
   knowledge base, and what it cost in tokens / turns.
4. Verify the bot's configuration without reading source.

The operator is technically literate (they installed a GitHub App and a
NestJS service), trusts their own eyes, and has zero appetite for
ceremony. They do not need motivational copy.

## Product Purpose

A four-page operator surface over the local-first SQLite store the bot
already writes to: an analytics overview (with live updates via SSE), a
filterable reviews list, a review-detail page (PR metadata + findings +
retrieved chunks + token breakdown), and a read-only settings inspector.

Success: the operator can answer "is the bot reviewing PRs against the
right rules?" without opening a database client, tailing a log, or
reading source. The dashboard's job is to make the pipeline legible.

It is **not** a pitch for the bot; the bot's competence is taken as
given. It is **not** an admin console; mutation lives in source and
config files until later sprints. It is **not** a public marketing
surface; auth, deployment, and a public URL are out of Day-7 scope.

## Brand Personality

Technical. Quiet. Confident.

The dashboard reads as engineer-built for engineers. Typography-led, not
color-led. Restrained palette. No decorative motion. The bot's
competence is the brand; the interface's job is to step aside and let
the data carry the message. Copy is direct: nouns and verbs, no
adjectives that try to make the work sound impressive.

## Anti-references

What this MUST NOT look like:

1. **Generic AI-tool dashboard.** Dark bg + violet / cyan accent +
   glassmorphism cards + gradient borders + gradient text + "tron-grid"
   backgrounds + the "AI inside" pulsing dot. The 2026 saturated AI
   default; the category cue would lead any model straight to it. Refuse.

2. **The second-order escape for category-1.** "Terminal-themed dark
   mode with green-on-black, monospace-everything, blinking-cursor
   accents" is the same training-data reflex one tier deeper for AI dev
   tools. Refuse.

3. **Bland SaaS scaffold.** Uniform same-size card grids, hero-metric
   template (big number / small label / arrow), tiny uppercase
   `ABOUT / PROCESS / PRICING` eyebrows above every section, numbered
   section markers (`01 · 02 · 03`), side-stripe borders on alerts.

4. **Consumer-dashboard noise.** Drenched bright colors, illustration
   spots, animated everything, motion as decoration.

Concrete tells to refuse on sight: gradient text, side-stripe colored
borders (`border-left` / `border-right` >1px as a colored accent),
glassmorphism as default, nested cards, the hero-metric template
repeated across pages, em dashes in copy, marketing buzzwords
(streamline / empower / supercharge / leverage / seamless / world-class /
enterprise-grade / next-generation).

## Design Principles

1. **The bot's competence is the brand.** The UI is a window onto
   pipeline state, never a pitch for the pipeline. No
   competence-signaling decoration.
2. **Show, don't decorate.** Every pixel pays rent. Color, motion, and
   container chrome appear only when they carry information.
3. **Type-led hierarchy.** Scale and weight contrast do the heavy
   lifting before color or background ever does. Display steps ≥1.25
   ratio. Headlines balance, body prose pretties.
4. **Read-at-glance for the headline tiles, reachable for the rest.**
   Volume and severity are legible from across the desk. Latency, token
   cost, and the top-rules list are deliberately calmer, smaller, and
   below. The hierarchy is the UX.
5. **Honest failure surfaces.** Empty states, error states, the
   loopback-bind off state, the SSE-cap "live updates unavailable" badge
   all read as built-on-purpose, not as fallback noise. "Run npm run
   seed:dev to populate" is a designed empty state, not a placeholder.

## Accessibility & Inclusion

- **WCAG 2.1 AA target**, no formal audit gate. Discipline applied
  inline.
- Body text ≥4.5:1 contrast against its background, including muted
  metadata; large text ≥3:1. Placeholder text and inline labels held to
  the body-text bar, not the muted bar.
- Every interaction is keyboard-reachable; focus rings are visible and
  on-brand (not the browser default outline removed).
- `prefers-reduced-motion: reduce` honored on every transition (default
  to crossfade or instant; no Reach motion as the default).
- `<SseStatusBadge>` carries `role="status" aria-live="polite"` per the
  plan so screen-reader users hear the live / reconnecting / unavailable
  state.
- Color is never the only signal. Severity badges pair color with a text
  label; the SSE status pairs color with text.
