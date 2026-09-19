# The module map — public contracts, private internals, and how to enforce them

*Deliverable 2 of the planning conversation briefed in `docs/v1-modularization-kickoff.md`, and the
one the owner called the heart of it. Written 2026-09-19 against `125d7b3`.*

**The question this document answers, in the owner's words:**

> I create a function, I give it a name and a description. The user of that function only knows the
> name and the description. If I change the backend of that function, it still does the exact same
> thing it promised in its description — without breaking the code that uses it.
>
> **What stays PUBLIC to a module, and what stays PRIVATE to it?**

Everything below was computed from the code, not remembered. The method is in §9 so it can be
re-run after any refactor and the answers checked rather than believed.

---

## 1. What "public" has to mean here, to be worth anything

A contract nobody can violate by accident is the only kind worth writing. So "public" is defined
mechanically, in three parts:

1. **A module is a folder with one `index.ts`.** That file *is* the contract: a list of names, each
   with a doc comment saying what it promises. Nothing else in the folder may be imported from
   outside — not by a deep path, not "just this once".
2. **Everything not in `index.ts` is private,** and may be rewritten, renamed, split or deleted
   without telling anyone, as long as the promises in `index.ts` still hold.
3. **A gate enforces it** (`npm run check:boundaries`, §9). An unenforced boundary is a comment, and
   this repo already has the scar: a second saved-recipes key was added next to `storage.ts`'s and
   the two lists drifted silently until an audit found it.

**The test for whether a name belongs in `index.ts`:** *could I change how this works tonight
without changing what it promises?* `filterFeed(query)` passes — it could become a server call and
no caller would notice. `chooseRecipe(candidates, ctx)` fails — its arguments *are* the
implementation, so publishing it publishes the internals.

---

## 2. The layer model — who is allowed to depend on whom

Dependencies point **down only**. Verified today by depth-first search over the 27 `src/lib`
modules: **no import cycles exist.** That is the happy starting point this plan protects — the
gate's job is to keep it true, not to fix it.

| Layer | What lives there | May import | Must never import |
|---|---|---|---|
| **L0 · Contracts** | `types.ts` — the zod schemas and TS types every layer speaks | zod only | anything in this repo |
| **L1 · Data** | `nutrientTable.generated.ts`, the 501 recipe seeds, `substitutions.ts`, `symptoms.ts`, the conditions table | L0 | anything computing over it |
| **L2 · Pure computation** | `nutrients.ts`, `targets.ts`, `exclusions.ts`, `grocery.ts`, `streak.ts` | L0–L1 | the plan engine, the assistant, any I/O |
| **L3 · Plan engine** | selection, rebalancing, batch, the executor | L0–L2 | the assistant, providers, UI, `storage` |
| **L4 · Assistant** | `primitives.ts`, `agentTools.ts`, `agentLoop.ts`, `reply.ts`, `promptV2.ts` | L0–L3 | providers (the model arrives **injected**), UI, `storage` |
| **L5 · Adapters** | `ai.ts`, `import.ts`, `videoImport.ts`, `storage.ts`, `savedStore.ts` | L0–L4 | the UI |
| **L6 · Presentation** | `feed.ts`, `recipes.ts` (images), `batchGrocery.ts`, `weekStats.ts`, and everything in `src/app` | L0–L5 **via barrels only** | — |
| **T · Tooling** | `scripts/*` | anything, including internals | — it is the harness, and it is *supposed* to reach inside |

**The one rule that outranks the layers,** and the reason the whole thing exists: **the model
decides, the engine computes.** L4 may ask L3 for anything; it may never do arithmetic itself, and
it is never the thing that claims a change happened. Any refactor that puts a number in L4 is wrong
however tidy the folders look.

**Tooling is deliberately exempt.** `scripts/test-engine.mts` must be able to reach a private
function to test it; a test suite that can only see the public surface can only test the public
surface. The gate therefore exempts `scripts/` by name, which is a decision, not an oversight.

---

## 3. What the code says today: the actually-consumed surface

For every module: how many names it exports, and how many anything outside it actually imports.
Computed by parsing every `import { … } from` in `src/` and `scripts/` (no `import * as` exists in
the repo, so the count is exact).

| Module | Exports | Actually imported | Over-exposed by | Verdict |
|---|---|---|---|---|
| `primitives.ts` | 29 | 7 | **22** | Seal. The 18 per-op interfaces + `verbToOperation` + `PrimitiveOpSchema` are the shape of the implementation. |
| `recipeDb.ts` | 24 | 18 | 6 | Split (§5). `Cuisine`, `MainProtein`, `findRecipe`, `ratingMap`, `SelectionReport`, `selectDay` have no consumer. |
| `types.ts` | 28 | 22 | 6 | Keep. It is the contract layer; an unused schema is still the contract. |
| `ai.ts` | 13 | 7 | 6 | Seal 5, **delete 1**: `runAssistant` has no caller anywhere (verified). |
| `targets.ts` | 13 | 8 | 5 | Seal the input/output type aliases; keep the functions. |
| `nutrients.ts` | 11 | 8 | 3 | Seal `emptyMicros`, `MicroResult`; keep `Micros` (it is in signatures). |
| `storage.ts` | 17 | 15 | 2 | Keep both — `clearAll` and `loadVisits` are the "delete my data" and streak paths V1 needs. |
| `agentTools.ts` | 15 | 12 | 3 | Keep. The 3 are arg/row types that belong to the documented contract. |
| `exclusions.ts` | 6 | 4 | 2 | Seal `expandExclusion`, `ingredientHasGluten` — both internal matchers. |
| `savedStore.ts` | 4 | 1 | 3 | **Keep all four.** Only `useSaved` is imported *today*; the interface is the account seam and sealing it would defeat its purpose. |
| `feed`, `grocery`, `import`, `reply`, `streak`, `substitutions`, `promptV2`, `genV2`, `demo`, `nutrientTable` | — | all | 0 | Already right-sized. |

**The headline, measured two ways because the two answer different questions.** `src/lib` exports
**232 names** in total:

- **68 are imported by nothing at all** — not by the app, not by the API routes, not by the test
  suite. These are promises kept to nobody, and each is something a future refactor must either
  preserve or knowingly break.
- **103 are imported by nothing in `src/`** — the extra 35 are reached only by `scripts/`. Those are
  *correctly* private to the library and public to the harness, which is exactly why the gate
  exempts `scripts/` (§2) instead of pretending the test suite is an ordinary consumer.

The number to drive down is 68. The number to leave alone is 35.

**Three things this analysis found that are worth fixing regardless of any refactor:**

- **`runAssistant` in `ai.ts` is dead code** — no import anywhere in `src/` or `scripts/`. It is the
  pre-agent-loop assistant path. Deleting it removes a second, stale answer to "how does a message
  become a plan change".
- **`findRecipe` exists twice**, in `recipeDb.ts` (unconsumed) and as a private function in
  `import.ts` (JSON-LD graph walking). Same name, unrelated jobs, one module apart.
- **`demo.ts` exists twice**, at `src/lib/demo.ts` (API demo-mode plan) and `src/app/sage/demo.ts`
  (the fixture week the /sage screens render). Different purposes, identical name; a session has
  already had to be told which one it was looking at.

---

## 4. The module catalogue — name, promise, public, private, invariants

The contract for each module. **Promise** is the description a caller is allowed to rely on;
**private** is what may change tonight without telling anyone.

### L0 · Contracts

**`core/types`** — *"The shapes every layer speaks: a plan, a day, a meal, a profile, and the zod
schemas that validate them at every boundary."*
- **Public:** `WeekPlan`, `DayPlan`, `Meal`, `Ingredient`, `UserProfile`, `UserFact`, `LockedMeal`,
  `MealRating`, `BodyStats`, `PlanSnapshot`, `ChatMessage`, `Batch`, `CookingSession`, `Operation`,
  `AssistantResponse`, `AssistantTurn`, the matching `*Schema`s, `MEAL_TYPES`, `DAYS`,
  `DEFAULT_TARGETS`.
- **Private:** nothing. This module is all contract.
- **Invariants:** a type change here is a breaking change to every layer at once, so it is the one
  module where "just add an optional field" is the only safe edit (which is exactly how `planMode`,
  `batchCadence` and `batchId` were added).
- **Dependents:** everyone.

### L1 · Data

**`data/nutrients-table`** (`nutrientTable.generated.ts`) — *"USDA per-100 g values, every entry
keyed to a real `fdc_id`."*
- **Public:** `NUTRIENT_TABLE`, `UNIT_GRAMS`, `Per100g`. **Private:** the file's shape and ordering.
- **Invariants:** generated by `npm run build:nutrients`, **never hand-edited**; every entry carries
  a real FDC id, because auto-matching produced `salmon fillet → Salmonberries`.

**`data/recipes`** (today lines 179–7863 of `recipeDb.ts`) — *"The 501 curated recipe seeds."*
- **Public:** `SEED_RECIPES` (to the engine only), `Recipe`, `DietTag`.
- **Private:** every seed's literal contents.
- **Invariants:** **macros are never written on a recipe** — `deriveMacros` computes them from the
  ingredient list against the nutrient table. Only ingredients already curated to an FDC id may
  appear. `npm run check:recipes` is the gate.

**`data/symptoms`, `data/substitutions`, `data/conditions`** — *"Curated lookup tables for the
symptom, substitution and condition tools."*
- **Public:** `SYMPTOMS`, `URGENT_FLAGS`, `CRISIS_FLAGS`, `PHRASE_NOISE`; `SUBSTITUTES`,
  `INGREDIENT_ALIASES`; `CONDITIONS`, `conditionBoosts`.
- **Invariants:** `CRISIS_FLAGS` is safety data — it may only grow, and anything reading it must
  fail loud, never silently miss.

### L2 · Pure computation

**`nutrition/nutrients`** — *"Micronutrient maths: convert a quantity to grams, sum a recipe's
micros, report coverage against a daily reference."*
- **Public:** `microsForIngredients`, `gramsFor`, `microDensity`, `MICRO_KEYS`, `MicroKey`,
  `Micros`, `DAILY_REFERENCE`, `MICRO_LABEL`, `MICRO_UNIT`. **Private:** `emptyMicros`,
  `MicroResult`, the parsing of "1 1/2 cups".
- **Invariants:** an unknown ingredient lowers **coverage**; it never silently contributes zero as
  though it were measured.

**`nutrition/targets`** — *"Mifflin-St Jeor targets and hydration from body stats, with a floor."*
- **Public:** `computeTargets`, `bmr`, `hydrationTarget`, `explainTargets`, `explainHydration`,
  `CALORIE_FLOOR`, `DEFAULT_CALORIE_FLOOR`, `Activity`. **Private:** `Sex`, `Goal`, `TargetInput`,
  `Targets`, `Hydration` (structural aliases, inferable from the functions).
- **Invariants:** garbage body stats are rejected, not extrapolated; the calorie floor applies to an
  unknown/other sex too.

**`nutrition/exclusions`** — *"Allergen and diet matching, word-aware, in both directions."*
- **Public:** `haystackBlocked`, `parseExclusionTokens`, `dietTagConflicts`, `wordMatches`.
  **Private:** `expandExclusion`, `ingredientHasGluten`, `CATEGORY_TERMS`, `VEGAN_EXCEPTIONS`.
- **Invariants:** **I2 — an allergen or excluded ingredient never reaches a plate.** Matching is
  word-aware in *both* directions (`peanuts` must match `peanut butter`; `egg` must not match
  `eggplant`). **Every matcher in this module gets the same fix** — the sibling-path miss is
  lesson 14 and it has cost three separate incidents.

**`nutrition/grocery`, `presentation/streak`** — *"Aisle categorisation"* and *"local-day streak
arithmetic."* Public: `groupByAisle`, `aisleFor`, `AISLE_ORDER`, `Aisle`; `currentStreak`,
`isoDay`, `prevDay`. Invariant: streaks key on the **local** day, never UTC.

### L3 · Plan engine — the split (see §5)

**`plan/select`** — *"Given a profile, choose the week's dishes so every hard rule holds and the
macros land as close to target as the library allows."*
- **Public:** `selectWeekFromDb(profile, opts?)`, `selectBatchWeek`, `buildWeek`,
  `selectConditionAwareWeek`, `withSeed`, `RECIPES`, `recipeToMeal`, `recipeMicros`.
- **Private:** `chooseRecipe`, `pickMealsForDay`, `candidatesForSlot`, `batchCandidates`,
  `pickKForSlot`, `scaleRecipeToTarget`, `localSplit`, `budgetCap`, `passesDiet`,
  `blockedByExclusions`, `mulberry32`, `ratingMap`, `selectDay`, `findRecipe`, `SelectionReport`.
- **Invariants:** I1 diet, I2 allergens, I3 exactly `mealsPerDay` meals, I4 no duplicate dish in a
  day, I7 cook-time relaxed only when nothing complies **and disclosed**. Selection **reserves** a
  pinned dish; it does not place it (`reimposeLocks`, private to `plan/execute`, does).

**`plan/rebalance`** — *"Hold a day or a week on its macro targets by moving portions, within
realistic bounds."*
- **Public:** `rebalanceWeek`, `rebalanceBatchWeek`. **Private:** `rebalanceDay`, `scaleToTargets`,
  `dayTargetMacros`, `slotTargetMacros`, `macroDistance`, the weights, `SCALE_LO/HI`.
- **Invariants:** I5 day calories on target unless `preserveMacros:false` or physically
  unreachable; **I6 portion scale stays in 0.6–1.8×**; a batch slot is passed as locked so the
  rebalancer can never rescale a cooked batch.

**`plan/execute`** — *"The only code allowed to change a plan and to say that it changed."*
- **Public:** `applyOperations(profile, plan, operations, previous?)` →
  `{ plan, profile, notes, planChanged, profileChanged, replyOverride? }`.
- **Private:** every per-tool handler, `reimposeLocks`, `guaranteeFridge`, `guaranteeBoost`,
  `findRecipeForSwap`, `achievementNote`, `symptomNote`, `substituteNote`, `explainMealNote`,
  `eatingOut`, `upgradeForNutrient`, and the undo snapshot.
- **Invariants:** it never mutates the profile or plan it is handed (proved by probe); a refusal is
  reported, never faked; `replyOverride` on a crisis discards the model's words entirely;
  `planChanged` is a **deep comparison of before and after**, never a guess from which tool ran.

**`plan/report`** — *"Read-only descriptions of a plan: weekly averages, shortfalls, micro coverage."*
Public: `weeklyReportNote`, `keepDays`, `freezesWell`, `reportNotes`, `newReport`. Invariant: it
computes, it never writes.

### L4 · Assistant

**`assistant/primitives`** — *"The v2 vocabulary a model may emit, and the executor that runs it."*
- **Public:** `PrimitiveOp`, `applyPrimitives`, `memoryContext`, `AssistantTurnV2Schema`,
  `AssistantTurnV2`, `expandConstrain`, `applyRemember`.
- **Private (today public, and the single biggest sealing win):** `ConstrainOp`, `RememberOp`,
  `SwapOp`, `LogOp`, `ReserveOp`, `ResizeOp`, `RateOp`, `PinOp`, `ReportOp`, `ExplainOp`,
  `SubstituteOp`, `SymptomOp`, `HydrationOp`, `UndoOp`, `AnswerOp`, `VerbOp`, `Day`, `MealType`,
  `Nutrient`, `Scope`, `verbToOperation`, `PrimitiveOpSchema` — **22 names, none imported anywhere.**
- **Invariants:** every write reaches the engine through `applyOperations`; this module adds no
  arithmetic of its own.

**`assistant/read-surface`** (`agentTools.ts`) — *"Seven pure lookups the MODEL calls and the user
never sees."*
- **Public:** `runReadTool`, `isReadTool`, `READ_TOOL_NAMES`, `AgentContext`, `MAX_ROWS`, and the
  seven functions. **Private:** the row projections.
- **Invariants:** pure — no I/O, no model, no network; `what_if` clones before simulating;
  `runReadTool` returns `{ error }` and never throws; **every list is capped at `MAX_ROWS`**.
- **Never merge with `reply.READ_ONLY_TOOLS`.** Both mean "does not change the plan" and nothing
  else about them is alike: these are model-facing lookups, those are user-facing answers.

**`assistant/loop`** (`agentLoop.ts`) — *"Call the model, execute what it asked for, feed the result
back, call again, stop."*
- **Public:** `runAgent`, `ModelFn`, `TranscriptEntry`, `AgentTurn`, `MAX_STEPS`.
- **Private:** step bookkeeping, transcript shaping, where the undo snapshot is taken.
- **Invariants:** **the model is injected as a `ModelFn`** — that is what makes the loop testable
  with no model at all, and it is the most important line in the file. `MAX_STEPS = 8` is a cap, not
  a target; hitting it sets `gaveUp` and the user is told. One undo snapshot per user turn, taken
  before the first write.

**`assistant/reply`** — *"Compose the user-facing answer; engine notes are authoritative."*
Public: `composeReply`, `describeOperations`, `READ_ONLY_TOOLS`, `planWasChanged`. Invariant: a
read-only tool may never report a plan change; a `replyOverride` silences the model by **presence,
not truthiness**.

### L5 · Adapters

**`providers/ai`** — *"One provider interface over Claude, any OpenAI-compatible server, or demo
mode."*
- **Public:** `resolveProvider`, `generatePlan`, `agentModelFn`, `parseAssistantTurn`,
  `assistantTurnSystemPrompt`, `withTargetDefaults`, `extractRecipeFromText`.
- **Private / to seal:** `withPlanDefaults`, `Provider`, `ExtractedRecipeSchema`, `ExtractedRecipe`,
  `parseAssistantTurnV2`. **To delete:** `runAssistant` (no caller).
- **Invariants:** the env vars it reads are exactly `AI_PROVIDER`, `ANTHROPIC_API_KEY`,
  `CLAUDE_MODEL`, `LOCAL_AI_URL`, `LOCAL_AI_MODEL`, `LOCAL_AI_API_KEY`, `PLAN_ENGINE`; **with no
  keys the app still works** (demo mode) — that is a product promise, not a fallback.

**`providers/import`, `providers/video-import`** — *"Turn a link into a recipe, deterministically."*
Public: `importRecipeFromUrl`, `importRecipeFromVideo`, `videoPlatform`, `importedToMeal`,
`ImportedRecipe`, `isSafePublicUrl`. Invariants: **SSRF-guarded, and the guard re-validates the URL
after redirects**; nutrition is **never guessed** — absent means zero plus an honest note; the
video path lets the model extract *structure only*, never nutrition.

**`persistence/storage`** — *"The only place that knows a localStorage key name."*
Public: the load/save pairs + `clearAll`. Private: **`KEYS`**, and the JSON encoding.
Invariant: **one concept, one key, and no other module may name one.** Enforced by the gate.

**`persistence/saved-store`** — *"Saved recipes as `list`/`add`/`remove`, async on purpose."*
Public: `SavedStore`, `savedStore()`, `localSavedStore`, `useSaved`. Invariant: async even though
localStorage is not, so a network can slide behind it without touching a call site; it **delegates
to `storage.ts` rather than owning a key**; it must keep working with no account configured.

### L6 · Presentation

**`presentation/feed`** — *"The library as filterable, sortable cards."* Public: `filterFeed`,
`sortFeed`, `FeedItem`, `FeedFilter`, `FeedSort`, `HIGH_PROTEIN_G`, `FEED_RECIPES`. Invariant:
search matches at **word starts** (`oat` must not hit `goat`); vegan satisfies a vegetarian filter.
**`FEED_RECIPES` is the payload problem — see §6.**

**`presentation/imagery`** (`recipes.ts`) — *"Exactly which photograph belongs to which dish."*
Public: `imageForMeal`, `cutoutForMeal`, `gradientForMeal`, `PHOTOGRAPHED_RECIPES`. Invariant: an
**exact recipe-name map**, never a pattern; a miss returns `null` and falls back to a typographic
tile; **an image appears only on the dish it depicts.**

---

## 5. The reorganisation proposal

### Phase 1 — seal, without moving anything *(low risk, do first)*

Add an `index.ts` per module folder, move the ~60 unconsumed names off the public surface, delete
`runAssistant`. **No call site changes.** Gate: `test:engine` returns the identical count.

### Phase 2 — split `recipeDb.ts` *(the big one)*

It is 10,850 lines and three unrelated jobs sharing a file:

| Lines | Share | What it is | Becomes |
|---|---|---|---|
| 179–7863 | **71%** | the 501 recipe seeds | `plan/data/seeds.ts` |
| 7864–9010 | 11% | selection, rebalancing, batch | `plan/select.ts`, `plan/rebalance.ts`, `plan/batch.ts` |
| 9011–10850 | 17% | the executor and its note-writers | `plan/execute.ts`, `plan/notes.ts` |

Done in **two days, data first** (D2, D3 in the schedule), each behind a barrel that re-exports
today's 18 consumed names unchanged, so **no importer is touched on either day**. The gate is that
`npm run test:engine` produces the *same number of passes*, before and after — a split that changes
behaviour shows up as a count change, and a split that loses an export fails `tsc`.

### Phase 3 — the folders *(mechanical, one commit)*

```
src/core/          types
src/data/          seeds, nutrient table, symptoms, substitutions, conditions
src/nutrition/     nutrients, targets, exclusions, grocery
src/plan/          select, rebalance, batch, execute, notes, report   ← barrel = today's recipeDb surface
src/assistant/     primitives, read-surface, loop, reply, prompt
src/providers/     ai, import, video-import
src/persistence/   storage, saved-store
src/presentation/  feed, imagery, batch-grocery, streak, week-stats
```

**Be honest about the value split:** Phases 1 and 2 deliver nearly all of it — enforceable contracts
and a file you can hold in your head. Phase 3 is navigation, and it is worth doing *only* because it
is cheap when done mechanically with `tsc` as the gate. **It must not be attempted in the same
commit as a behaviour change.**

---

## 6. The trap this refactor must not walk into

**A barrel is a bundler black hole.** If `plan/index.ts` re-exports both `selectWeekFromDb` and
`RECIPES`, then any client component importing *one helper* may pull all 501 recipes into the
browser. That is not hypothetical — it is the Explore payload bug we already have (`FEED_RECIPES`
is imported by a client component; Explore's first-load JS is ~185 kB against ~105 kB elsewhere).

So the boundary has a second axis, and it is the one that actually costs money:

| barrel | contains | may be imported by |
|---|---|---|
| `plan` (server) | the engine, the seeds, the executor | API routes, server components, tooling |
| `plan/cards` (client-safe) | a `RecipeCard` projection — only the fields a card renders | client components |

`src/app/sage/weekStats.ts` already proves the pattern works: it imports **only a type**, which is
why `/sage/assistant` is 105 kB while Explore is 187 kB. Milestone A4 generalises it.

---

## 7. The seams already built this way — copy these, don't re-invent

| Seam | What makes it work |
|---|---|
| `storage.ts` | one concept → one key → **one module that knows the name** |
| `savedStore.ts` | three methods, **async before a network needs it**, so the account swap is one file |
| `reply.ts` | `READ_ONLY_TOOLS` is a *set a new tool must be added to*, and a test fails if it isn't |
| `agentTools.ts` | pure functions over (args, context); bounded results; errors returned, never thrown |
| `agentLoop.ts` | **the model injected as `ModelFn`** — the seam that makes the untestable testable |
| `weekStats.ts` | imports **only a type**, and that is the whole reason a page is 105 kB |

---

## 8. What must survive the re-architecture, without exception

1. **The two layers stay apart.** Model decides; engine computes and is the only thing that may
   claim a change. No folder structure justifies moving a number into L4.
2. **Macros are never stored on a recipe.** `deriveMacros` computes them. A seeds file that carries
   macros is a regression however convenient it looks.
3. **The invariants I1–I8 keep holding after every operation** — they are asserted by the fuzzer, so
   the suite is the proof, and the suite's count must not drop.
4. **No keys, still works.** Demo mode is a promise: the static GitHub Pages export has no server.
5. **`test:engine` is the gate for any `src/lib` change.** Never push red.

---

## 9. Enforcement: `npm run check:boundaries` (milestone A1)

A homemade gate in the family of `check:recipes` / `check:data` — no new dependency, run by esbuild
+ node like the others. It parses every import in `src/` and asserts:

| # | Rule | Why it exists |
|---|---|---|
| 1 | No module imports **above** its layer (§2) | the layering is otherwise a comment |
| 2 | Only a module's **barrel** may be imported from outside it — no deep paths | this is what makes "private" real |
| 3 | **Only `persistence/storage` may contain a localStorage key string** | a second saved-recipes key already drifted once |
| 4 | No **client component** imports a server barrel (`"use client"` + `plan` ⇒ fail) | the 185 kB Explore payload, made impossible |
| 5 | No **import cycles** | true today; this keeps it true |
| 6 | No **emoji** in `src/` | a standing project rule with no enforcement today |

`scripts/` is exempt by name (§2). Every failure prints the offending file, the import, and the rule
in plain English — a gate that says "violation in 3 files" teaches nobody anything.

**The method used to produce §3, so it can be re-run:** parse every `import { … } from "…"` in
`src/` and `scripts/`, resolve `@/lib/x` and relative specifiers to a module, and compare the set of
imported names against the set of `export`ed ones. Anything exported and never imported is
over-exposure. It takes about 40 lines of node and it should become part of the gate, so the
over-exposure count can only go down.
