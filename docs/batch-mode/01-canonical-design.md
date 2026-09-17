All anchors verify exactly (rebalancer lock guards at 8592 and 8702; update_profile rebuild + reTheme gate at 9978-9994; clamp at 8120; scaleQuantity unclamped at 8103-8114; ai.ts:627; schemas at types.ts:14-58). Here is the synthesized canonical design.

---

# NutriFlow — Batch-Cooking / Meal-Prep Mode: Canonical Design

*Synthesis of three lens-designs (engine-correctness, money/waste, food-safety/variety) into one coherent build. Every one of the 15 open questions is resolved in §(g). Every hard constraint in the map is honored. `file:line` cited throughout; anchors spot-verified against the working tree.*

**One-line thesis:** Batch mode is a *different way to fill the same 21-slot `WeekPlan`* — a small, ingredient-overlapping recipe set cooked in large portions and rotated across days — gated by one optional profile field, injected as a deterministic sibling at `ai.ts:627`, carried as a **strippable overlay index** (`sessions[]`/`batches[]`), and taught **once** to `applyOperations`. The `×N` bulk factor lives on a **new axis** (`Batch.totalServings` + a shopping multiplier), never on per-plate macros, never on `Meal.servings`, never through the `[0.6,1.8]` scalers.

---

## (a) Data model — all fields optional, all backward-compatible

Backward-compat has only two mechanisms in this repo (map §7): optional interface fields + server-side default-fill. No migration/versioning exists. Every field below is optional; absent ⇒ fresh.

**Extended existing schemas**

| # | Schema / interface | Location | Add |
|---|---|---|---|
| 1 | `UserProfile` interface (the durable carrier) | `types.ts:191` | `planMode?: 'fresh'\|'batch'`; `batchCadence?: 'weekly'\|'every3days'`; `batchVariety?: number` (the K knob, optional) |
| 2 | `WeekPlanSchema` | `types.ts:46` | `planMode: z.enum(['fresh','batch']).optional()`; `sessions: z.array(CookingSessionSchema).optional()`; `batches: z.array(BatchSchema).optional()` |
| 3 | `MealSchema` | `types.ts:19` | `batchId: z.string().optional()` — **single backlink only** (sessionId is derivable through the `batches` index; keep one field per Design-1's argument) |
| 4 | `OperationSchema` | `types.ts:71` | `planMode: z.enum(['fresh','batch']).optional()`, `batchCadence: z.enum(['weekly','every3days']).optional()` for `update_profile` (follows the `mealsPerDay: z.union([...])` precedent at `:119`) |
| 5 | `ConstrainOp` + `PrimitiveOpSchema` constrain variant | `primitives.ts:25`, `:212-228` | `planMode?`, `cadence?`; emit in `expandConstrain` week branch (`:61-72`) |
| 6 | `Recipe` interface | `recipeDb.ts:70` | **no change** — `servings?` (`:97`) stays untouched as the `deriveMacros` divisor |

**New schemas (beside `WeekPlanSchema`, `types.ts:46`; mirror the `notes?` precedent verbatim at `types.ts:49-51`; export `z.infer` types beside `types.ts:163`)**

```
CookingSessionSchema = z.object({
  id: z.string(),
  cookDay: z.enum(DAYS),                 // the day you cook
  coversDays: z.array(z.enum(DAYS)),     // days this session feeds — boundaries stored EXPLICITLY
  label: z.string().optional(),          // "Sunday batch"
})

BatchSchema = z.object({
  id: z.string(), sessionId: z.string(),
  recipeName: z.string(),                // EXACT base name — name-keyed lookup, kept intact (recipeDb.ts:8561-8562)
  slot: z.enum(MEAL_TYPES),
  totalServings: z.number().int().positive(),  // THE ×N — a NEW axis, never Meal.servings
  servingFactor: z.number(),             // the clamp-free per-serving scale actually applied
  perServing: z.object({ calories, proteinGrams, carbsGrams, fatGrams, fiberGrams: z.number().optional() }),  // audit copy of the one plated portion
  placements: z.array(z.object({ day: z.enum(DAYS), slot: z.enum(MEAL_TYPES), frozen: z.boolean().optional() })),
  keepDays: z.number().optional(),       // derived shelf-life (see §d); audit/trace
  freezeFrom: z.number().int().optional(),
  bulkIngredients: z.array(IngredientSchema).optional(),  // per-session bulk list snapshot
})
```

**Why `sessions`/`batches` MUST be on the schema, not just the object:** `z.object` strips unknown keys (no `.passthrough` anywhere), so on the `PLAN_ENGINE=llm` validate path (`ai.ts:229` `zodOutputFormat`, `:401` safeParse) they would silently vanish. The default DB path never parses, but `WeekPlan = z.infer<typeof WeekPlanSchema>` (`types.ts:163`) needs the TS type regardless. The stamped `WeekPlan.planMode` also lets the plan **echo** the mode it was built in, so profile and plan cannot silently desync.

**Overlay, not first-class (Q4):** `DayPlan.meals` stays the single source of truth; each batch instance IS a normal, fully-populated `Meal` (one serving, per-serving derived macros, base name intact) carrying only an optional `batchId`. `sessions[]`/`batches[]` are a projection that can be stripped without breaking a single render. This is what keeps `WeekBoard.tsx`, `TodayClient`, `GroceriesClient`, `weekStats.ts`, `rebalanceWeek`, `applyOperations`, and the `planChanged` deep-compare (`recipeDb.ts:10508`) operating on `Meal[]` with zero change.

**The servings-divisor guard (hard constraint):** the batch `×N` is `Batch.totalServings`, a new field. `Meal.servings` (`types.ts:33`) is **never** written on a batch plate — it stays the divisor in `deriveMacros` (`:154-158`), `recipeMicros` (`:7951-7954`), and `weekMicroAverage` (`:8841`). Note `MealSchema`'s own comment (`types.ts:29-32`) already reserves `servings` for "how many servings this ingredient LIST makes" — a distinct concept from the cook multiplier; conflating them corrupts all four divisions.

**Storage (`storage.ts`):** `planMode`/`batchCadence` ride `UserProfile` (persisted under the existing `KEYS.profile`), so they survive hard refresh and flow through `/api/plan`'s unvalidated cast (`route.ts:11`) with zero route edits. Add **one** new key `KEYS.batchPlan` in `KEYS` (`:7-15`) — never inline (`savedStore.ts:36-39` records the drift that cost an audit) — to cache the non-active mode's week for instant lossless toggling; `KEYS.plan` (`:8`) remains the active-view week. `clearAll()` (`:77-79`) auto-covers it. Default `planMode:'fresh'` via a new `withPlanDefaults()` beside `withTargetDefaults` (`ai.ts:26-36`), because nothing enforces the enum at runtime.

---

## (b) The batch allocation algorithm — deterministic, step by step

**Injection (`ai.ts:627`, AHEAD of the `PLAN_ENGINE` check), via one dispatch helper that covers ALL rebuild sites:**

```ts
// helper — the single mode gate
export function buildWeek(p: UserProfile): WeekPlan {
  return p.planMode === "batch" ? buildBatchWeek(p) : rebalanceWeek(selectWeekFromDb(p), p);
}
// ai.ts:627 becomes:
if (process.env.PLAN_ENGINE !== "llm") return buildWeek(p);   // was: rebalanceWeek(selectWeekFromDb(p), p)
```

`planMode==='batch'` **forces the DB engine regardless of `PLAN_ENGINE=llm`** (Q3) — the LLM path cannot express servings/rotation. `buildWeek` must also be called at every other rebuild site or single-day regen and demo stay on fresh behavior: `update_profile` rebuild (`recipeDb.ts:9993`), `regenerate_week` (`:10012`), `compute_targets` (`:10235`), and `demo.ts` (so a batch demo obeys the one-fixture rule, `demo.ts:53-65`). `selectDay` single-day regen (`:8400`) is redirected in batch (see §f/Q8).

**`buildBatchWeek(p) = rebalanceBatchWeek(selectBatchWeek(p), p)`** — a deterministic sibling of `selectWeekFromDb` (`recipeDb.ts:8337`). No `_rng` (bypass the random tie-break `:8095-8097`); ties broken by `recipe.id` (stable). It uses **no shared `WeekCtx` dedup** and **bypasses `chooseRecipe`'s three variety gates** (pool dedup `:8018-8020`, `proteinDays<3` `:8023-8024`, new-cuisine `:8026-8027`), because batch *inverts* the distinct-dish contract those gates enforce.

**`selectBatchWeek(profile)`:**

1. **Sessionize.** `sessions = partitionSessions(DAYS, cadence)` (§d). Chunk the fixed Mon–Sun `DAYS` array into windows; each window's first day is `CookingSession.cookDay`, its member days `coversDays`. `every3days` → `[Mon,Tue,Wed][Thu,Fri,Sat][Sun]`; `weekly` → `[Mon..Sun]`. Boundaries are stored as day-name arrays so nothing downstream depends on array position.
2. **Per session, per `[type, share]` in `localSplit(mealsPerDay)`** (`:8346`, defn `:7868`), build the candidate pool by **reusing the `pickMealsForDay` pipeline unchanged**: hard filter (type + `!treatOnly` + `passesDiet` + `!blockedByExclusions`, `:8258-8264`), soft-relax (ingredient cap → budget → cook-time, `:8271-8281`), `bannedForUser` (`:8286-8290`), `cuisinePref` (`:8291-8294`). It must **not** mark `ctx.usedIds/usedNames` (`:8315-8319`) — its repeats are intentional. Extract this filter block into a shared `candidatesForSlot(profile, type)` helper (no behavior change to fresh; both callers use it).
3. **Slot target is constant across the window:** `target = round(profile.targetCalories * share)` (same formula as `:8229`). This constancy is what makes every serving of a batch identical.
4. **Choose the small set (K distinct dishes/slot).** `K = min(coversDays.length >= 4 ? 3 : 2, pool.length)`, overridable by `batchVariety`; relax down honestly with a `notes[]` line if the pool can't supply K (restrictive diets — vegan protein is capped at ~2 sources per MEMORY). Anchor dish #1 = min `fitDistance` (reuse `:8054-8073` verbatim). Pick dishes #2..K **greedily on a shared-ingredient objective**, promoting the existing overlap primitive from a top-8 tie-break to a **primary term**:
   `score(r) = −Wfit·fitDistance(r) + Woverlap·overlap(r) − r.approxCost`,
   where `overlap(r) = r.ingredients.filter(i => sessionIngredients.has(i.name.trim().toLowerCase())).length` — the exact idiom at `:8078-8084`, but against a **session-scoped** growing staple set, not the week's. Push each pick's ingredients into `sessionIngredients`. `Woverlap` is tuned so that among dishes inside a `fitDistance` tolerance band, the one reusing the most staples wins (this is where the money/waste payoff comes from — fewer distinct perishables). Deterministic tie-break: `fitDistance` asc → overlap desc → `approxCost` asc → `recipe.id`.
5. **Scale ONCE per serving.** For each chosen dish, `serving = scaleRecipeToTarget(dish, target)` (`:8119`) — the `[0.6,1.8]` clamp is **correct here** because a single plate legitimately lives in that band. `{...r}` preserves `r.name` (`:8122`). Compute one `servingFactor = serving.calories / dish.calories` and reuse it for every instance of that batch, so the plates are byte-identical and "cook N servings" is honest.
6. **Distribute + rotate.** For each covered day `i`, `slotDish = chosen[(i + slotPhase(type)) % K]` with `slotPhase = slot index` so two adjacent days differ in *every* slot, not just one (Design-3's rule). Each placed `Meal` is an identical copy of the step-5 serving + `batchId`. `Batch.totalServings` = its placement count.
7. **Macro-balance the phase** (no new dishes): among the small set of phase offsets, keep the assignment minimizing `max` per-day `|dayMacros − target|`. Both dishes were `fitDistance`-picked to the same target, so every phase is close; this just picks the best. Deterministic.
8. **Build the overlay.** One `Batch` per (session, dish) with `totalServings`, `servingFactor`, `perServing` snapshot, `placements[]`, `keepDays`, `freezeFrom` (§d); one `CookingSession` per window; attach `sessions[]`/`batches[]` and stamp `planMode:'batch'`.

**`rebalanceBatchWeek(plan, profile)`:** run the normal per-day rebalance but pass every batch-tagged slot's *type* as `LockedSlots` for that day (map §3 hazard). In a pure-batch day (all slots batched), `scaleToTargets` returns `adj.length===0 → meals` unchanged (`recipeDb.ts:8594`) and lever-2 skips every locked slot (`locked?.has(cur.type)` continue, `:8702`) — an honest no-op, equivalent to Design-1's "freeze at step 5." But if a day carries a **non-batch slot** (a snack the user didn't batch, or a mixed configuration), that slot still balances the day. This reconciles Design-1 (never desync a cook) with Designs-2/3 (still tune free slots): batch instances are frozen; free slots absorb.

**Reused unchanged:** `candidatesForSlot` filter/relax pipeline, `fitDistance`, `localSplit`, `budgetCap`, `exclusionTokens`, `scaleRecipeToTarget`, `toMeal`, `rebalanceDay`'s locked-slot machinery, and the whole-week swap path (`:10052-10096`) as the reference for batch-swap semantics. **Bypassed:** shared `newCtx()`/`WeekCtx` dedup, `chooseRecipe`'s three variety gates, the `_rng` tie-break, and the per-slot `keep` used-marking (`:8246-8250`, which would treat batch's own repeats as collisions).

---

## (c) Macro correctness & rebalancer protection

- **Each day eats ONE serving.** The plated `Meal` carries the per-serving macros produced once by `scaleRecipeToTarget` at step 5. No per-plate `×N` is ever applied to macros — identical to fresh mode's plate. Macros stay DERIVED (`deriveMacros:137-160`, `RECIPES` built once `:7862`).
- **The `×N` lives off the macro axis, in two places only:** `Batch.totalServings`/`servingFactor` (how many identical servings the pot yields) and a session-level **shopping multiplier** (§e). It never touches the clamped scalers (`scaleRecipeToTarget:8120`, `SCALE_LO/HI:8499-8501` via `clampScale`), which cannot represent a 3–7× cook, and never touches `Meal.servings` (the overloaded divisor). The 3–7× reaches the grocery list through summed grams × `totalServings` (§e), not through any macro path.
- **All instances byte-identical** (same `servingFactor`), so no cross-day desync exists and the `planChanged` deep-compare (`:10508`) behaves.
- **Rebalancer protection (verified hazard).** `rebalanceWeek` calls `rebalanceDay` with `locked=undefined` (`:8753`): lever-1 `scaleToTargets` would give each instance a *different* factor (`:8593`) — desyncing the cook — and lever-2 could **upgrade-swap one instance** (`:8699-8734`) — breaking cook-once. Defense: `buildWeek` substitutes `buildBatchWeek` at every rebuild site, and `rebalanceBatchWeek` passes all batch slot-types as `LockedSlots` — lever-1 filters `!locked?.has(x.m.type)` (`:8592`) and lever-2 `continue`s on `locked?.has(cur.type)` (`:8702`). Verified: `LockedSlots = ReadonlySet<Recipe["type"]>` (`:8586`); within a day each type appears once, so type-lock == slot-lock.
- **Base name intact.** `scaleRecipeToTarget` spreads `{...r}` preserving `r.name` (`:8122`), so `baseRecipeOf`'s lowercased-name lookup (`:8561-8562`) resolves every batch plate; the portion factor stays re-derivable as `meal.calories / base.calories` (`:8593`, `:9755`). Batch never renames a dish.
- **Per-day precision tradeoff, stated honestly.** Because batch instances are locked, a batch day hits its macro targets slightly less finely than a fresh day (which gets full gradient-descent). This is the inherent cost of cook-once; it is surfaced in `notes[]` and the week copy never claims per-day precision it doesn't have. Any non-batch slot still rebalances to compensate.

---

## (d) Cadence, rotation & food safety

- **Cadence enum** `batchCadence ∈ {'weekly','every3days'}` (the two food-safe shapes; matches the `mealsPerDay` `z.union` enum precedent, `:119`). Boundaries stored explicitly on `CookingSession.coversDays`, mapped onto the fixed Mon–Sun `DAYS` by chunking; a trailing window `≤ floor(daysPerSession/2)` merges into the previous one. `every3days` → cook Mon (serves Mon–Wed) + Thu (serves Thu–Sun); `weekly` → cook Mon (serves Mon–Sun).
- **Rotation rule (net-new logic):** K distinct dishes/slot/session, round-robin with `slotPhase = slot index`. K≥2 guarantees no slot repeats on consecutive days; per-slot phase-stagger guarantees no two *whole* adjacent days are identical. K defaults to 2 for a 3-day window (A,B,A), 3 for a 7-day weekly window (so 7 days aren't 6 dishes eaten monotonously). K=1 collapses to pure repetition (rejected); K=window-length collapses to fresh.
- **Food safety is first-class.** Cooked food keeps ~3–4 days refrigerated. **`every3days` is the SAFE DEFAULT** the toggle picks when batch is switched on: every portion is eaten ≤2 days after its cook, zero freezing, zero user effort — which is *precisely why* it's recommended over weekly. **`weekly`** forces days 4–7 to be eaten 3–6 days out, exceeding fridge safety, so those placements are **freeze-tagged**: `Batch.freezeFrom` = first placement index where day-offset > `keepDays`, and `placements[].frozen = true` for the tail. Shown on the session card, the batch, and the engine `notes[]` ("Cook Monday; freeze the Thu–Sun portions, thaw the night before") — never hidden. `weekly` is honestly gated behind a "you'll need freezer space" confirm.
- **Shelf life derived (`Recipe` has no such field, verified `:70-101`):** `keepDays(recipe)` = a small curated deny-list of non-keeping ingredient tokens (leafy salad / delicate fish → 1–2; stews/grains/roasts → 4; default 3). Dishes chosen for frozen tails must pass a freeze-friendly check (deny poor freezers). v1 is deliberately coarse and **labels itself as such** in the UI — a coarse heuristic honestly disclosed beats a precise-looking lie. This is the design's largest data gap and is surfaced, not buried.

---

## (e) Efficiency: bulk grocery + metric

- **Selection already weights shared ingredients** (§b step 4): the promoted overlap primitive (`recipeDb.ts:8078-8084`) against a session-scoped staple set means the small set deliberately shops from one overlapping pile — the concrete "bulk buy covers several dishes" payoff. Same primitive `explain_meal` already uses (`:9206-9213`).
- **Per-session bulk grocery list (net-new; FORK, do not overload `groceriesFromWeek`):** `groceriesFromWeek` (`myPlan.ts:60-73`) keeps the first-seen quantity and only counts appearances (`×3` = "in 3 slots", not "3× the amount") — wrong for a bulk cook (Q12). For each `Batch`, take the base recipe's per-serving ingredient quantities, convert to grams via `gramsFor` (`nutrients.ts:26-38`, client-safe), multiply by `totalServings`, sum per ingredient key across the session's batches, then re-format. `gramsFor` nulls (unmapped ingredient/unit) lower a **coverage fraction** and the row shows "check amount" (the `microsForIngredients` pattern, `nutrients.ts:47-61`) — never silently dropped. Group by session, then `groupByAisle` (`grocery.ts:53-62`, generic, passes extra fields through) within each.
- **The missing formatter (net-new ~30 lines):** no grams→human formatter exists — `scaleQuantity` (`:8103-8114`, verified unclamped) only multiplies an existing string. Add `formatBulkQuantity(name, grams)` inverting `UNIT_GRAMS` + a small `PACK_SIZE` table keyed like `PRICE_MAP` (grain/meat → kg; beans/tomatoes → 240 g can; milk → L; eggs → dozen), rounding **up** to whole packs: "1.5 kg", "≈2 × 400 g cans", "1 dozen". `gramsFor`/`UNIT_GRAMS` live in the light `nutrients.ts` (client-importable); do **not** pull `scaleQuantity` from `recipeDb` into the client.
- **Efficiency metric, no double-counting:** primary = **(a) cook events** = `sessions.length × dishes` (weekly ≈ 6, every3days ≈ 6 over 2 sessions vs fresh's 21) — the honest headline — and **(b) ingredient overlap %** = `1 − distinct / total occurrences` per session — the real waste signal. **(c) money saved is SECONDARY** and computed once as `freshPackCost − batchPackCost`, both from the same per-serving/`approxCost` basis (`recipeDb.ts:82`). It must **not** be layered on top of `estimatePrice`/`PRICE_MAP` (`plan/page.tsx:61-105`), which *already* bakes in "a pack covers several meals" (`packs = occurrences>=7 ? 2 : 1`, `:103`) — stacking a batch discount on it double-counts (Q11). If `batchPackCost` isn't clearly below `freshPackCost`, the metric says so rather than inventing a saving.

---

## (f) Mode toggle UX + live propagation + assistant integration

- **Toggle home:** the `SidePanel` footer (`SidePanel.tsx:97-112`) — the single chrome in every route's payload — a **2-state** `Fresh | Batch` segmented control (SVG only; a new pot/stack icon in `icons.tsx`, no emoji), plus a **secondary cadence control** (`every-3-days | weekly`) shown only in batch, near the batch UI, because cadence is a food-safety decision that deserves the freeze-tagging explanation (Q13). It must survive the collapsed 76px rail as a single icon (`!open` → `flex-col px-0`, text hidden `:99-108`) and **mirror into `MobileNav`** (`SideNav.tsx:75-102`) for `<lg`. Not `ThemeSwitch` — it `return null`s on `/sage` (`ThemeSwitch.tsx:34`); the control is built inside the shell.
- **Live propagation:** every data route holds its own `useState` and reads storage once in `useEffect([])` (`WeekBoard.tsx:37-51`, `GroceriesClient:30-42`, `AssistantChat:90-97`), so a bare `localStorage` write won't re-render a mounted sibling. Add a **shared Mode context provider in `layout.tsx`** (`:45-58`, the one component every route shares; server pages stay server, client leaves subscribe). The toggle writes `profile.planMode` (through `storage.ts`) + updates context; subscribers re-read.
- **Source of truth = `profile.planMode`** (rides `saveProfile`, flows through `/api/plan`'s unvalidated cast `route.ts:11`). The built `WeekPlan` **echoes** `planMode` so a failed rebuild POST (profile=batch, plan=fresh) is detectable and the UI offers regenerate. Both weeks cached under `KEYS.plan` + `KEYS.batchPlan` for instant lossless toggling (Q1/Q2). **Preservation hazard:** every server op returning a profile (`plan/page.tsx:538,656`; `AssistantChat.tsx:174`) MUST preserve `planMode`/`batchCadence`, or a chat action silently drops the mode. Switching is a **re-theme** in spirit (Q2/§reTheme `:9992`), so a mode with no cache rebuilds from scratch (must NOT use the keep-path, which preserves fresh's 21 distinct dishes and defeats batch); a mode with a cache re-views instantly.
- **Render surface (Q14):** mode-swap the existing **Week** board rather than add a `/sage/cook` route in v1 — the photo strip (`WeekBoard.tsx:127-151`) becomes cooking-session cards ("what to cook + batch size"), the meal `<article>` (`:197-210`) gains a session pill. `summariseWeek.uniqueDishes` copy (`weekStats.ts:60`, shown at `WeekBoard.tsx:82-84`, Home `:124`) needs mode-aware wording since batch intentionally repeats. **Groceries** is mode-aware in v1 (per-session bulk list is core). **Today** is best-effort: it currently ignores the saved week entirely (`today/page.tsx` maps `demoWeek().days[0]`), so batch-awareness there is net-new wiring — v1 says "today you eat batch X (cooked Monday)" honestly or ships fresh-only with a stated note; full Today parity is a fast-follow (Q15).
- **Assistant under the changedDays-only contract:** `AssistantResponseSchema` returns only `changedDays` (`types.ts:56-59`), which **cannot express a week-level re-batch** (a whole-week structure + `sessions[]`/`batches[]` index). Resolution (Q7): route mode-switch and re-batch through **`update_profile`** (`recipeDb.ts:9961`), which already rebuilds the ENTIRE plan and returns it whole (not `changedDays`); `planChanged` is deep-compared (`:10508`) on all three front doors, and v2 `runAgent → applyPrimitives → applyOperations` (`agentLoop.ts:90`) inherits it. Add `if (op.planMode) p.planMode = op.planMode` beside `if (op.diet)` (`:9962`) and dispatch the rebuild block (`:9993`) via `buildWeek`. Strongly preferred over a new `set_plan_mode` op (needs an enum entry `types.ts:72-94` + switch case + verb-map entry `primitives.ts:126` — unjustified; `planMode` is week-wide exactly like `diet`). **Op coherence:** `update_profile`/`regenerate_week`/`compute_targets` COHERENT once their rebuild sites call `buildWeek`; whole-week `swap_meal` (no day, `:10052-10096`) COHERENT and replaces a whole batch; `scale_portions`/`lock_meal`/`unlock_meal`/`log_meal`/`eating_out`/`rate_meal`/`substitute_ingredient`/`explain_meal`/`weekly_report`/`hydration`/`undo`/`answer` mode-agnostic (`undo` swaps whole plan+profile `:10374-10378`, restores a batch week fine). **INCOHERENT → new semantics:** `regenerate_day`/`selectDay` (rebuilds ONE day, breaks cook-once) must regenerate the whole SESSION or be refused with an honest note; one-day `swap_meal` (`:10100+`) must swap the whole BATCH or "break out" that one day into a fresh one-off (decrements `totalServings`, re-tags, surfaced in `notes[]`) — never a silent single-plate swap (Q8). `lock_meal`/`rate_meal` target the whole batch by `batchId` (Q9). Two-layer honesty holds: all servings/rotation/bulk math lives in `recipeDb.ts`, never in prompts; `notes[]` from `applyOperations` are the only change claims; `composeReply` (`reply.ts`) fills prose only when the engine is silent.

---

## (g) Resolved open questions (all 15)

1. **Profile vs per-plan?** → **`profile.planMode` is source of truth**, `WeekPlan.planMode` echoes it, both weeks cached under `KEYS.plan` + `KEYS.batchPlan`. *Rationale: switch-at-any-time needs a durable carrier that rides `saveProfile` and every server op; the echo prevents desync; dual-cache makes the toggle instant and lossless.*
2. **Regenerate or re-view on switch?** → **Re-view the cached week instantly if present; regenerate once (with a loading/confirm state) if not.** *Rationale: never discard in-progress cooking; a first switch to a mode builds, subsequent toggles are free.*
3. **Force DB engine when batch?** → **Yes**, ahead of the `PLAN_ENGINE` check at `ai.ts:627`. *Rationale: the LLM path cannot express servings/rotation; batch is a deterministic DB concept.*
4. **First-class or overlay?** → **Overlay index.** `meals[]` stay source of truth; `Meal` gets an optional `batchId`; `sessions[]`/`batches[]` are strippable. *Rationale: every existing render/engine surface keeps working unchanged; optional-fields-only backward-compat.*
5. **Cadence encoding?** → **Fixed enum `'weekly'|'every3days'`; boundaries stored explicitly as `CookingSession.coversDays` day-name arrays**, chunked from the fixed Mon–Sun `DAYS`. *Rationale: two food-safe shapes; explicit day arrays leak no index arithmetic; matches the `mealsPerDay` enum precedent.*
6. **Rotation rule?** → **K distinct dishes/slot (2 for 3-day, 3 for weekly), round-robin with `slotPhase = slot index`.** *Rationale: K≥2 breaks consecutive repeats, phase-stagger makes whole adjacent days differ; net-new logic.*
7. **Assistant week-level re-batch under changedDays?** → **Route through `update_profile` (whole-plan rebuild, returns full plan, `planChanged` deep-compared), not the changedDays merge.** *Rationale: changedDays cannot express a week structure + index; `update_profile` is the existing whole-week front door and both assistants inherit it.*
8. **Batch swap/regenerate semantics?** → **Whole-week swap replaces the whole batch; one-day swap defaults to whole-batch or offers an explicit "break out this day into a fresh one-off"; `regenerate_day` regenerates the whole session or is refused.** *Rationale: a single-plate swap desyncs the physical cook; the whole-batch path mirrors the existing whole-week swap (`:10052-10096`); the escape hatch is honest and surfaced in `notes[]`.*
9. **Batch identity vs name-keyed `lockedMeals`?** → **Pin/rate targets the whole batch by `batchId`** (name-keyed `lockedMeals` `:172-189` still resolves because the base name is intact, but semantics become "keep this batch"). *Rationale: the unit of intent under cook-once is the batch, not one slot.*
10. **Bulk unit?** → **Summed grams via `gramsFor` × `totalServings`, then a new `formatBulkQuantity` (PACK_SIZE table) → "1.5 kg"/"2 cans"; unresolved rows show "check amount".** *Rationale: grams is the only precise basis, packs are what humans buy, and an honest fallback beats a fabricated count.*
11. **Efficiency metric?** → **Primary: cook-events + ingredient-overlap % (both double-count-free). Secondary: money saved, computed once, never stacked on `estimatePrice`'s built-in bulk.** *Rationale: cook-events/overlap are honest and direct; `PRICE_MAP` already assumes bulk, so a second discount double-counts.*
12. **Consolidate aggregators or fork?** → **Fork a batch-specific per-session aggregator; reuse `groupByAisle` within each session; leave `groceriesFromWeek` untouched.** *Rationale: its `count` means "appears in N slots", not "N× amount" — genuinely different math.*
13. **Control placement?** → **SidePanel footer, 2-state `Fresh|Batch` (degrades to one rail icon, mirrored into `MobileNav`) + a secondary cadence control shown only in batch.** *Rationale: the footer is the only chrome in every route payload; 2-state keeps the rail simple; cadence needs explanation, so it's secondary not a third segment.*
14. **New `/sage/cook` route or mode-swapped Week?** → **Mode-swapped Week board in v1** (photo strip → session cards; meal articles → session pills). *Rationale: reuses the existing render seam; a dedicated `/cook` can follow without blocking v1.*
15. **Today/Groceries mode-aware in v1?** → **Groceries yes (core to the payoff); Today best-effort with an honest note (it currently ignores the saved week); Week + Groceries are the v1 batch surfaces.** *Rationale: don't imply parity Today can't yet deliver; wire it minimally and say so.*

---

## (h) Riskiest assumptions to validate first

1. **Recipes bulk-cook sensibly.** The library scales fine to a per-serving target within `[0.6,1.8]`, but some dishes (a single fish fillet, a fried egg, plating-sensitive dishes) don't naturally batch at 3–7×. The candidate pool likely needs a **"batchable" heuristic** (count/mass ingredients scale cleanly; garnish-heavy/plated don't) before selection. *Validate: sample the pool a batch week actually picks and eyeball whether each is a plausible bulk cook.*
2. **Shelf life is not uniform.** `keepDays()` uses a coarse deny-list because `Recipe` has no shelf-life/freezability field (`:70-101`). Worst case it labels a poor freezer (leafy salad, delicate fish) as freezer-safe. *Validate: audit the deny-list against the dishes weekly-cadence actually freeze-tags; consider an optional per-recipe `keeps?`/`freezes?` field.*
3. **`gramsFor` coverage is high enough that the bulk list is trustworthy.** Nulls fall to "check amount"; if coverage is low on real seed strings, the bulk list is misleadingly incomplete and the money metric is soft. *Validate: run `gramsFor` over every ingredient string in a batch week and report the coverage fraction before shipping the metric.*
4. **Per-day macro accuracy survives 2-dish rotation.** If the two dishes in a slot diverge in macro profile, alternating them swings daily protein/fat even after the phase search. Step-4 selection may need to also minimize the **A/B macro distance**, not just each dish's distance to target. *Validate: measure per-day macro variance across a rotated batch week vs the fresh week.*
5. **Variety at K=2/3 holds for restrictive diets.** Vegan protein variety is capped (~2 sources, per MEMORY `recipe-db-constraints`); a vegan/keto batch week may not supply K distinct dishes and must relax K with an honest note rather than fake variety. *Validate: build batch weeks for vegan/keto/low-budget profiles and confirm K relaxes gracefully with disclosure.*

---

**Net build surface:** one optional profile field, one `buildWeek` gate at every rebuild site (`ai.ts:627`, `recipeDb.ts:9993/10012/10235`, `demo.ts`), a deterministic sibling `selectBatchWeek` + `rebalanceBatchWeek`, an additive overlay index, one taught op (`update_profile`), a forked per-session grocery aggregator + `formatBulkQuantity`, a shell-built 2-state toggle + Mode context, and a new SVG session icon — with per-serving derived macros, the `[0.6,1.8]` clamp, `Meal.servings`, name-keyed base lookup, the changedDays contract, and `z.object` strict-strip all left untouched. Gate every push on `npm run test:engine` (map §7).