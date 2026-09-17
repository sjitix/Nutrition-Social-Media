# Batch-cooking / meal-prep mode — design record

A second planning **mode** alongside today's "fresh" (distinct-dish-per-meal): the user has cooking
**sessions** (week start, or every 3 days), cooks a **small overlapping recipe set** in bulk, and the
servings are **rotated across days** — cook a few times, still eat varied meals. Payoff: money + less
waste. Toggle fresh↔batch anytime; it persists.

Produced 2026-09-17 by: 7-subsystem code map → 3 independent designs → synthesis → milestone plan →
adversarial critique (verdict: **NO-GO as written → GO after 3 fixes**, all folded into the milestones).
Visual summary artifact: https://claude.ai/artifact/DYonDYakhAemoUyH1ceXQQ

## Files (read in order)
1. [`00-current-state-map.md`](00-current-state-map.md) — how planning works TODAY, exact `file:line`
   anchors, the minimal backward-compatible schema extension, and the hard constraints batch mode must
   not break. **Read this first before touching the engine.**
2. [`01-canonical-design.md`](01-canonical-design.md) — the chosen data model, allocation algorithm,
   macro-correctness, cadence/food-safety, efficiency, mode UX + assistant integration; all 15 open
   questions resolved.
3. [`02-milestone-plan.md`](02-milestone-plan.md) — M0–M6, each independently shippable and green on
   `npm run test:engine`, with file anchors and the exact regression tests to add. **This is the build
   script.**
4. [`03-adversarial-critique.md`](03-adversarial-critique.md) — the bugs the design missed and their
   fixes. Apply these while building; do not skip.

## The 3 must-fix bugs (fold into the milestones — see the critique for detail)
- **H1 (→M4):** bulk grocery grams must divide by `recipe.servings` before ×`totalServings`, or
  `servings>1` recipes over-shop 2–3×.
- **H2 (→M2):** do NOT universalize a one-arg `buildWeek(p)` into the edit/rebuild sites — gate
  per-site (`p.planMode==='batch' ? buildBatchWeek(p) : <existing selectWeekFromDb(...) call unchanged>`),
  or fresh-mode loses keep/cuisine/boost/report at `recipeDb.ts:9993/10012/10235`.
- **H3 (→M1/M5):** a mode change must force a rebuild, not keep-path — else batch→fresh keeps the batch
  repeats instead of 21 distinct dishes. Add a `modeChanged` term to the `reTheme` gate (`recipeDb.ts:9992`).
- Also fix the two M1 test bugs the critique found: seed each build with the SAME `withSeed(1, …)` for the
  fresh-identity assertion; assert batch plates keep `servings === base.servings`, not `undefined`
  (`toMeal` copies the seed's `servings`).

## Owner decisions still pending (product calls — confirm before/at M1)
| Decision | Owner's lean (from the artifact) |
|---|---|
| Default cadence | every-3-days (safe, no freezing) |
| Weekly cadence in v1 | 3-day first; weekly + freeze-tagging in M3 |
| Today/Groceries parity | Week-first; the rest as fast-follow |
| Dedicated `/sage/cook` route | fold into the Week board for v1 |

These are defaults, not confirmed — check with the owner at the top of the build.
