# Evaluation Harness — Operator Runbook

The eval harness is a two-step pipeline: a **gated capture** step that
runs the real reviewer + faithfulness judge over a fixture corpus, and an
**offline score** step that reads committed recordings and computes
metrics. This runbook covers day-to-day operation.

---

## Prerequisites

### For `eval:capture` (gated, real-API)

| Dependency      | How to verify                                                 |
|-----------------|---------------------------------------------------------------|
| Anthropic key   | `ANTHROPIC_API_KEY` in `.env` (validated by `ConfigService`)  |
| Voyage key      | `VOYAGE_API_KEY` in `.env`                                    |
| Chroma instance | `CHROMA_URL` reachable (default `http://localhost:8000`)      |
| Seeded corpus   | `npm run seed --workspace apps/api` completed (43 chunks, v1) |

Capture's preflight checks Chroma reachability and seed-corpus version
before spending any API budget.

### For `eval:score` (offline, keyless)

No API keys, no running services. Reads committed JSON only.

---

## Running the harness

### Capture (gated)

```bash
# Set the gate flag (or RUN_ANTHROPIC_INTEGRATION)
export RUN_EVAL_CAPTURE=true

# Run capture — boots a lean NestJS context (no GitHub/Redis/webhook deps)
npm run eval:capture --workspace apps/api
```

Capture writes one recording per fixture to
`apps/api/test/fixtures/eval/recordings/`. Clean fixtures are captured
A/B (full-corpus + top-10 retrieval).

### Score (offline)

```bash
npm run eval:score --workspace apps/api
```

Prints a markdown summary to stdout, writes a JSON result to
`apps/api/test/fixtures/eval/results.json`, and exits non-zero if a
gated metric drops below its threshold.

---

## Structural staleness gate

The score step compares each recording's `gitSha` against the latest
commit touching these tracked paths:

- `apps/api/src/infrastructure/anthropic/**`
- `apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts`
- `apps/api/seeds/**`

**Behavior:**

| Thresholds set? | Stale recording? | Action      |
|-----------------|-------------------|-------------|
| No (report-only)| Yes               | Warn in summary |
| Yes (active)    | Yes               | Hard-fail (exit non-zero) |
| Either          | No                | Pass        |

### What to do when the staleness gate fires

1. Run `eval:capture` to produce fresh recordings
2. Commit the new recordings
3. Re-run `eval:score` to verify the gate passes
4. If F1 dropped below threshold, investigate the change that caused
   staleness — a prompt edit, model swap, or seed update may have
   regressed review quality

---

## Re-capture triggers

Run `eval:capture` and commit new recordings whenever:

- `PROMPT_AND_TOOL_VERSION` is bumped in the reviewer
- `FAITHFULNESS_JUDGE_VERSION` is bumped in the judge prompt
- The seed corpus (`apps/api/seeds/*.json`) is modified
- Any file under `apps/api/src/infrastructure/anthropic/` changes
- A model swap or adapter refactor lands

The staleness gate enforces this in CI once thresholds are active.

---

## Setting thresholds

Thresholds live in `apps/api/test/fixtures/eval/thresholds.json`.

```json
{
  "microF1": 0.75,
  "faithfulness": 0.80,
  "capSaturatedMax": 1
}
```

**Procedure:**

1. Run a baseline capture: `npm run eval:capture`
2. Run score: `npm run eval:score` — read the markdown summary
3. Set each threshold a small margin below the measured baseline
4. Commit `thresholds.json` + baseline recordings together
5. Verify: `npm run eval:score` exits 0

Leave a metric key absent to keep it report-only (e.g., omit
`faithfulness` while calibrating the judge).

---

## Calibration labeling

The faithfulness judge is Claude-judging-Claude (same-family). To
quantify its reliability, hand-label a stratified subset of findings.

### Labeling procedure

1. Open the recordings in `apps/api/test/fixtures/eval/recordings/`
2. For each finding in your subset, read the finding's claims and the
   judge's verdict, then independently decide: is each claim
   **supported** or **not supported** by the cited rule + diff?
3. Record your labels in a sidecar JSON file:

```json
[
  {
    "fixtureId": "eqeqeq-violation",
    "findingIndex": 0,
    "humanVerdict": "supported",
    "judgeVerdict": "supported"
  }
]
```

4. Save to `apps/api/test/fixtures/eval/calibration-labels.json`

### Stratification guidance

- Sample some clearly-grounded findings (expect agreement)
- Sample some clearly-hallucinated findings (expect agreement)
- Sample some borderline/unclear findings (where κ actually matters)
- Aim for ~10-15 minimum (directional), 30+ for stable κ

### Interpreting results

| κ range     | Interpretation (Landis & Koch) |
|-------------|--------------------------------|
| < 0.00      | Less than chance agreement     |
| 0.00 – 0.20 | Slight agreement              |
| 0.21 – 0.40 | Fair agreement                |
| 0.41 – 0.60 | Moderate agreement            |
| 0.61 – 0.80 | Substantial agreement         |
| 0.81 – 1.00 | Almost perfect agreement      |

The markdown summary frames the calibration as "preliminary on N=X
items (directional, not validation)" with the same-family caveat named
explicitly. κ stabilizes around N=30+.

---

## CI integration

The `eval:score` step runs in CI after the test suite, in the existing
`test` job with no new secrets. While thresholds are unset, it exits 0
(report-only) and never blocks merges.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Capture fails at preflight | Chroma not running or not seeded | Start Chroma, run `npm run seed` |
| Capture fails at preflight | Seed corpus version mismatch | Re-seed; if corpus changed, bump `seedCorpusVersion` in capture |
| Score hard-fails on missing recording | Manifest has a fixture with no recording | Run capture (or remove the manifest entry if the fixture was deleted) |
| Score hard-fails on hash mismatch | Manifest was edited without re-capturing | Run capture to produce recordings matching the updated manifest |
| Score warns on staleness | Adapter/judge/seed changed since last capture | Run capture and commit new recordings |
| Clean fixture emits findings | Authoring failure — the fixture violates a rule | Fix the patch file and re-capture |
