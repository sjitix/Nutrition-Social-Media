I have verified every load-bearing anchor and found concrete problems the design and plan miss. Full adversarial critique below.

---

# Adversarial review — NutriFlow Batch-Cooking Mode design + plan

**Anchor spot-check result:** every anchor I pulled matches the tree exactly — clamp `Math.max(0.6, Math.min(1.8, …))` at `recipeDb.ts:8120`; `scaleQuantity` unclamped `8103-8114`; lever-1 lock filter `!locked?.has(x.m.type)` at `8592`, lever-2 `locked?.has(cur.type) continue` at `8702`; `rebalanceWeek` calls `rebalanceDay(…, undefined, avoid)` at `8753`; `update_profile` `if (op.diet)` at `9962`, reTheme gate `9992`, keep-path rebuild `9993`; `regenerate_week` `10012`; `compute_targets` `10235`; `planChanged` deep-compare `10508`; `p = {...profile}` `9916`; `generatePlan` dispatch `ai.ts:627`; `withTargetDefaults` `ai.ts:26-36`; schemas `types.ts:14-59`; `localSplit` distinct types per day `7868-7881`; `groceriesFromWeek` first-seen-quantity + count `myPlan.ts:60-73`; `ConstrainOp`/`expandConstrain` `primitives.ts:25-91`.

Three of the design's own premises are also confirmed sound and are **not** findings: `LockedSlots = ReadonlySet<Recipe["type"]>` with distinct per-day types means type-lock == slot-lock (verified `localSplit`); a pure-batch day makes `scaleToTargets` return `adj.length===0 → meals` unchanged (`8594`) and lever-2 skip every slot; `p = {...profile}` means `planMode` rides through `applyOperations` and is returned automatically (Q6 preservation is real at the engine layer).

But the design leaks in five concrete places, two of them HIGH regressions of the **fresh** path.

---

## HIGH

### H1 — Bulk-grocery math ignores the `recipe.servings` divisor → 2–3× over-shop
- **At risk:** Q10 / §e; the *same* "`servings` is an overloaded divisor" hard constraint the design claims to honor (it guarded macros but missed the ingredient list).
- **File:line:** `types.ts:29-33` (contract: "how many servings this ingredient LIST makes … nutrients must be divided by this"), `recipeDb.ts:1084` (`Banana Walnut Protein Muffins servings:3`), `recipeDb.ts:2159` (`Chocolate Peanut Protein Balls servings:2`), `nutrients.ts:26-38` (`gramsFor`).
- **Exact failure:** the design (§e) says "take the base recipe's per-serving ingredient quantities … multiply by `totalServings`." But for a recipe with `servings:N>1`, the authored ingredient list is **per-N-servings (the whole tin)**, not per serving — the macros are per serving because `deriveMacros` divided by `servings`, but the ingredient strings were never divided. Concrete: muffins (`servings:3`) batched to `totalServings:6`. Correct grocery = ingredient list × (6/3) = ×2. Design computes ingredient list × 6 → **3× over-purchase** of flour, banana, walnuts, protein powder. The money-saved metric then also reads triple-cost on those rows.
- **Severity:** HIGH — silently wrong shopping quantities on exactly the "batchable" dishes (muffins/balls) a meal-prep mode most wants, and it inflates the headline "you save $X" claim.
- **Fix:** bulk grams = `gramsFor(ingredient) / (recipe.servings ?? 1) × Batch.totalServings`. Add the `/ (servings ?? 1)` divisor everywhere the batch aggregator multiplies, and add a test with a `servings>1` recipe.

### H2 — `buildWeek(p)` is too narrow to drop into the edit/re-theme rebuild sites → regresses FRESH mode
- **At risk:** Q5 "survive every rebuild call site"; the fresh path's edit-preservation, re-theme, boost-guarantee and disclosure invariants.
- **File:line:** design §b defines `buildWeek(p: UserProfile)`; plan M1b/M2 say "replace the RHS with `buildWeek(p)`" and "route the four rebuild sites through `buildWeek`." But `update_profile` calls `selectWeekFromDb(p, cuisine, fiberOn(op), op.useIngredients, boost, rep, {plan: prev, keepIf})` (`recipeDb.ts:9993`); `compute_targets` passes `…, rep, {plan: curPlan, keepIf}` (`10235`); `regenerate_week` passes cuisine/fiber/useIngredients/boost/rep (`10012`).
- **Exact failure:** a one-arg `buildWeek(p)` drops `keep`, `cuisinePref`, `preferFiber`, `boost` and the `SelectionReport`. If an implementer literally replaces line `9993` with `buildWeek(p)`: "make it vegetarian" now rebuilds **from scratch** instead of keep-preserving the user's swapped-in dishes; "more Italian / boost iron / use up my spinach" silently stop biasing selection; and `rep` comes back empty so `reportNotes` never discloses a dropped slot or relaxed budget — a VISION honesty violation. This is a fresh-mode regression, not a batch feature.
- **Severity:** HIGH — breaks tested fresh behavior at three sites.
- **Fix:** do **not** universalize `buildWeek(p)`. Gate per-site: `p.planMode === 'batch' ? buildBatchWeek(p) : <the existing selectWeekFromDb(...) call, unchanged, with all its args>`. Reserve the one-arg `buildWeek` only for `ai.ts:627` and demo, which pass nothing extra.

### H3 — Switching batch→fresh keep-paths and yields a degenerate "fresh" week
- **At risk:** Q2 / the reTheme gate (`recipeDb.ts:9992`); the design's own rule "a mode switch must NOT keep-path."
- **File:line:** `reTheme = !!(op.cuisine || fiberOn(op) || op.boostNutrient || op.useIngredients?.length)` (`9992`). A bare `{tool:'update_profile', planMode:'fresh'}` (or `'batch'`) sets **none** of those → `reTheme=false` → line `9993` uses `{plan: prev, keepIf}`.
- **Exact failure:** the design correctly notes the fresh→batch direction is safe (batch build ignores keep). But it misses batch→**fresh**: `prev` is the batch week (few dishes repeated across 7 days). `keepIf` keeps every dish that passes diet/exclusions, and `selectWeekFromDb` pre-marks them used and pushes them verbatim (`8369-8378`, `8251`). Result: the "fresh" week keeps the batch repetitions — e.g. the same lunch on Mon/Wed/Fri — instead of 21 distinct dishes. The plan (M5) says "add `if (op.planMode) p.planMode = op.planMode`" and "dispatch via `buildWeek`" but never adds `op.planMode` to the reTheme/keep decision.
- **Severity:** HIGH — the "switch back to fresh, easily" core requirement produces a visibly broken fresh week.
- **Fix:** treat a *mode change* as a forced re-theme: `const modeChanged = op.planMode && op.planMode !== profile.planMode; … reTheme || modeChanged ? undefined : {plan: prev, keepIf}`. (Or, since the dual-cache in §a re-views the cached week on toggle, only rebuild-from-scratch on first entry to a mode — but the assistant path still needs the guard.)

---

## MED

### M1 — "Mode-agnostic" mutating ops desync cook-once and leave the overlay stale
- **At risk:** Q8/Q9 coherence; the overlay-consistency premise (§a "all servings share `servingFactor`, so no cross-day desync exists").
- **File:line:** design §f labels `scale_portions` (`recipeDb.ts:10384`), `log_meal` (`10247`), `eating_out` (`10321`), `substitute_ingredient`, `rebalance_day` (`10392`) as "mode-tolerant / mode-agnostic." They mutate **one** day's plate(s) in place and never touch `batches[]`.
- **Exact failure:** `scale_portions` on Tuesday rescales Tuesday's batched dinner → that instance no longer equals its Mon/Thu siblings → cook-once broken, and `Batch.perServing`/`servingFactor`/grocery totals are now stale. `log_meal` locks eaten slots and **rebalances the rest of that day** (`8681`), rescaling other batch instances for that one day only → same desync. `substitute_ingredient` on one instance diverges its ingredient list from siblings. `planChanged` still fires (deep compare) so the UI claims success, but the physical cook and the bulk list disagree.
- **Severity:** MED — not corruption, but it silently violates the mode's central promise and the design offers no handling.
- **Fix:** in batch mode these ops must target the whole batch by `batchId` (like the design already does for lock/rate) or refuse with an honest `notes[]` line; whichever, they must rewrite the affected `Batch` fields.

### M2 — `swap_meal` replaces meals but never updates `sessions[]`/`batches[]`
- **At risk:** Q8; the overlay-is-source-of-truth-for-grocery premise.
- **File:line:** whole-week swap loop `recipeDb.ts:10052-10096`, one-day swap `10100+`. Neither knows about the overlay (it doesn't exist yet).
- **Exact failure:** design §f calls whole-week `swap_meal` "COHERENT and replaces a whole batch." It replaces the *meals*, but `batches[].recipeName`, `.perServing`, `.placements`, `.totalServings` and the session bulk list stay pointed at the old dish. Groceries and the "cook X ×N" session card then describe the pre-swap batch.
- **Severity:** MED.
- **Fix:** batch-mode swaps must rebuild the affected `Batch` (or re-run `buildBatchWeek` for that session), not just `.map` the meals.

### M3 — Locked batch instances disable both levers → uncorrectable per-day protein swing
- **At risk:** §c "macro correctness"; §h.4 (design flags it as a risk but the plan ships selection without the mitigation).
- **File:line:** `rebalanceDay` lever-1 skips locked (`8592`), lever-2 skips locked (`8702`); rotation in §b step 6 puts different dish combos on different days.
- **Exact failure:** in a pure-batch day every slot is locked, so neither portion-scaling nor the protein upgrade can run. Rotation means day0={b0,l1,d0} and day1={b1,l0,d1}. If the two dinners differ 25 g protein, one day lands 25 g short of `proteinGrams` with **no lever able to fix it** — the exact case lever-2 exists for. §b step-4 selection minimizes each dish's distance to target but not the A/B pair's divergence.
- **Severity:** MED — days can miss the protein target that fresh mode always hits; honesty note helps but the number is still wrong.
- **Fix:** make §b step-4 selection minimize the *pairwise* macro distance among the K rotating dishes (the §h.4 term), and gate it with the M0 variance measurement before shipping.

### M4 — M1 fresh-regression byte-identity test is nondeterministic
- **At risk:** the plan's headline safety test (M1: `JSON.stringify(buildWeek(BASE)) === JSON.stringify(rebalanceWeek(selectWeekFromDb(BASE), BASE))`).
- **File:line:** `_rng` defaults to `Math.random` (`recipeDb.ts:7983`); `withSeed(seed, fn)` scopes a deterministic RNG (`8003-8009`); consumed in the `chooseRecipe` tie-break (`8097`).
- **Exact failure:** two independent `selectWeekFromDb(BASE)` calls draw fresh `Math.random` → different picks → the assertion fails spuriously. Wrapping *both* in one `withSeed` also fails: the first build advances the RNG so the second sees different values.
- **Severity:** MED — a flaky gate that will either be deleted or forced green, defeating its purpose.
- **Fix:** reseed per build to the *same* seed: `withSeed(1, () => buildWeek(BASE))` vs `withSeed(1, () => rebalanceWeek(selectWeekFromDb(BASE), BASE))`. (These then match because the fresh branch of `buildWeek` is that exact expression with identical RNG consumption.)

### M5 — Test invariant "every batch meal `servings===undefined`" is false
- **At risk:** M1 test list ("Divisor untouched: `…meals.every(m => m.servings===undefined)`").
- **File:line:** `toMeal` copies `r.servings` onto the Meal (`recipeDb.ts:118`); `Banana Walnut Protein Muffins servings:3` (`1084`), `Chocolate Peanut Protein Balls servings:2` (`2159`).
- **Exact failure:** if `selectBatchWeek` picks either dish (both are prime batch candidates), the plated Meal carries `servings:3`/`2` — legitimately, as the ingredient-list divisor — and the assertion throws even though nothing is wrong. The real invariant is "batch never *writes a new* `servings` as a cook count," not "servings is always undefined."
- **Severity:** MED (test correctness; also see H1 which is the substantive bug behind this).
- **Fix:** assert `m.servings === base.servings` (unchanged from the seed), not `undefined`; carry the ×N only on `Batch.totalServings`.

### M6 — `keepDays` deny-list can freeze-tag a poor freezer
- **At risk:** question (8) food-safety honesty on weekly cadence; §h.2.
- **File:line:** `Recipe` has no shelf-life/freezability field (`recipeDb.ts:70-101`); `keepDays` is a proposed coarse token deny-list.
- **Exact failure:** weekly cadence freeze-tags placements past `keepDays`. A leafy-salad or delicate-fish dish that the deny-list misses gets a `frozen:true` tail and the UI tells the user to freeze/thaw it — actively bad food-safety advice, worse than silence.
- **Severity:** MED — this is the design's largest data gap and it is on the safety axis.
- **Fix:** default weekly-cadence dishes to a *freeze-friendly allow-list* (only tag freezable dishes; otherwise prefer `every3days` or shorten the covered window), label the heuristic coarse in-UI as planned, and add the optional per-recipe `freezes?` field the design contemplates.

---

## LOW

- **L1 (Q7):** routing re-batch through `update_profile` is correct — it returns the whole plan and `planChanged` is deep-compared, so the `changedDays` limit never bites. But the *legacy v1 fine-tuned model* has never seen a `planMode` field and won't emit the op reliably; the UI toggle must be the real path (the v2 `ConstrainOp` route is fine). Adequately resolved; note the reliance on the toggle.
- **L2 (Q6):** the legacy per-day merge in `/api/assistant` carries `DayPlan`s only; top-level `sessions[]`/`batches[]` must be preserved by the server merge. Mostly moot because batch edits route through whole-plan `update_profile`, but add a guard test.
- **L3 (Q6):** `slotPhase = slot index` does not add the claimed "no identical adjacent days" guarantee — K≥2 alone gives it (two days are identical iff `i ≡ i' mod K`, false for consecutive). Harmless, but the rotation rationale is over-stated; and note a 3-day/K=2 window makes day0==day2 (non-consecutive, acceptable, but variety caps at K distinct day-compositions).

---

## Answers to the nine pressure-tests
1. **Per-plate scaling / clamped 3–7×?** Macros: correct — each plate is one serving scaled once inside `[0.6,1.8]`, ×N lives on `Batch.totalServings`. **But** the grocery ×N path is wrong: it forgets the `recipe.servings` divisor (H1).
2. **`servings` reused as both count and divisor?** Not on macros (guarded). But the design's *test* wrongly assumes batch plates have no `servings` (M5), and the *grocery* path conflates "per-serving list" with "per-recipe list" (H1).
3. **Can lever-2 upgrade-swap a batch instance?** No — verified: `rebalanceBatchWeek` passing batch slot-types as `LockedSlots` makes lever-1 (`8592`) and lever-2 (`8702`) skip them. Premise holds. (Caveat M3: that same lock removes the only protein-fix lever.)
4. **changedDays break on re-batch?** No, because it routes through `update_profile` (whole-plan). The answer is sufficient — with H3's keep-path fix, without which the *result* is broken even though the *contract* isn't.
5. **Survive `z.object` strip AND every rebuild site?** Strip: yes (fields on `WeekPlanSchema`/`MealSchema`). Rebuild sites: **no** as written — `buildWeek(p)` drops keep/cuisine/boost/report at `9993`/`10012`/`10235` (H2), and `selectDay`/mutating ops need the M1/M4-style handling.
6. **`planMode` preserved by every profile-returning op?** Yes at the engine (`p = {...profile}`, `9916`, returned `9511`). Verify the API routes round-trip `data.profile` (L2 test).
7. **Stored fresh profile/plan with no mode field loads?** Yes — all fields optional, `UserProfile` is cast unvalidated (`route.ts:11`), `withPlanDefaults` fills `'fresh'`. Backward-compat holds.
8. **Food-safety honesty on weekly cadence?** Structurally honest (freeze-tags + disclosure) but the underlying `keepDays` heuristic can mislabel a poor freezer (M6).
9. **Rotation at 3 meals/day with a small set — feasible? minimum set size?** Feasible for `none`/`vegetarian`/`mediterranean`. The binding constraint is **≥K diet-passing dishes per slot** after filtering: K=2 (3-day window) needs ≥2 per slot; K=3 (weekly) needs ≥3 per slot. Vegan/keto are marginal — MEMORY records vegan protein ≈2 sources, so some slots will have <K and must relax to K=1 (pure repetition) with a disclosed note. Minimum viable is K=2, and the M0 spike must confirm ≥2 per (slot × restrictive-diet) before M1 relies on it.

---

## Ranked must-fix-before-build gaps
1. **H2** — per-site gate instead of universal `buildWeek(p)`; do not drop keep/cuisine/boost/report at `9993`/`10012`/`10235`. (Blocks fresh-mode regression.)
2. **H3** — force re-theme on mode change (`modeChanged` term) so batch→fresh doesn't inherit repeats.
3. **H1** — divide bulk grocery grams by `recipe.servings` before ×`totalServings`.
4. **M1 + M2** — define batch semantics (whole-batch or refuse) for `scale_portions`/`log_meal`/`eating_out`/`substitute_ingredient`/`rebalance_day` and for `swap_meal`, and keep `batches[]` in sync; the "mode-agnostic" list is too optimistic.
5. **M3** — add the pairwise A/B macro-distance term to §b step-4, gated on the M0 variance spike.
6. **M4 + M5** — fix the two M1 test bugs (per-call `withSeed`; assert `servings===base.servings`) or the gate is flaky/false-red on day one.
7. **M6** — flip weekly-cadence freezing to an allow-list; do not emit freeze advice for unknown/poor freezers.

## Verdict: **NO-GO as written — conditional GO after fixes.**
The architecture is sound and the invariant analysis (clamp, lock-slots, name-keyed lookup, overlay strippability, profile-as-carrier) is correct and verified. But the plan as written would (a) regress the fresh path at three rebuild sites (H2), (b) break the "switch back to fresh" requirement (H3), and (c) ship wrong shopping quantities on the very dishes batch mode targets (H1) — all three are silent and would pass a naive `test:engine` run. Fix H1–H3 and specify M1/M2 op semantics before starting M1; M4/M5 must be fixed within M1 itself or its safety gate is illusory. With those, GO.