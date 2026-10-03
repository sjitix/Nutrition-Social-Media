# Models lane — the assistant's brain

Owned by the models agent (see `docs/parallel/lane-models.md`). This folder is the research record:
what was measured, how, and what it decided.

## The bar

The assistant must behave like a **personal nutritionist**: understand loose, emotional, multi-part
requests; decide *whether* to act (act / clarify / decline / refuse); use the app's real functions
(the primitives and the agent loop's read tools) instead of inventing; write warm, precise language;
and never fake a nutrition number (the engine does all arithmetic).

It must also be **fast enough to feel like a conversation**. The agent loop takes 2–4 model calls per
message (8 at worst), so **per-call latency × steps** is the number a user feels.

| axis | how it's measured | bar |
|---|---|---|
| single-turn judgement | `npm run eval:hardcases` (45 cases, engine-verified) | beat **84%** (gpt-oss-20b) |
| honest declines | the `decline` bucket of the same eval | ≥ 5/6 |
| loop behaviour | the loop-level eval (to build) — reads before writes, stops cleanly, no `gaveUp` | TBD once built |
| latency | median + p90 seconds per call, measured live | message-level ≤ ~10 s |
| cost | $/message at beta volume | free now; priced before launch |

## Ground rules for measurements

1. **A scorecard with `infraFailures > 0` is not evidence about the model** (WORKPLAN lesson 44). Infra
   misses are reported, never averaged in.
2. **Every run writes a file** to `data/eval-runs/` — a number that only printed to a terminal didn't
   happen.
3. **Latency is measured, never quoted from a provider page.** Free tiers queue; the same model can be
   2 s or 250 s depending on where it is hosted.
4. Single-turn scores are a proxy. The loop-level eval is the real test.

## Files

- `OWNER-TODO.md` — things only the owner can do; this lane never waits on them.
- `survey.md` — the model survey: what's reachable, parameter counts, measured latency, scores.
