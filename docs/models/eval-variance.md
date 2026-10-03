# The hard-case eval swings ~9 points with no change — read every score as a range

Models lane, 2026-10-03. Written because a single headline from this eval will otherwise be believed.

## The observation

Same model, same prompt, same 45 cases, temperature 0, single turn, same free NVIDIA endpoint:

| run | model | prompt | actedRight (v1 ruler) | actedRightV2 | infra | scorecard |
|---|---|---|---|---|---|---|
| morning | Nemotron-3-Ultra-550B | main | **82%** (37/45) | — (not yet graded) | 0 | `2026-10-03T09-48-24-…ultra-550b….json` |
| evening | Nemotron-3-Ultra-550B | main (+ v1's swap contract, which a single turn can't see) | **73%** | **84%** | 0 | `2026-10-03T11-06-51-…ultra-550b….json` |

**9 points on the historical ruler, with no change that a single-turn case can see.** Temperature 0 on
a hosted endpoint is not deterministic: batching, routing to different replicas, and floating-point
order all move the output, and a 45-case eval turns one flipped case into 2.2 points.

## What it means

1. **A single run of this eval cannot detect a change smaller than ~10 points.** Read "82% vs 84%" as
   "the same". The memory note from the fine-tune era (`the 65-case eval is too noisy to steer
   iteration`) was right, and it holds for big hosted models too.
2. **Decide on large, mechanical effects** — the loop eval's read-before-write, give-ups and worst-case
   seconds move by whole scenarios, not by one flipped case — and treat the hard-case eval as a
   regression check: "no drop beyond the run-to-run spread".
3. **State the spread when quoting a score**, e.g. "Ultra-550B on main: 73–82% (v1) / 84% (v2)".
4. **For a cleaner signal, use a local model at temperature 0** (LM Studio has no batching noise from
   other tenants) — which is why the read-tool fix's prompt change is also checked on the local v8.
5. **Growing the case set** (45 → a few hundred) is the real fix for steering by this eval; until then,
   it is a coarse instrument.
