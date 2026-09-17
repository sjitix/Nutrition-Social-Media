Anchors verified (types.ts:19-52 schemas, ai.ts:621-629 branch, recipeDb.ts:8119-8131 clamp all exact). The maps are accurate. Producing the consolidated document below.

---

# NutriFlow — Current-State Map for a Batch-Cooking / Meal-Prep Planning Mode

*Grounded synthesis of 7 subsystem maps. All `file:line` anchors spot-verified against the working tree. This document is the design phase's ground truth: what exists today, the minimal seams to extend, and the invariants batch mode must not break.*

---

## 1. How planning works today (the fresh path, end to end)

There is exactly **one generation entry** and **one write core**; everything funnels through them.

**Build a week (fresh):**
1. A client POSTs the raw `UserProfile` JSON to `/api/plan`. Three call sites do this: onboarding submit (`src/app/onboarding/page.tsx:145-149`), sage `generateMyWeek` (`src/app/sage/myPlan.ts:34-38`), classic `regeneratePlan` (`src/app/plan/page.tsx:596-600`).
2. `src/app/api/plan/route.ts:8-32` parses the body `as UserProfile` (`:11`, **no zod validation**), calls `resolveProvider()` (`:16`); demo → `buildDemoPlan(profile)` (`:18`), else `generatePlan(profile)` (`:22`).
3. **`generatePlan(profile)` — `src/lib/ai.ts:621-629`** is THE entry. `withTargetDefaults(p)` (`:622`, defn `ai.ts:26-36`) fills defaults, then the single dispatch line `ai.ts:627`: `if (process.env.PLAN_ENGINE !== "llm") return rebalanceWeek(selectWeekFromDb(p), p);` — the **default deterministic DB engine**. Only `PLAN_ENGINE=llm` reaches `localGeneratePlan`/`claudeGeneratePlan` (`:628`).
4. **`selectWeekFromDb(profile, …)` — `recipeDb.ts:8337-8396`** builds the week. `split = localSplit(mealsPerDay)` (`:8346`, defn `7868`, 3 slots or 4 with snack), `cap = budgetCap`, `tokens = exclusionTokens`, and **ONE shared `ctx = newCtx()`** (`:8349`, defn `8167` = `{proteinDays, usedIds:Set, usedNames:Set, usedIngredients:Set}`). This single ctx threaded through all 7 days **is the whole-week de-dup/variety mechanism**. `days = DAYS.map(day => pickMealsForDay(…, ctx, …))` (`:8381-8387`). Returns a **raw object literal** `{days, weekSummary}` (`:8392-8395`) — **never parsed through `WeekPlanSchema`**.
5. **`pickMealsForDay` — `recipeDb.ts:8215-8324`**: per `[type,share]` in split, `target = round(targetCalories*share)` (`:8229`). Builds hard filter (type + `!treatOnly` + `passesDiet` + `!blockedByExclusions`, `:8258-8264`), soft-relax stages (ingredient cap → budget → cook-time, `:8271-8281`), ban + cuisinePref filters, then `chooseRecipe(...)` (`:8295-8310`). On a pick it marks `ctx.usedIds/usedNames` (`:8315-8316`), increments `proteinDays` (`:8317`), and pushes `toMeal(scaleRecipeToTarget(pick, target))` (`:8320`).
6. **`chooseRecipe` — `recipeDb.ts:8016-8098`** IS the distinct-dish engine: pool filter `!usedIds.has && !usedNames.has` (`:8018-8020`, relaxes only if pool empties `:8021`), `proteinDays[mainProtein] < 3` cap (`:8023-8024`), new-cuisine-per-day filter (`:8026-8027`), `fitDistance` macro rank (`:8054-8073`), top-8 window (`:8077`), secondary ingredient-reuse/cost score (`:8078-8094`), **random tie-break** (`:8095-8097`, `_rng` seam at `8983`/`withSeed` `8003`).
7. **`rebalanceWeek(plan, profile)` — `recipeDb.ts:8743-8758`** post-solves macros per day via `rebalanceDay` (`8681`): LEVER 1 `scaleToTargets` portion gradient-descent within `[0.6,1.8]` (`8588-8655`), LEVER 2 protein UPGRADE-swap avoiding cross-day repeats (`avoidNames`, `:8700-8740`). `baseRecipeOf` maps a Meal→Recipe by **lowercased name** (`:8561-8562`).
8. Client stores the whole response: `savePlan(data.plan)` (onboarding `:153`, `myPlan.ts:44`, `plan/page.tsx:605`).

**Reload:** classic `plan/page.tsx:164-179` (`loadProfile`+`loadPlan`, else redirect to `/onboarding`); sage `myPlan.loadMyWeek()` (`myPlan.ts:25-30`, null → demo shown).

**Edits (assistant/buttons)** all funnel to **`applyOperations(profile, plan, operations, previous?)` — `recipeDb.ts:9898`**, returning `{plan, profile, notes, replyOverride, planChanged, profileChanged, undone}`. `planChanged` is **MEASURED, not inferred**: `JSON.stringify(curPlan) !== JSON.stringify(plan)` (`:10508`). Two front doors: legacy `/api/assistant` → `parseAssistantTurn` → `applyOperations` (`assistant/route.ts:81`) and button `/api/operation` (`operation/route.ts:59`); v2 agent loop `/api/assistant-v2` → `runAgent` (`agentLoop.ts:90`) → `applyPrimitives` (`primitives.ts:161`) → **the same `applyOperations`** (`primitives.ts:187`). **Teach batch once here, both assistants inherit it.**

---

## 2. The data contract — current shapes + minimal backward-compatible extension

All shared shapes live in `src/lib/types.ts`. Two are zod (`Meal`, `WeekPlan`); `UserProfile` and engine `Recipe` are **plain TS interfaces with NO zod schema anywhere** (grep `UserProfileSchema`/`ProfileSchema` = 0 hits).

**Current shapes:**
- `IngredientSchema` (`types.ts:14-17`): `{name, quantity: string}` — quantity is **free-text** ("1 can", "70 g dry", "1/2 piece").
- `MealSchema` (`types.ts:19-39`): `{name, type∈MEAL_TYPES, description, calories, proteinGrams, carbsGrams, fatGrams, fiberGrams?, timeMinutes, servings?, sourceUrl?, ingredients[], steps[]}`. **`servings?` already exists (`:33`)** — comment (`:29-32`): "how many servings this INGREDIENT LIST makes; macros are per SERVING; nutrients must be divided by this."
- `DayPlanSchema` (`types.ts:41-44`): `{day∈DAYS, meals: Meal[]}`.
- `WeekPlanSchema` (`types.ts:46-52`): `{days, weekSummary, notes?}`. **`notes?` (`:49-51`) is the canonical precedent** for a backward-compatible optional add: "Optional so every existing plan and API response stays valid without one."
- `AssistantResponseSchema` (`types.ts:56-59`): `{reply, changedDays: DayPlan[]}` — **assistant returns ONLY changed days; server merges per-day**.
- `OperationSchema` (`types.ts:71-153`): v1 flat tool-call union; `tool` the only required field, everything else optional. `mealsPerDay: z.union([z.literal(3),z.literal(4)])` (`:119`) is the template for a new enum field.
- `UserProfile` (`types.ts:191-227`): `{name?, goal, diet, allergies, dislikes, budget, mealsPerDay:3|4, targetCalories, proteinGrams, carbsGrams, fatGrams, fiberGrams?, maxCookTime, maxIngredients, lockedMeals?, mealRatings?, bodyStats?, memory?}`. **No mode field.** Backward-compat achieved ONLY via optional fields + `withTargetDefaults` (`ai.ts:26-36` / `DEFAULT_TARGETS` `types.ts:270-277`). **No versioning/migration exists.**
- `Recipe` (`recipeDb.ts:70-101`): engine-internal, macros flat numbers, `approxCost` per-serving (`:82`), `servings?` (`:97`), `treatOnly?` (`:91`). Macros **DERIVED** by `deriveMacros` (`recipeDb.ts:137-160`) which divides summed USDA nutrients by `servings` (`:154-158`). `RECIPES = SEED_RECIPES.map(deriveMacros)` built once (`:7862`).
- v2 parallel vocabulary `src/lib/primitives.ts`: `PrimitiveOpSchema` (`:211-244`, discriminated union incl. `constrain` `:212-228`), `AssistantTurnV2Schema` (`:247-251`). `expandConstrain` (`:57-91`) maps `constrain{scope:'week'}` → one `update_profile` Operation.

**Minimal backward-compatible extension (every schema needing a field):**

| # | Schema/interface | Location | Add |
|---|---|---|---|
| 1 | `UserProfile` interface | `types.ts:191` | `planMode?: 'fresh'\|'batch'`, `batchCadence?: 'weekly'\|'every3days'` — **primary durable home**; optional so absent = fresh |
| 2 | `WeekPlanSchema` | `types.ts:46` | optional `planMode?`, `sessions?: CookingSession[]`, `batches?: Batch[]` (mirror `notes?` precedent) — also **stamps the plan with the mode it was built in** |
| 3 | `MealSchema` | `types.ts:19` | optional `batchId?`/`sessionId?` backlink (still validates as a normal Meal) |
| 4 | **NEW** `CookingSessionSchema` + `BatchSchema` (+ `z.infer` types) | beside `types.ts:46` | `CookingSession = {id, day∈DAYS, label?}`; `Batch = {id, sessionId, recipeName, totalServings, servings: {day, slot}[]}` |
| 5 | `OperationSchema` | `types.ts:71` | optional `planMode` + `batchCadence` for `update_profile` |
| 6 | `PrimitiveOpSchema` `constrain` variant | `primitives.ts:212-228` | `planMode`/`cadence` (or new `set_mode` member); wire `expandConstrain` `:61-72` |
| 7 | `Recipe` interface | `recipeDb.ts:70` | already has `servings?` — no change |

**Why `sessions`/`batches` MUST be added to the schema:** `z.object` strips unknown keys (no `.passthrough` anywhere). Any field not in `WeekPlanSchema` is **silently dropped** whenever a plan crosses the `PLAN_ENGINE=llm` validate path (`ai.ts:229` `zodOutputFormat`, `ai.ts:401` safeParse) — batches would vanish. (The default DB path never parses, but `WeekPlan = z.infer<typeof WeekPlanSchema>` at `types.ts:163`, so the TS type must carry them regardless.)

---

## 3. The engine seam — where batch selection/allocation injects

**Primary injection: `ai.ts:627`, AHEAD of the `PLAN_ENGINE` check.** Batch is a deterministic DB concept (recipe-set selection + servings scale-up + rotation), not an LLM concern:
```
if (p.planMode === "batch") return buildBatchWeek(p);   // NEW, ahead of the PLAN_ENGINE line
if (process.env.PLAN_ENGINE !== "llm") return rebalanceWeek(selectWeekFromDb(p), p);
```
Decision required: `planMode=batch` should **force the DB engine regardless of `PLAN_ENGINE`** (the servings/rotation math strongly favors DB; the LLM path can't express it).

**Why a sibling `selectBatchWeek`, not a flag on `pickMealsForDay`:** `selectWeekFromDb`→`pickMealsForDay`→`chooseRecipe` exist to **guarantee no cross-day repeats** (the shared `ctx` at `recipeDb.ts:8167`, marked `:8315-8319`, pre-marked for locks/keeps `:8358-8378`). Batch mode **inverts** that contract. `chooseRecipe`'s three variety gates are the exact inversion points to bypass: pool dedup (`:8018-8020`), `proteinDays<3` (`:8023-8024`), new-cuisine (`:8026-8027`), plus the random tie-break (`:8095-8097` — batch should be deterministic per session).

**What `selectBatchWeek` REUSES unchanged:**
- The candidate pipeline in `pickMealsForDay`: hard filter (`:8258-8264`), soft-relax (`:8271-8281`), `bannedForUser` (`:8286-8290`), `cuisinePref` (`:8291-8294`) — but it must NOT accumulate `ctx` used-marking (`:8315-8319`) for its intentional repeats.
- `fitDistance` macro ranking (`:8054-8073`) to choose WHICH few recipes to batch-cook.
- `rebalanceWeek`/`rebalanceDay`/`scaleToTargets` (`8743`/`8681`/`8588`) — **mode-agnostic per-serving macro fitting**; each plated instance is still one serving.
- The **whole-week swap path** (`recipeDb.ts:10052-10096`, "set this dish on every day that has the slot") — the one existing op whose semantics already resemble batch distribution; best reference for a batch swap.

**The hard blocker — the [0.6,1.8] clamp (verified `recipeDb.ts:8120`):** `scaleRecipeToTarget` (`8119-8131`) and `scaleRecipeByFactor` (`8568-8580`) both clamp the factor to `[0.6,1.8]` (`SCALE_LO/HI` `8499-8501` via `clampScale`). A bulk cook (factor 3–7×) is **unrepresentable through every existing scaler**. Batch scale-up must live on the **`servings` count dimension** (a separate axis) and on a **session-level shopping multiplier**, NOT by inflating per-meal macros. The per-serving macros and the clamp are both load-bearing for the fresh-week math.

**Edit-preservation (`keep`) reuse:** the `KeepEdits`/`KeepDay` path (`recipeDb.ts:8334-8335`, honored per-slot `:8237-8255`, used by `update_profile` `:9993` and `compute_targets` `:10235`) pushes existing meals verbatim (`:8251`) — useful — but its **dedup used-marking side effects** (`:8246-8250`, `:8369-8379`) are counterproductive for a reuse allocator (it would treat batch's own repeats as collisions). Batch needs a **per-batch keep variant**, not per-slot.

**Protect batch instances from the rebalancer:** `rebalanceWeek` LEVER 2 can UPGRADE-swap one instance of a batch-cooked dish (breaking "cook once, eat 3×") unless batch instances are passed as **`LockedSlots`** (`recipeDb.ts:8586`) or excluded from lever 2.

---

## 4. Mode plumbing — storage, profile, generatePlan, /api, assistant ops

**Storage (`src/lib/storage.ts`):** `KEYS` (`:7-15`) is the ONE place every localStorage key lives (`profile`, `plan`, `chat`, `imports`, `saved`, `groceriesChecked`, `visits`). `savedStore.ts:36-39` header records the cautionary tale of a second key that drifted — **define any new key in `KEYS`, never inline.** `read()` is SSR-guarded (`:20-28`); `write()` is NOT (`:30-32`). `clearAll()` (`:77-79`) auto-clears new keys. Add `KEYS.planMode` (and, if two weeks are cached separately, a distinct saved-plan key so switching doesn't overwrite the fresh `plan` — currently ONE `plan` key at `:8`).

**Profile is the durable carrier:** `planMode`/`batchCadence` belong on `UserProfile` (`types.ts:191`) as OPTIONAL fields. Because `/api/plan` casts the body with zero validation (`route.ts:11`) and clients POST the whole profile verbatim, **the field flows end-to-end with zero route edits.** Add default `planMode:'fresh'` via a `withPlanDefaults` beside `withTargetDefaults` (`ai.ts:26-36`).

**generatePlan branch:** as §3 — `ai.ts:627`.

**Assistant ops (all in the `applyOperations` switch, `recipeDb.ts:9960+`):**
- `update_profile` (`:9961`) — **the natural home for "switch to batch mode."** Already sets week-wide fields (`:9962-9970`), flips `profileChanged`, rebuilds via `selectWeekFromDb` with the keep path (`:9993`, `reTheme` gate `:9992`) + `rebalanceWeek` (`:9994`). Add one line `if (op.planMode) p.planMode = op.planMode` mirroring `if (op.diet) p.diet = op.diet`, then dispatch the rebuild block (`:9978-10005`) fresh-vs-batch on `p.planMode`. **`planMode` is week-wide exactly like `diet`** — this is strongly preferred over a new `set_plan_mode` op (which needs an enum entry `types.ts:72-94`, new switch case, new verb map `primitives.ts:126` — unjustified weight).
- `regenerate_week` (`:10008`) — must rebuild **in the current mode** (currently hardwired to `selectWeekFromDb` `:10012`).
- `compute_targets` (`:10180`) — rebuilds `rebalanceWeek(selectWeekFromDb(...))` (`:10235`); route to batch builder in batch mode.
- `regenerate_day` (`:10027` via `selectDay` `8400`) — **largely incoherent in batch**: rebuilds ONE day, breaking cook-once. Must regenerate the whole SESSION or be refused.
- `swap_meal` (`:10046`) — **the flagged hazard**: per-day swap (`:10100+`) replaces ONE serving; in batch it desyncs from the cook or should swap the ENTIRE batch. Whole-week path (`:10052`) is the closest analog.
- `lock_meal`/`unlock_meal` (`:10329`/`:10354`) — a pin becomes "keep this batch."
- `scale_portions` (`:10384`), `rebalance_day` (`:10392`), `log_meal` (`:10247`), `eating_out` (`:10321`) — mode-tolerant; `scale_portions` is arguably MORE natural in batch.
- `rate_meal`, `symptom_check`, `substitute_ingredient`, `explain_meal`, `weekly_report`, `hydration`, `undo`, `answer` — mode-agnostic. `undo` swaps whole plan+profile (`:10374-10378`), restores a batch week fine.

**v2 path:** add `planMode` to `ConstrainOp` (`primitives.ts:25`), emit in `expandConstrain` week branch (`:61-72`), add to `PrimitiveOpSchema` constrain object (`:212`).

**Preservation hazard:** server-driven mutations REPLACE the profile from `data.profile` (`plan/page.tsx:538`, `:656`; `AssistantChat.tsx:174`). The operation/assistant engine **must PRESERVE `planMode` in the profile it returns**, or a chat action silently drops the mode.

---

## 5. UI seam — always-accessible toggle + how a batch week renders

**Shell (`/sage`):** `SageLayout` (`layout.tsx:45-58`) is the only wrapper for every route (server component, touches no engine). `SidePanel` (`SidePanel.tsx:24-115`, `"use client"`) is **the single chrome present in every route's payload**; `open` state (`:28`) NOT persisted but survives navigation. Its footer region (`:97-112`) today holds an account dot + `<Link href="/classic">` (`:106-111`) — **the natural home for a persistent Fresh↔Batch segmented control.** `SideNav` (`SideNav.tsx:24-31`) drives off a hardcoded `TABS` array of 6 tuples (Home/Today/Week/Explore/Groceries/Assistant); `MobileNav` (`:75-102`) re-maps the same for `<lg`.

**Render model — server shell + client swap (every data screen):** a SERVER page renders the shared engine `demoWeek()` for instant/crawlable first paint, then a `"use client"` child swaps in the device's saved week via `loadMyWeek()` in a `useEffect`:
- **Week** `plan/page.tsx:14-28` (server) → `WeekBoard` (`WeekBoard.tsx:32-229`, client): `useState<View>` from demo (`:33`), swap effect (`:37-51`), `regenerate()` (`:53-65`). Renders a photo strip (one card/day `:127-151`) + 7-column grid (`:176-226`), meals tagged by index `SLOTS[i]` (`:197-210`).
- **Today** `today/page.tsx:32-55` maps `demoWeek().days[0]` (Monday) → `TodayClient`. **Ignores the saved week entirely** — always demo Monday; batch's "today you eat batch X (cooked Monday)" framing requires wiring `loadMyWeek`/mode in.
- **Groceries** `groceries/page.tsx:10-13` → `GroceriesClient` (`:23-211`) swaps via `loadMyWeek` (`:30-42`).
- **Assistant** `assistant/page.tsx` → `AssistantChat` (`.tsx:90-97` swap, `:168-175` persist).

**Client bridge `src/app/sage/myPlan.ts`:** `loadMyWeek()` (`:25-30`), `generateMyWeek()` (`:33-46`, POST + `savePlan`). Add parallel `loadMyBatchWeek`/`generateMyBatchWeek` or thread a mode flag.

**Demo cache:** `demo.ts` — `WEEK` computed ONCE at module load (`:66`, note `:53-65`), `demoWeek()` returns it (`:68-70`). A batch demo **must follow the same one-fixture rule** or Home/Plan/Groceries describe different weeks.

**Toggle precedent:** `ThemeSwitch` (`src/components/ThemeSwitch.tsx`) is the model (fixed client pill, localStorage KEY `:18`, anti-flash `THEME_BOOT_SCRIPT` `:70`) — but it **`return null` on `/sage` (`:34`)**. So the Fresh/Batch switch **must be built inside the `/sage` shell (`SidePanel`)**, not reuse `ThemeSwitch`.

**Live re-render on switch:** each route holds its own `useState` and reads storage once in `useEffect([])` (`WeekBoard:37-51`, `GroceriesClient:30-42`, `AssistantChat:90-97`). A localStorage write alone will NOT re-render a mounted sibling — need a **shared Mode context in `layout.tsx`** (the only component shared by all routes; server pages stay server, client leaves subscribe) or a storage/custom event.

**Batch week rendering:** `Meal.servings` (`types.ts:33`) exists precisely for batch portions but is surfaced **NOWHERE in `/sage`** (grep `servings` in `src/app/sage` = nothing) — batch-size display is net-new UI. The photo strip (`WeekBoard.tsx:127-151`) can become **cooking-session cards** ("what to cook + batch size"); the meal `<article>` (`:197-210`) is where a session tag/pill attaches. No batch/pot/session icon exists in `icons.tsx` — one must be added (SVG only). `summariseWeek.uniqueDishes` (`weekStats.ts:60`) is shown as a selling point ("distinct dishes" `WeekBoard.tsx:82-84`, Home `page.tsx:124`) — batch **intentionally repeats dishes**, so this copy needs mode-aware wording.

---

## 6. Grocery / efficiency seam — per-session bulk lists + overlap metric

**Two divergent aggregators + a shared categoriser:**
- **Aisle categoriser `src/lib/grocery.ts`:** `groupByAisle<T extends {name}>` (`:53-62`) is **generic and batch-agnostic** — buckets by `aisleFor` (`:44-48`, first-match `RULES` `:29-41`), preserves incoming order and any extra fields the caller attached. A per-session field passes through untouched.
- **Canonical (/sage) `groceriesFromWeek` — `myPlan.ts:60-73`:** dedup key `name.trim().toLowerCase()`; on repeat `hit.count += 1`; **does NOT sum quantities** — keeps the FIRST-seen `quantity` string and only counts appearances. Today `×3` means "3 meal-slots reference this," NOT "3× the amount." `GroceryRow = {name, quantity, count}` (`:48-52`). Deliberately no engine import (`:14-17`).
- **Divergent (/plan) `plan/page.tsx:236-252`:** accumulates `quantities: string[]` (all occurrences `:244`) + `estimatePrice(name, len)` (`:250`) — closer to bulk-summing but still never converts/sums.

**Quantity math (all string-based, grams via a unit table):**
- **`gramsFor(ingredient, quantity) → number|null` — `nutrients.ts:26-38`**: the ONE primitive turning a human quantity string into grams. Returns `null` for unmapped ingredient/unit. Uses `UNIT_GRAMS` (`nutrientTable.generated.ts:3765-3789+`).
- **`scaleQuantity(q, f) → string` — `recipeDb.ts:8103-8114`**: the existing bulk-scaling primitive — multiplies the leading numeric token, rounds (mass→5g, count→0.5), leaves unparseable strings ("a pinch") untouched. **"cook 3×" = `scaleQuantity(q, 3)`** — but it must reach 3–7×, so the `[0.6,1.8]` clamp of `scaleRecipeToTarget` must NOT wrap it.
- `microsForIngredients` (`nutrients.ts:47-61`) reports a **`coverage` fraction** (resolved/total) — the reusable pattern for tolerating `gramsFor` nulls in a bulk sum.

**Batch bulk quantities are NEW logic, not a reinterpretation of `count`:** normalise each occurrence to grams via `gramsFor`, sum, multiply by the session batch factor, then RE-FORMAT. **No grams→human-quantity formatter exists** ("2 cans"/"1 kg bag") — `scaleQuantity` only multiplies an existing string.

**Efficiency payoff signals that already exist:**
- **Ingredient-overlap primitive:** the selector tie-break scores shared ingredients `r.ingredients.filter(i => ctx.usedIngredients.has(...)).length` (`recipeDb.ts:8078-8084`); explain-meal reason "reuses N ingredients already on your list" (`:9206-9213`); `WeekCtx.usedIngredients: Set` (`:8079`) is the natural place to compute cross-recipe overlap for a session. **Batch selection should weight shared ingredients much more heavily** when choosing its small set.
- **Cost model already assumes bulk:** `estimatePrice(name, occurrences)` + `PRICE_MAP` (`plan/page.tsx:61-105`) prices per-WEEK because "a pack covers several meals (leftovers/bulk)" (`:61-63`), `packs = occurrences>=7 ? 2 : 1` (`:103`). A batch "money saved" metric must **avoid double-counting that existing bulk assumption**.
- `Recipe.approxCost` (`recipeDb.ts:82`, 1–3/serving).

**Render surface:** `GroceriesClient.tsx:23-211` — per-session sections, bulk quantities, overlap/money-saved metric surface here; `copyList` (`:60-75`) and the `×N` badge (`:151-156`) need session/bulk awareness. A by-session list is a NEW grouping dimension (group by session, then `groupByAisle` within each). Client-safe: `gramsFor`/`UNIT_GRAMS` live in the lighter `nutrients.ts` — importable client-side; do NOT pull `scaleQuantity` from `recipeDb` into the client without checking bundle impact.

---

## 7. Consolidated open design questions + hard constraints/gotchas

### Open design questions (the design phase must decide)

**Mode & persistence**
1. **Profile setting vs per-plan attribute?** "Switch at any time" argues for `profile.planMode` as source of truth (rides `saveProfile`, must be preserved by every server op returning a profile) with the built `WeekPlan` **echoing** the mode it was built in (so profile and plan can't desync — e.g. toggle to batch but rebuild POST fails). Or cache both weeks under separate keys for instant lossless toggling.
2. **Does switching regenerate immediately** (idiomatic, like diet changes at `recipeDb.ts:9978`) **or re-view an already-built batch plan?** Immediate rebuild discards the current week's in-progress cooking — the toggle then needs a loading/confirm state.
3. **Force DB engine when `planMode=batch`, regardless of `PLAN_ENGINE=llm`?** (Recommended — the LLM path can't express servings/rotation.)

**Data model**
4. **Is a `Batch`/`CookingSession` first-class** (day-slots reference it by id) **or an overlay index** (DayPlan.meals stay source of truth, Meal gets only an optional backlink)? The overlay keeps every existing surface rendering batch meals unchanged.
5. **Cadence encoding:** fixed enum (`'weekly'|'every_3_days'`) vs numeric `sessionsPerWeek`/`daysPerSession`; where are session boundaries (which days each session covers) stored, and how do they map onto the fixed Mon–Sun `DAYS` array?
6. **Rotation rule:** minimum distinct dishes per slot to avoid identical consecutive days (e.g. cook 2 dinners, alternate) — net-new allocation logic with no existing function.

**Editing & assistant**
7. **How does the assistant express a week-level re-batch** when `AssistantResponseSchema` returns only `changedDays`? Batch is a week-level structure + a `sessions[]`/`batches[]` index — the "diff only changed days" model **cannot express "rebuild the week as batches."** Needs a whole-week regenerate path or a new response shape. *(This is the single biggest structural mismatch.)*
8. **Batch swap/regenerate semantics:** does "swap Monday lunch" swap the whole batch (affecting other days), refuse, or "break out" one day into a fresh one-off (escape hatch)? How is that surfaced honestly in the engine's `notes`?
9. **Batch identity vs name-keyed `lockedMeals`/`mealRatings`** (`types.ts:172-189`): pin/rate a single slot vs the entire batch?

**Grocery/efficiency**
10. **Bulk unit:** summed GRAMS (precise, via `gramsFor`) or human pack counts (needs a new grams→"2 cans" formatter that doesn't exist)?
11. **Efficiency metric:** reuse the selector's overlap scoring (`recipeDb.ts:8078-8084`) + coverage pattern, or a standalone grocery-layer metric (distinct-vs-total ingredients, money saved vs fresh)?
12. **Consolidate the two aggregators first** (`myPlan.ts` + `plan/page.tsx`) or fork a batch-specific path?

**UI**
13. **Control placement:** SidePanel footer (always visible, must degrade to the 76px collapsed icon rail + mirror into MobileNav) vs a Week-page-only header control. Three-state (`Fresh / Batch-weekly / Batch-3day`)?
14. **New `/sage/cook` route vs a mode-swapped Week board?**
15. **Do Today and Groceries become mode-aware in v1** (full parity) or is batch Week/Cook-only? Today currently ignores the saved week; Groceries naively counts occurrences.

### Hard constraints / invariants batch mode must NOT break

- **Macros are DERIVED and PER SERVING**, never stored on seeds (`deriveMacros` `recipeDb.ts:137-160`, `RECIPES` `:7862`); the ingredient list is authored as-cooked and kept verbatim. A batch cooked to N servings must NOT scale per-plate macros — each day eats one serving. Put the ×N elsewhere (servings count + shopping multiplier).
- **The `[0.6,1.8]` factor clamp is hardcoded in three scalers** (`scaleRecipeToTarget:8120`, `SCALE_LO/HI:8499-8501` → `clampScale` used by `scaleRecipeByFactor`, `scaleToTargets`, `scalePortions`). A 3–7× bulk cook is impossible through any of them — batch scale-up is a **separate dimension**, never these.
- **`servings` is OVERLOADED** as a macro/micro DIVISOR (`deriveMacros:154-158`, `recipeMicros:7951-7954`, `weekMicroAverage:8841`). Repurposing it for "this plate is 1-of-N from a batch" **corrupts all four divisions** — the batch count needs its own field on `Batch`.
- **Portion factor is NOT persisted** — re-derived as `meal.calories / baseRecipe.calories` (`8593`, `9755`); `baseRecipeOf` looks up by **lowercased NAME** (`8561-8562`). A scaled/batch plate **MUST keep the base recipe's exact name** to stay rescalable/traceable.
- **`planChanged` is a deep JSON compare** (`recipeDb.ts:10508`), not tool-name inference — good, but mode-dispatch must be added at **EACH rebuild site** (`update_profile:9993`, `regenerate_week:10012`, `compute_targets:10235`), not just one.
- **Backward-compat has ONLY two mechanisms** — optional interface fields + server-side default-fill (`withTargetDefaults`/`DEFAULT_TARGETS`). No migration/versioning exists. Every new profile/plan field **MUST be optional** or every stored profile breaks. `UserProfile` is **unvalidated** (`/api/plan` casts `as UserProfile`) — nothing enforces the enum at runtime; default it in code.
- **`z.object` strips unknown keys** — `sessions`/`batches` not added to `WeekPlanSchema` vanish on the llm/validate path.
- **The `reTheme` gate** in `update_profile` (`recipeDb.ts:9992-9993`) DISCARDS keep and reselects from scratch on any cuisine/fiber/boost change — switching to batch **is** a re-theme in spirit and must NOT try to preserve the fresh week's 21 distinct dishes verbatim.
- **Edit-preservation must be per-BATCH, not per-slot** — the current keep path (`:8237-8255`) would keep some servings and re-pick others, desyncing a cook.
- **Two-layer honesty (VISION):** the model never does arithmetic; only the engine claims a change (`composeReply` in `reply.ts`; `notes[]` from `applyOperations`). **All batch servings/rotation/bulk math MUST live in `recipeDb.ts`**, never in prompts.
- **Cover ALL call sites, not just `generatePlan`:** `selectDay` (`8400`) and `demo.ts` also call the selection path — a branch only at `generatePlan` leaves single-day regen and every demo surface on fresh behavior.
- **No emoji in the UI** — SVG line icons only (a new session/pot icon must be SVG). **No AI git co-author.** Run `npm run test:engine` (anything under `src/lib` changed) before any push.
- **Demo one-fixture rule** (`demo.ts:53-65`), server/client split (never import the 501-recipe engine into a client component), and the `SidePanel` "not persisted" decision does NOT apply to mode (mode must persist across hard refresh) — all remain load-bearing.

**Bottom line for design:** batch mode is a **different way to fill the same 21-slot `WeekPlan`** (a small recipe set cooked large and rotated), gated by one profile field, injected at `ai.ts:627` as a sibling `selectBatchWeek`, taught once to `applyOperations`, with an **overlay `sessions[]`/`batches[]` index** and a **session-level shopping multiplier** carrying the ×N — because per-serving macros, the `[0.6,1.8]` clamp, name-keyed base lookup, and the changed-days assistant contract are all load-bearing and must survive untouched.