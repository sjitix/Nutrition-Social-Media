All anchors verify exactly against the working tree (`ai.ts:627` unchanged single-dispatch; clamp `Math.max(0.6, Math.min(1.8, …))` at `recipeDb.ts:8120`; `scaleQuantity` unclamped `8103-8114`; `LockedSlots` filter `!locked?.has(x.m.type)` at `8592` and lever-2 `locked?.has(cur.type) continue` at `8702`; `update_profile` rebuild + `reTheme` gate `9978-9994`, `if (op.diet)` at `9962`; `selectWeekFromDb` signature `8337-8345` with `keep?: KeepEdits`; `MealSchema.servings?` `types.ts:33`, `WeekPlanSchema` + `notes?` precedent `46-52`; harness `check(label,cond,detail)` + imports at `test-engine.mts:15`). Plan below.

---

# NutriFlow Batch-Cooking Mode — Milestone Implementation Plan

Ordered by dependency. Each milestone is independently shippable and leaves `npm run test:engine` GREEN. Anchors are `file:line` in the working tree. **Migration:** none required anywhere — every added field is optional and default-filled (`withTargetDefaults` precedent, `ai.ts:26-36`); the repo has no versioning/migration mechanism and none is introduced. **Assistant-contract change:** isolated to **M5** (flagged there). **The gate:** any `src/lib` change runs `npm run test:engine` before push; UI-only milestones (M6) gate on `tsc` + `npm run build`.

---

## M0 — Validation spikes (feeds M1/M3/M4; ships a script + green)

**Goal (1 line):** Retire the three riskiest data assumptions before selection logic depends on them.

**Files:** new `scripts/batch-spike.mts` (run manually, not in the gate); read-only over `recipeDb.ts` `RECIPES` (`:7862`), `nutrients.ts` `gramsFor` (`:26-38`).

**What changes:** (1) run `gramsFor` over every ingredient string of a fresh + a would-be batch week, print coverage fraction (design §h.3 — if low, M4 bulk list is soft). (2) Build batch weeks for vegan/keto/low-budget `BASE` variants and count distinct dishes available per slot → confirms K must relax (MEMORY `recipe-db-constraints`: vegan protein ≈2 sources, §h.5). (3) Eyeball the dishes a batch week picks for bulk-cook plausibility → produces the seed for M3's `keepDays`/batchability deny-list (§h.1-2).

**Tests to add:** none to the gate (spike is exploratory). Output is a report consumed by M1/M3/M4 authors.

**User-visible outcome:** none (internal). Prevents shipping a batch week that can't supply K dishes or a bulk list that's silently incomplete.

---

## M1 — Vertical slice: batch mode is real end-to-end

**Goal (1 line):** A `planMode:'batch'` profile builds a deterministic small-set-cooked-large, rotated week that renders on every existing screen, toggled from the shell.

### 1a — Schema + defaults foundation
**Files/anchors:**
- `types.ts:191` (`UserProfile`) — add optional `planMode?: 'fresh'|'batch'`, `batchCadence?: 'weekly'|'every3days'`, `batchVariety?: number`.
- `types.ts:19` (`MealSchema`) — add `batchId: z.string().optional()` (single backlink; sessionId derivable via `batches` index).
- `types.ts:46` (`WeekPlanSchema`) — add `planMode: z.enum(['fresh','batch']).optional()`, `sessions: z.array(CookingSessionSchema).optional()`, `batches: z.array(BatchSchema).optional()` (mirror `notes?` at `:49-51`).
- New `CookingSessionSchema` + `BatchSchema` beside `types.ts:46`; export `z.infer` types beside `types.ts:163`. Shapes per design §a (`CookingSession {id, cookDay, coversDays[], label?}`; `Batch {id, sessionId, recipeName, slot, totalServings:int>0, servingFactor, perServing{...}, placements[{day,slot,frozen?}], keepDays?, freezeFrom?, bulkIngredients?}`).
- `ai.ts:26-36` — add `withPlanDefaults(p)` beside `withTargetDefaults`, defaulting `planMode:'fresh'` (nothing validates `UserProfile` at runtime — `/api/plan` casts `as UserProfile`, `route.ts:11`).
- `storage.ts:7-15` (`KEYS`) — add **one** key `batchPlan` (never inline; `savedStore.ts:36-39` drift lesson). `clearAll()` `:77-79` auto-covers it.

**Why on the schema, not just the object:** `z.object` strips unknown keys (no `.passthrough`); on `PLAN_ENGINE=llm` (`ai.ts:401` safeParse) `sessions`/`batches` would vanish, and `WeekPlan = z.infer` (`types.ts:163`) needs the type regardless.

### 1b — Deterministic engine
**Files/anchors:** `recipeDb.ts`, new exports beside `selectWeekFromDb` (`:8337`).
- Extract the candidate block from `pickMealsForDay` (`:8258-8294`: hard filter → soft-relax → `bannedForUser` → `cuisinePref`) into a shared `candidatesForSlot(profile, type)` — **no behavior change to fresh** (fresh calls it too), and it must **not** touch `ctx.usedIds/usedNames` (`:8315-8319`).
- New `selectBatchWeek(profile)`: `partitionSessions(DAYS, cadence)` → per session per `[type,share]` in `localSplit` (`:8346`): `target = round(targetCalories*share)` (constant across window, `:8229` formula); pick `K = min(coversDays.length>=4?3:2, pool.length)` distinct dishes — anchor = min `fitDistance` (`:8054-8073` verbatim), #2..K by existing overlap tie-break idiom (`:8078-8084`) against a **session-scoped** staple set (promoted to a primary term in M3); `scaleRecipeToTarget(dish, target)` **once** (`:8119`, clamp legitimately holds for one plate), store `servingFactor`; distribute with `slotDish = chosen[(i + slotIndex) % K]`; each placed `Meal` an identical copy + `batchId`; build `sessions[]`/`batches[]`, stamp `planMode:'batch'`. **Bypass** `newCtx`/`WeekCtx` dedup, `chooseRecipe`'s 3 variety gates (`:8018-8027`), and `_rng` tie-break (deterministic by `recipe.id`).
- New `rebalanceBatchWeek(plan, profile)`: run per-day rebalance passing every batch-tagged slot's *type* as `LockedSlots` — lever-1 filters `!locked?.has(x.m.type)` (`:8592`), lever-2 `continue`s on `locked?.has(cur.type)` (`:8702`); pure-batch day → `adj.length===0 → return meals` (`:8594`); a non-batch slot still balances.
- New `export function buildWeek(p)`: `p.planMode==='batch' ? rebalanceBatchWeek(selectBatchWeek(p), p) : rebalanceWeek(selectWeekFromDb(p), p)`.
- `ai.ts:627`: replace the RHS with `buildWeek(p)` (forces DB engine even under `PLAN_ENGINE=llm` — the LLM path can't express servings/rotation, §g.3).
- `demo.ts` week build (`:53-66`) routes through `buildWeek` so the one-fixture rule holds if the demo profile is ever batch (M1 keeps demo fresh; wiring only).

### 1c — Minimal toggle
**Files/anchors:** `SidePanel.tsx:97-112` (footer) — 2-state `Fresh|Batch` segmented control, SVG only (new pot/stack icon in `icons.tsx`; **no emoji**), degrades to one rail icon under `!open` (`:99-108`). `layout.tsx:45-58` — shared **Mode context provider** (server pages stay server; client leaves subscribe) so a mounted sibling re-renders on switch (each route reads storage once in `useEffect([])`, `WeekBoard.tsx:37-51`). `myPlan.ts:33-46` — toggle writes `profile.planMode` via `saveProfile`, calls `generateMyWeek()` (POST `/api/plan`, unvalidated cast carries the field, `route.ts:11`), caches under `KEYS.plan`/`KEYS.batchPlan` for instant lossless re-toggle. Cadence defaults `every3days` (safe; weekly's freeze work lands in M3 — **flag:** M1 may hard-pin `every3days` and defer the cadence sub-control to M3).

**Tests to add (`scripts/test-engine.mts`; import `selectBatchWeek, buildBatchWeek/buildWeek, rebalanceBatchWeek` at `:15`):**
- **Fresh regression (critical):** `JSON.stringify(buildWeek(BASE)) === JSON.stringify(rebalanceWeek(selectWeekFromDb(BASE), BASE))` — fresh path byte-identical.
- Batch shape: `w = buildWeek({...BASE, planMode:'batch', batchCadence:'every3days'})` → `w.days.length===7`; each day `meals.length===BASE.mealsPerDay`; `w.planMode==='batch'`; `w.sessions.length===2`; `w.batches.length>0`.
- Distinct dishes strictly fewer: `distinctNames(w) < summariseWeek fresh uniqueDishes` and `<= sessions*K*slots`.
- Clamp preserved: every batch meal `m.calories <= 1.8*base.calories && >= 0.6*base.calories` (base via `baseRecipeOf` name lookup, proving name intact, `:8561-8562`).
- Divisor untouched: no batch plate writes `servings` (`w…meals.every(m => m.servings===undefined)`).
- Cook-once byte-identity: for each `batchId`, all instances have equal `calories/proteinGrams/name`; `batch.totalServings === placements.length`.
- Rotation: no two consecutive days identical in *every* slot.
- Rebalancer protection: pure-batch day meals equal pre-`rebalanceBatchWeek` (lever-2 didn't upgrade-swap); a mixed day's non-batch slot still moved.
- Schema: `MealSchema.parse(batchMeal)` ok; `WeekPlanSchema.parse(w)` retains `sessions`/`batches` (not stripped).
- Vegan relax (from M0): batch vegan `BASE` builds without throw; if pool `<K`, a `notes[]` line records the relaxation.

**User-visible outcome:** Flip the shell toggle to Batch → the Week/Home/Groceries screens repopulate with a week built from ~2-3 dishes per slot cooked in bulk and rotated; flip back → instant fresh. Persists across hard refresh.

---

## M2 — Rebuild-site & op parity (correctness hardening)

**Goal (1 line):** Every plan-rebuild path honors the active mode, so no op silently reverts a batch week to fresh or desyncs a cook.

**Files/anchors:** route the four remaining rebuild sites through `buildWeek`/`selectBatchWeek`: `update_profile` rebuild (`recipeDb.ts:9993`), `regenerate_week` (`:10012`), `compute_targets` (`:10235`). Redirect `selectDay` single-day regen (`:8400`, reached by `regenerate_day` `:10027`) — in batch it must regenerate the whole **session** or be refused with an honest `notes[]` line (single-day breaks cook-once). **Preservation:** ensure `applyOperations` returns a profile with `planMode`/`batchCadence` intact (they ride `p` through the switch untouched — add a guard test), and every server op that replaces the profile client-side (`plan/page.tsx:538,656`; `AssistantChat.tsx:174`) preserves them.

**Tests to add:**
- `applyOperations(batchProfile, batchWeek, [op({tool:'regenerate_week'})])` → returned `plan.planMode==='batch'`, `sessions` present, `profile.planMode==='batch'`.
- `compute_targets` in batch → returned plan still batch-shaped (distinct < fresh).
- `regenerate_day` in batch → either whole-session regen (all its `coversDays` re-picked, cook-once intact) or refused with a `notes[]` string; assert one holds.
- Profile preservation: after any op, `result.profile.planMode === input.planMode`.
- Fresh regression: same ops on fresh `BASE` produce unchanged prior behavior (existing scenarios stay green).

**User-visible outcome:** Regenerating or re-computing targets while in batch mode keeps you in batch (previously would silently drop to fresh). No visible new feature — it stops a latent desync bug.

---

## M3 — Efficiency selection + cadence food-safety

**Goal (1 line):** Batch picks a genuinely ingredient-overlapping set, and weekly cadence honestly freeze-tags the days beyond fridge safety.

**Files/anchors:** `selectBatchWeek` (M1b) — promote the overlap tie-break to a **primary** objective: `score(r) = −Wfit·fitDistance + Woverlap·overlap(r) − r.approxCost`, `overlap` computed against the session-scoped staple set with the exact `i.name.trim().toLowerCase()` idiom (`:8078-8084`); deterministic tie-break `fitDistance asc → overlap desc → approxCost asc → id`. Add `keepDays(recipe)` — coarse curated deny-list of non-keeping ingredient tokens (leafy/delicate fish → 1-2; stew/grain/roast → 4; default 3, §d) plus a freeze-friendly deny check; **labels itself coarse** in UI. `partitionSessions` gains `weekly` freeze logic: `Batch.freezeFrom` = first placement index where day-offset > `keepDays`; `placements[].frozen=true` on the tail; engine `notes[]` "Cook Monday; freeze Thu–Sun portions." Cadence sub-control (`SidePanel`, shown only in batch) + weekly gated behind a "needs freezer space" confirm. Optional per-day macro-A/B-distance term in step-4 selection (§h.4) if M0 variance was high.

**Tests to add:**
- `keepDays` deny-list: a salad-token recipe → `<=2`; a stew/grain → `4`.
- Weekly cadence: `w = buildWeek({...BASE, planMode:'batch', batchCadence:'weekly'})` → some `placements` with `frozen===true` where day-offset > `keepDays`; `every3days` → **zero** frozen.
- Overlap: mean session ingredient-overlap % for batch `> ` a K-random baseline (payoff is real, not incidental).
- Per-day macro variance (§h.4): max per-day `|dayCalories − targetCalories|` across a rotated batch week within a stated tolerance.

**User-visible outcome:** Batch weeks visibly reuse shared staples; choosing weekly cadence shows honest "freeze these portions" labels instead of implying 6-day-old food is fine.

---

## M4 — Bulk grocery + efficiency metric

**Goal (1 line):** Groceries shows a per-session bulk shopping list in human pack sizes and an honest cook-events / overlap metric.

**Files/anchors:** **Fork, do not overload** `groceriesFromWeek` (`myPlan.ts:60-73` — its `count` means "appears in N slots", not "N× amount"). New per-session aggregator: per `Batch`, base per-serving ingredient qty → grams via `gramsFor` (`nutrients.ts:26-38`, client-safe) × `totalServings`, sum per ingredient key across session, re-format. New `formatBulkQuantity(name, grams)` (~30 lines) inverting `UNIT_GRAMS` + a small `PACK_SIZE` table keyed like `PRICE_MAP` (grain/meat→kg; beans/tomatoes→can; eggs→dozen), rounding **up** to whole packs; `gramsFor` nulls → coverage fraction + "check amount" row (`microsForIngredients` pattern, `:47-61`) — never silently dropped. Group by session then `groupByAisle` (`grocery.ts:53-62`, passes extra fields through). Metric: primary = cook-events (`sessions*dishes`) + ingredient-overlap %; **secondary** money-saved computed once, **not** stacked on `estimatePrice`'s built-in `packs = occurrences>=7?2:1` bulk (`plan/page.tsx:103`) — double-count guard. Render in `GroceriesClient.tsx:23-211` (per-session sections; `×N` badge `:151-156` becomes batch-aware). **Do not** import `scaleQuantity` from `recipeDb` into the client (bundle); keep math in `nutrients.ts`.

**Tests to add:**
- `formatBulkQuantity('rice', 1500)` → "1.5 kg"; `('canned tomatoes', 720)` → "≈2 × 400 g" (rounds up); unmapped unit → coverage down + "check amount".
- Per-session sum: a batch of `totalServings=6` yields 6× the per-serving grams for a `gramsFor`-mapped ingredient.
- Coverage fraction reported (0..1); a week with an unmapped seed string has coverage `<1`.
- `groceriesFromWeek` untouched: existing fresh grocery test still passes byte-identical.
- Money metric: if `batchPackCost >= freshPackCost`, metric reports "no saving" rather than inventing one.

**User-visible outcome:** In batch mode, Groceries becomes a "shop once per session" list in real pack sizes with a "you cook 6× instead of 21×" headline.

---

## M5 — Assistant integration ⚠️ CONTRACT CHANGE

**Goal (1 line):** "Switch me to batch / meal-prep" works in chat through the existing whole-plan front door, and per-batch edit semantics are coherent.

**⚠️ Flag — assistant contract change (update `ASSISTANT-SCHEMA.md`):** additive and backward-compatible (all new fields optional), but it extends the tool vocabulary, so the contract doc must be updated.

**Files/anchors:** `OperationSchema` (`types.ts:71`) — add optional `planMode`, `batchCadence` for `update_profile` (follows `mealsPerDay: z.union` precedent `:119`). `applyOperations` `update_profile` (`recipeDb.ts:9961`) — add `if (op.planMode) p.planMode = op.planMode` beside `if (op.diet)` (`:9962`); dispatch the rebuild block (`:9978-9994`) via `buildWeek`; a mode switch is a **re-theme** in spirit (`reTheme` gate `:9992`) → must NOT keep-path (that preserves 21 distinct fresh dishes, defeating batch). Route mode-switch/re-batch through `update_profile` (whole-plan rebuild, returns full plan, `planChanged` deep-compared `:10508`) — **not** the `changedDays`-only merge (`AssistantResponseSchema` `types.ts:56-59` **cannot express** a week-level structure + index, §g.7). Both front doors inherit it (`assistant/route.ts:81`, and v2 `runAgent→applyPrimitives→applyOperations` `agentLoop.ts:90` / `primitives.ts:187`). v2: add `planMode`/`cadence` to `ConstrainOp` (`primitives.ts:25`), emit in `expandConstrain` week branch (`:61-72`), add to `PrimitiveOpSchema` constrain object (`:212-228`). Op coherence: whole-week `swap_meal` (`:10052-10096`) replaces a whole batch; **one-day** `swap_meal` (`:10100+`) → whole-batch OR explicit "break out this day into a fresh one-off" (decrement `totalServings`, re-tag, surface in `notes[]`) — never a silent single-plate swap (§g.8); `lock_meal`/`rate_meal` target the whole batch by `batchId` (§g.9); `regenerate_day` per M2. **Two-layer honesty:** all servings/rotation/bulk math in `recipeDb.ts`, never prompts; `notes[]` are the only change claims (`composeReply` fills prose only when engine silent).

**Tests to add:**
- `applyOperations(BASE, freshWeek, [op({tool:'update_profile', planMode:'batch'})])` → `result.plan.planMode==='batch'`, `sessions` present, `planChanged===true`, `result.profile.planMode==='batch'`.
- `expandConstrain({scope:'week', planMode:'batch'})` → yields an `update_profile` Operation carrying `planMode`.
- One-day `swap_meal` on a batch plate → either whole-batch swap OR a `notes[]` "broke out … into a one-off" with that batch's `totalServings` decremented; assert no silent single-plate desync.
- `lock_meal` by `batchId` → all instances of that batch survive a subsequent `regenerate_week`.
- Read-only ops (`explain_meal`, `weekly_report`) unchanged in batch (`READ_ONLY_TOOLS` still report no plan change).

**User-visible outcome:** Typing "switch me to meal-prep mode" or "make it batch cooking, cook every 3 days" in the assistant rebuilds the whole week as batches and says what it did.

---

## M6 — Full render parity (UI only; gate = tsc + build)

**Goal (1 line):** Week, Today and mobile fully reflect batch structure with honest, mode-aware copy.

**Files/anchors:** `WeekBoard.tsx` — photo strip (`:127-151`) → cooking-session cards ("cook X, batch size N"); meal `<article>` (`:197-210`) gains a session pill. `weekStats.ts:60` `uniqueDishes` copy (shown `WeekBoard.tsx:82-84`, Home `page.tsx:124`) → mode-aware wording (batch intentionally repeats). `today/page.tsx:32-55` — currently maps `demoWeek().days[0]` and **ignores the saved week**; wire `loadMyWeek`/mode minimally: "today you eat batch X (cooked Monday)" honestly, or ship fresh-only with a stated note (§g.15 — full Today parity is a fast-follow). Mirror the toggle + cadence into `MobileNav` (`SideNav.tsx:75-102`) for `<lg`. **Flag:** a dedicated `/sage/cook` route is deliberately deferred (§g.14 — mode-swapped Week board is v1).

**Tests to add:** none to `test:engine` (UI). `weekStats` mode-aware helper is pure → add one assertion that its batch summary reports session/cook counts rather than "N distinct dishes." Gate on `tsc` + `npm run build`.

**User-visible outcome:** The Week board reads as a cooking plan (sessions + batch sizes + rotation pills), Today names the batch you're eating, and copy never claims variety batch doesn't have.

---

### Dependency graph & flags summary
- **Order:** M0 → **M1** (schema+engine+gate+toggle; the real slice) → M2 (rebuild parity) → M3 (efficiency+safety) → M4 (grocery) → M5 (assistant) → M6 (render parity). M3/M4/M5/M6 are independent of each other once M2 lands (M4 lightly wants M3's `Batch` fields; M6 wants M5's per-batch semantics for pills but degrades without).
- **Contract change:** M5 only (additive, optional-field-safe; update `ASSISTANT-SCHEMA.md`).
- **Data migration:** none in any milestone — all fields optional + default-filled; no versioning exists and none added.
- **Invariants preserved throughout (asserted by M1 tests, re-asserted each milestone):** per-serving DERIVED macros; `[0.6,1.8]` clamp untouched (bulk ×N lives on `Batch.totalServings`/`servingFactor` + shopping multiplier); `Meal.servings` never written on batch plates; base name intact for `baseRecipeOf`; `changedDays` contract unbroken (batch routes via whole-plan `update_profile`); `z.object` strip defeated by putting `sessions`/`batches` on `WeekPlanSchema`; all call sites gated via `buildWeek`; SVG-only no-emoji; `npm run test:engine` green before every push.

Key new engine files/exports to touch: `recipeDb.ts` (`selectBatchWeek`, `rebalanceBatchWeek`, `buildWeek`, `candidatesForSlot`, `partitionSessions`, `keepDays`), `types.ts` (`CookingSessionSchema`, `BatchSchema` + infers, optional profile/meal/week/op fields), `ai.ts:627` + `withPlanDefaults`, `storage.ts` `KEYS.batchPlan`, forked per-session grocery aggregator + `formatBulkQuantity` (in/near `nutrients.ts`), `primitives.ts` constrain extension, shell `SidePanel.tsx`/`layout.tsx` Mode context + new SVG icon.