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
| single-turn judgement | `npm run eval:hardcases` (45 cases, engine-verified); also regraded strictly by `scripts/models/regrade-hardcases.mjs` (v3) | beat **84%** (gpt-oss-20b, old prompt) — every big model now clears it; the ruler has saturated |
| honest declines | the `decline` bucket of the same eval | ≥ 5/6 |
| loop behaviour | `scripts/models/loop-eval.mts` (26 scenarios through the real loop) — reads before writes, stops cleanly, no `gaveUp` | read-before-write 2/2, gave up 0 |
| **conversation** | `scripts/models/convo-eval.mts` (14 two-turn conversations, state carried like the client) | **the ruler that separates sizes** — 550B 79%, 20B 43% (2026-10-03) |
| latency | median + p90 seconds **per message** from the loop/convo evals | message-level ≤ ~10 s |
| cost | $/message at beta volume | free now; priced before launch |

## Ground rules for measurements

1. **A scorecard with `infraFailures > 0` is not evidence about the model** (WORKPLAN lesson 44). Infra
   misses are reported, never averaged in.
2. **Every run writes a file** to `data/eval-runs/`. A number that only printed to a terminal didn't
   happen.
3. **Latency is measured, never quoted from a provider page.** Free tiers queue; the same model can be
   2 s or 250 s depending on where it is hosted. And only per-MESSAGE seconds from the real loop count:
   short-prompt sweeps flatter every model 3–10×.
4. Single-turn scores are a proxy. The loop and conversation evals are the real test.
5. **Repeat before you claim.** Identical runs swing up to 9 points on the hard cases; quote ranges.
6. **Grade what the engine did, not what the model sent.** Counting emitted operations hid three
   engine bugs on 2026-10-03 (a slot-scoped constrain that did nothing while the reply said it had).

## Decisions on record

- **2026-10-03 — the owner's direction: a BIG hosted model first.** Find the biggest free model with an
  optimal response time (100B+); stop investing in training or tuning 20–30B models. 20B models are run
  only as a regression check for the model production serves today.
- **2026-10-03 — the prompt is not gated for v8.** The read-tool prompt costs the 1.5B fine-tune (v8)
  2–3 cases under the v1/v2 grades (73/80 → 67/76) and leaves it flat under v3 (73 → 73). Production
  does not serve v8, so the prompt lands for everyone. **If v8, or any fine-tune, ever serves again, it
  is retrained on the new prompt** rather than the prompt being forked to suit it. (Agreed with the v1
  lane, which landed the prompt.)
- **2026-10-03 — the conversation eval is the deciding ruler.** On single-turn cases the fixed prompt
  lifted gpt-oss-20b to tie the 550B (91–96%). Across conversations the 550B passes 11/14 and the 20B 6/14
  with either prompt: the 20B swapped in a placeholder dish name, stored "keep Sunday's dinner" as a note
  instead of pinning it, and resized the wrong day.

## Files

- `OWNER-TODO.md` — things only the owner can do; this lane never waits on them.
- `survey.md` — the model survey: what's reachable, parameter counts, measured latency, scores.
- `free-providers-2026-10.md` — the verified search of every free provider: what is big, fast and free, and what isn't.
- `read-tool-fix.md` — the read-tool fix (the loop could never use its own look-ups) and its evidence.
- `eval-variance.md` — how much identical runs swing, and why every score is a range.
- `hardware-128gb.md` — what a 128 GB machine would and would not buy.
