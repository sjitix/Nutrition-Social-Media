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

**What "contract" means in this document** *(the owner asked, 2026-09-19).* It is the word for the
thing described in the quote above: **a module's name, plus the promise its description makes, plus
the rules it keeps** — and nothing about how it keeps them. Whoever uses the module may rely on the
contract and on nothing else; whoever writes the module may change anything that is not in it.
Concretely, each contract below has three parts: the **public** names (what you may call), the
**promise** (what calling it does), and the **invariants** (what is always true afterwards, e.g. "an
allergen never reaches a plate"). The term is borrowed from software engineering ("design by
contract") because it carries the one idea that matters here: *two sides, each bound to their half,
and a change on one side that keeps the terms breaks nothing on the other.*

---

## 0. Owner direction, from the comments on the module-map board (2026-09-19)

Seven comments, answered late — they sat unread until 2026-10-03, which is recorded here because it
changed what happened in between (Track E was built before this direction was read). Each one is
applied where it belongs below; this is the index.

| # | Comment, in short | Where it is applied |
|---|---|---|
| 1 | **Modularise first, then build on that architecture — spend real time on it** | §5 "Modularise first" — Track A is now a gate on all feature work, and the folders are committed, not optional |
| 2 | "Why do you use the word contract" | the definition above |
| 3 | "What is this?" — on L0 | §2 "The layers in plain words" |
| 4 | Ingredient and recipe databases need expanding by a lot | §4 L1 "Built to grow" |
| 5 | L2 is pure maths — focus on it and its automation, it has to work perfectly, including as the databases grow | §4 L2 "The maths must be exact" — new milestone **A7** |
| 6–7 | Expand the primitives; and what is the strongest cloud model that is fast enough for beta (a 128 GB machine?) | §4 L4 "The vocabulary will grow" — new milestone **C4**; the model question belongs to the **models lane** (`docs/parallel/lane-models.md`), which was set up for exactly it |

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
| **L0 · Contracts** | `core/` — `types.ts` (the zod schemas and TS types every layer speaks), `slots.ts`, `micros.ts` (the micronutrient vocabulary), `imported.ts` (an imported recipe and its pure converter to a Meal), `defaults.ts` (`DEFAULT_TARGETS`, zod-free so the browser can have it) | zod only | anything in this repo |
| **L1 · Data** | `data/` — the 501 recipe seeds, ingredient identity, `nutrientTable.generated.ts`, `substitutions.ts`, `symptoms.ts`, `conditions.ts` (+ `nutrition/unitGrams.generated.ts`, kept client-safe) | L0 | anything computing over it |
| **L2 · Pure computation** | `nutrition/` — `units.ts`, `nutrients.ts`, `targets.ts`, `exclusions.ts`, `safety.ts`, `grocery.ts` (+ `presentation/streak.ts`, local-day arithmetic) | L0–L1 | the plan engine, the assistant, any I/O |
| **L3 · Plan engine** | selection, rebalancing, batch, the executor | L0–L2 | the assistant, providers, UI, `storage` |
| **L4 · Assistant** | `assistant/` — `primitives.ts`, `agentTools.ts`, `agentLoop.ts`, `reply.ts`, `promptV2.ts` | L0–L3 | providers (the model arrives **injected**), UI, `storage` |
| **L5 · Adapters** | `providers/` — `ai.ts`, `import.ts`, `videoImport.ts`; and (the accounts lane's, not yet moved) `storage.ts`, `savedStore.ts`, `account/` | L0–L4 | the UI |
| **L6 · Presentation** | `presentation/` — `feed.ts`, `feedFilter.ts`, `recipes.ts` (images), `batchGrocery.ts`; `weekStats.ts`, and everything in `src/app` | L0–L5 **via barrels only** | — |
| **T · Tooling** | `scripts/*` | anything, including internals | — it is the harness, and it is *supposed* to reach inside |

**The one rule that outranks the layers,** and the reason the whole thing exists: **the model
decides, the engine computes.** L4 may ask L3 for anything; it may never do arithmetic itself, and
it is never the thing that claims a change happened. Any refactor that puts a number in L4 is wrong
however tidy the folders look.

**The layers in plain words** *(the owner asked "what is this?" on L0)*. Read the stack bottom-up;
each layer only ever uses the ones beneath it.

- **L0 · Contracts — the shared vocabulary.** One file, `types.ts`, that says what a *meal*, a *day*,
  a *week plan* and a *profile* look like: which fields they have and what type each is. It contains
  no logic. Every other part of the app speaks in these shapes, which is why it sits at the bottom:
  change a shape here and every layer above feels it.
- **L1 · Data — the facts.** The recipes, the USDA nutrient values, the symptom and substitution
  tables. Lists of things, no calculation.
- **L2 · Pure computation — the maths.** Grams from "1 1/2 cups", micronutrients from an ingredient
  list, calorie targets from body stats, "does this dish contain an allergen". Same input, same
  answer, every time; no memory, no network.
- **L3 · Plan engine — the decisions.** Picks the week's dishes, holds each day on its targets,
  executes every change. The only thing allowed to say a plan changed.
- **L4 · Assistant — the conversation.** Turns what a model asked for into engine operations. It
  decides *what* to ask; it never does the arithmetic.
- **L5 · Adapters — the outside world.** The model provider, recipe import from a link, the browser's
  storage.
- **L6 · Presentation — the screens.**

**How to read the numbers on the board** (e.g. *types 22 / 28*): the module exports 28 names, and
22 of them are actually used by something outside it. The gap is promises nobody relies on yet.

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

**`data/ingredients`** (`src/lib/data/ingredients.ts` + the generated `ingredients.generated.ts`,
**D5, 2026-10-03**) — *"Which curated ingredient is this, by its permanent id?"*
- **Public:** `IngredientSlug` (a union of all 180 — what makes a misspelled recipe ingredient fail
  `tsc`), `INGREDIENT_SLUGS`, `INGREDIENTS` (slug → curated name + fdc_id), `resolveIngredient`,
  `ingredientName`, and **`tableKey`** — the ONE rule every nutrition lookup uses: the NAME first, the
  slug as the fallback, then today's trim-lowercase name for an ingredient we do not curate. (Name
  first so a slug supplied from outside — a model, an imported file — can never contradict what the
  user sees and the allergen matcher reads; changed from "slug first" by the D5 review.)
- **Invariants:** a slug, once written in `scripts/ingredient-map.json`, never changes; the generator
  reads slugs and never derives them; `npm run check:ingredients` fails any library reference that
  resolves to nothing. Retail products attach to slugs (owner decision #6).

**`data/seeds`** (**`src/lib/data/seeds.ts` since A2, 2026-10-03** — it was lines 179–7863 of
`recipeDb.ts`) — *"The 501 curated recipe seeds, and the vocabulary that describes them."*
- **Public:** `SEED_RECIPES` (to the engine only), and the recipe vocabulary — `Recipe`,
  `RecipeSeed`, `DietTag`, `Cuisine`, `MainProtein`. `recipeDb` re-exports the four it always
  exported, so no importer changed.
- **Private:** every seed's literal contents.
- **Imports nothing.** Data depends on nothing; `check:boundaries` holds it to L0-only.
- **Invariants:** **macros are never written on a recipe** — `deriveMacros` computes them from the
  ingredient list against the nutrient table. Only ingredients already curated to an FDC id may
  appear. `npm run check:recipes` is the gate.

**`data/symptoms`, `data/substitutions`, `data/conditions`** — *"Curated lookup tables for the
symptom, substitution and condition tools."*
- **Public:** `SYMPTOMS`, `URGENT_FLAGS`, `CRISIS_FLAGS`, `PHRASE_NOISE`; `SUBSTITUTES`,
  `INGREDIENT_ALIASES`; `CONDITIONS`, `conditionBoosts`.
- **Invariants:** `CRISIS_FLAGS` is safety data — it may only grow, and anything reading it must
  fail loud, never silently miss.

**L1 is built to grow — "expand by a lot"** *(owner, 2026-09-19, said twice).* Today: **180
ingredients, 501 recipes.** Target recorded in the schedule's owner-gated table: **400 ingredients /
900 recipes** (a default until the owner names a number). The order is deliberate, because growing
the library on today's shape would multiply today's weakness:

1. **D5 · A5 — ingredient identity first.** Recipes reference ingredients by free-text name today, so
   a new recipe can silently point at nothing. Each ingredient gets a stable id and every recipe
   carries ids; `check:ingredients` fails on any reference that does not resolve to an FDC-backed entry.
2. **D5b · A7 — the maths proven exact** (see L2), so each new ingredient is *checked automatically*
   instead of eyeballed.
3. **B7 — a curation helper** that proposes USDA matches for a new ingredient for a human to confirm.
   Never auto-accepts (`salmon fillet → Salmonberries`). This is what makes adding an ingredient a
   minutes-long job, and therefore what makes "by a lot" affordable.
4. **Then the expansion itself**, in batches, each batch gated by `check:recipes` +
   `check:ingredients` + `test:engine`. Retail products (Lidl-style) attach to ingredient ids after
   that — research and the design are in `01-…md` §8.

### L2 · Pure computation

**`nutrition/nutrients`** — *"Micronutrient maths: convert a quantity to grams, sum a recipe's
micros, report coverage against a daily reference."*
- **Public:** `microsForIngredients`, `gramsFor`, `microDensity`, `MICRO_KEYS`, `MicroKey`,
  `Micros`, `DAILY_REFERENCE`, `MICRO_LABEL`, `MICRO_UNIT`. **Private:** `emptyMicros`,
  `MicroResult`, the parsing of "1 1/2 cups".
- **Invariants:** an unknown ingredient lowers **coverage**; it never silently contributes zero as
  though it were measured.

**`nutrition/units`** (`src/lib/units.ts`, split out in A4) — *"Grams from a written quantity."*
- **Public:** `gramsFor` (`nutrients.ts` re-exports it). **Private:** the parser, the unit fallbacks.
- **Invariants (D5b):** per ingredient, every unit agrees with the ones it overrides — tbsp = 3 tsp =
  15 ml, cup = 16 tbsp, l = 1000 ml, singular = plural, a bare count = a piece; a size word is relative
  to the item (0.75× / 1.3× its count; eggs use USDA's 38 / 44 / 50 g); a number followed by anything
  that is not a unit is **null**, never "count"; a whole number is a mixed number only before a real
  fraction; recipe-site punctuation after a unit ("2 tbsp.", "200g/7oz") still weighs; unambiguous
  spellings ("tablespoons", "lbs", "cans") are aliases while "T"/"t"/"c" stay unknown; a size word
  before another unit noun ("1 large head") or on an item counted by its parts is null; "0,250" is
  never thousands. Grams are linear in the amount.

**`nutrition/targets`** — *"Mifflin-St Jeor targets and hydration from body stats, with a floor."*
- **Public:** `computeTargets`, `bmr`, `hydrationTarget`, `explainTargets`, `explainHydration`,
  `CALORIE_FLOOR`, `DEFAULT_CALORIE_FLOOR`, `Activity`, and (D5b) `BODY_LIMITS`, `bodyStatProblems`,
  `bodyStatMessage`, `isRealBody`, `referenceWeightKg`. **Private:** `Sex`, `Goal`, `TargetInput`, `Targets`, `Hydration` (structural
  aliases, inferable from the functions).
- **Invariants:** a body stat outside `BODY_LIMITS` (18–100 y, 120–230 cm, 30–300 kg) is **refused by
  every caller** — the executor and onboarding say the range, and under 18 points to a GP or dietitian —
  and `computeTargets` clamps into the limits as a floor under a caller that forgets, so it never
  returns NaN or a negative; a stat that is a real body outside the limits (115 cm, 101 y, 310 kg) is
  told the equation is not validated for it, never that it "doesn't look right"; the calorie floor
  applies to an unknown/other sex too; protein AND fluid are per kg of `referenceWeightKg` (weight
  capped at BMI 30), so 4P + 4C + 9F is within 7 kcal of the target everywhere in the limits.

**`nutrition/exclusions`** — *"Allergen and diet matching, word-aware, in both directions."*
- **Public:** `haystackBlocked`, `parseExclusionTokens`, `dietTagConflicts`, `wordMatches`,
  `expandExclusion` and `EXCLUSION_CATEGORIES` (read by `primitives.ts` and the property tests).
  **Private:** `ingredientHasGluten`, `CATEGORY_TERMS` and the food lists, `VEGAN_EXCEPTIONS`.
- **Invariants:** **I2 — an allergen or excluded ingredient never reaches a plate.** Matching is
  word-aware in *both* directions (`peanuts` must match `peanut butter`; `egg` must not match
  `eggplant`), including -y/-ies. **Every matcher in this module gets the same fix** — the
  sibling-path miss is lesson 14 and it has cost three separate incidents. Since D5b: **every clause**
  of a typed allergy is read, and one is dropped only when it plainly allows a SPECIFIC food: an
  allowance phrase, nothing restrictive, no "everything/anything", no neither/nor/none in its
  segment (lesson 60; the first version's broader drop lost "I can eat anything without gluten",
  found by the D5b review); punctuation, curly apostrophes, line breaks, "or", "-free", adjectives and
  coeliac/celiac never lose an allergy; synonyms and label terms are category keys (prawn/shrimp,
  soya, crustaceans, molluscs, yoghurt, groundnut); a phrase is mined for the allergens it names, but
  a carrier ("butter" in "peanut butter", "milk" in "oat milk") is not one; ALLERGIES are mined for
  every curated food a phrase names, DISLIKES only for the long-standing category words; olive oil
  and black pepper are exceptions for a DISLIKE only (an allergy adds them as tokens of its own and
  still over-blocks), and cherry tomatoes are never cherries; a lone
  non-food word ("cooked", "white", "them") is never a token; compound foods carry
  their usual allergens (whey protein powder, pizza base, tikka masala, kimchi, granola, sausages);
  and the allergen path blocks everything the diet-tag path calls gluten or dairy, across the library,
  while no recipe tagged gluten_free is removed by a gluten allergy (the two paths share the
  gluten-free exceptions: corn tortillas, chickpea flour, rice noodles…).

**`nutrition/safety`** (`src/lib/safety.ts`, **added 2026-10-03, C2**) — *"Is there a crisis or a
medical emergency in what this person wrote?"*
- **Public:** `redFlag(message)` → `{ kind: "crisis" | "urgent", text }` or null; `CRISIS_REPLY`,
  `URGENT_REPLY`. **Private:** the matcher (noise-stripped, adjacent, order-free; a multi-word flag that
  noise removal shrinks to one word must appear word for word; curly apostrophes normalised).
- **Invariants:** it runs on the user's **raw** words in both assistant routes **before any model and
  before demo mode**; the reply it returns is the **entire** reply (nothing is prepended or appended);
  `symptomNote` calls the same function, so the tool and the pre-scan cannot disagree. The flag lists
  (`symptoms.ts`) may only grow. Which way it errs on food phrases that contain a crisis phrase, and
  what else it should catch, is **owner decision #8** — asserted as-is in `test:engine` until then.

**`nutrition/grocery`, `presentation/streak`** — *"Aisle categorisation"* and *"local-day streak
arithmetic."* Public: `groupByAisle`, `aisleFor`, `AISLE_ORDER`, `Aisle`; `currentStreak`,
`isoDay`, `prevDay`. Invariant: streaks key on the **local** day, never UTC.

#### The maths must be exact — milestone A7 *(owner, 2026-09-19)*

> "This part has to be one of the most crucial features. Since it's pure mathematics, we can make it
> work well … really focus on this one and its automation, even when including expansion of
> ingredients and recipes database. This has to work perfectly."

Agreed, and the reason is the product claim itself: every number the app shows is computed here,
and pure functions are the one place where "perfectly" is actually achievable — they can be proven,
not just spot-checked. **Measured state on 2026-10-03:**

| What | Today | The gap |
|---|---|---|
| `check:recipes` (every ingredient weighable, plausible meals, Atwater) | **passes** — 501 recipes, worst Atwater miss 15% | **nothing runs it automatically**: not `ship.mjs`, not CI. A data change can ship without it |
| `deriveMacros` — the function every macro in the app comes from | **0 unit tests** (covered only indirectly by `check:recipes`) | no direct proof of the arithmetic: quantity scaling, division by servings, rounding |
| `deriveMacros` with an unknown ingredient | silently **skips** it (`if (!per \|\| !grams) continue`) | safe today only because `check:recipes` forbids unknowns; the function itself does not refuse |
| `gramsFor`, `microsForIngredients`, `computeTargets`, `haystackBlocked` | tested in `test:engine` (14 / 10 / 6 / 21 mentions) | example-based, not property-based |
| `wordMatches` | 1 test mention | the matcher every allergen check rests on |
| the USDA table's own consistency | not checked | an entry whose own kcal disagrees with its 4/4/9 would pass every gate |
| Atwater tolerance | 20% | loose enough to hide a wrong quantity |

**The A7 programme — what "works perfectly, automatically" means in checkable terms:**

1. **Properties, not examples.** For every L2 function, the laws it must obey, asserted over the
   whole library and over random inputs: macros scale **linearly** with quantity (2× the ingredient
   = 2× its contribution); dividing by servings and multiplying back agrees within rounding; unit
   conversion round-trips (`1 cup` = `16 tbsp` = `48 tsp` in grams); `bmr` reproduces the published
   Mifflin-St Jeor worked examples exactly; the calorie floor always holds; an allergen matches in
   both directions and never matches a substring of a different word (`egg` / `eggplant`).
2. **Every table entry checks itself.** Each of the 180 (soon 400) USDA entries: macros within
   physical bounds (protein + carbs + fat ≤ 100 g per 100 g), its kcal consistent with its own
   4/4/9, every unit any recipe uses has a weight.
3. **Refuse, never skip.** `deriveMacros` reports an unknown ingredient instead of silently
   contributing zero, so the guarantee lives in the function and not only in a separate gate.
4. **It runs without anyone remembering to run it.** `check:recipes` (and `check:ingredients` from
   A5) join the `ship.mjs` gate whenever `src/lib` or the data changes, and the GitHub workflow — so
   **adding an ingredient or a recipe is verified automatically, every time**, which is the part that
   makes "expand by a lot" safe.
5. **Tighten Atwater** to the tightest tolerance the measured library passes, and record the number.

**Where A7 sits in the order:** after D5 (ingredient identity — the property tests key on ids) and
before any library expansion. The schedule in `01-…md` carries it as **D5b**.

**D5b DONE 2026-10-03** — the five, as built (`fdc6e3a` the automation, then the laws):

1. **Properties.** Five families of laws (units, macro derivation, targets, the USDA table,
   allergens) were derived by a workflow, run against the code, and every failing law judged by
   three adversarial verifiers. 83 laws, 30 failing, every real one fixed — and its cases kept as
   tests, so `test:engine` now holds the laws themselves, not examples of them. The worst find was
   my own regression from the same afternoon (lesson 60).
2. **Every table entry checks itself:** physical bounds, fiber ≤ carbs, no value above the SR Legacy
   maximum for its nutrient (unit slips), kcal within 4/4/9 or its own USDA specific factors (eight
   reviewed spice/cocoa/citrus outliers), and **every missing nutrient is a documented gap**:
   `build:nutrients` fails on one that is neither filled from another SR Legacy entry for the same
   food (shrimp's B12) nor listed with a reason (tempeh and soba fiber: not reported, so those dishes
   understate fiber — not invented).
3. **Refuse, never skip:** the library will not load with an unpriced ingredient, so `next build`
   fails and it cannot deploy.
4. **Automatic:** `check:recipes` + `check:ingredients` in `ship.mjs` and in CI
   (`.github/workflows/gates.yml`).
5. **Atwater 20% → 16%**, the tightest the library passes — and it was found that Atwater *cannot*
   catch a wrong quantity (every number derives from the same table), so `check:recipes` gained what
   can: a per-slot calorie **ceiling** beside the floor.

### L3 · Plan engine — the split (see §5)

**Built 2026-10-03 (A3).** The engine is `src/lib/plan/`, nine modules plus an index, and
`recipeDb.ts` is a 10-line barrel (`export * from "./plan"` + the recipe types), so **no importer
changed**. The module graph, which the split was generated against and asserted acyclic:

```
library (126)   rules (116)                      <- depend on nothing in plan/
rebalance (318)  -> library, rules
select (494)     -> library, rules, rebalance
batch (241)      -> library, rules, rebalance, select
report (572)     -> library, rules, rebalance
boost (140)      -> library, rules, rebalance, select, report
candidates (140) -> rules, rebalance, select, batch
execute (1,309)  -> everything above
index (15)       the public surface: exactly the 22 names recipeDb.ts exported before
```

**Public vs private, mechanically:** a name is public iff `plan/index.ts` re-exports it. 59 other
names are exported between the modules so they can call each other; they are **internal to the
folder** — `check:boundaries` rule 2 fails anything outside `plan/` that imports them, and rule 4
treats the whole folder (and `data/`) as server-only, so a client cannot dodge the old payload
problem by importing `@/lib/plan` instead of `@/lib/recipeDb`. Both were proven with a probe
component that tried all three routes.

**How it was split**, so it can be redone or extended: a generator assigned each of the 115
top-level declarations to a module, resolved every reference with the **TypeScript type checker**
(not by name — dozens of locals are called `cap`, and name-matching would have invented import
edges and fake cycles), asserted the module graph acyclic and every declaration placed exactly once,
then wrote the files. The proof it changed no behaviour: a **105-point fingerprint** of every public
function over four profiles and seventeen operations (plus previews, candidates, batch, condition
weeks and the export list) is **identical** before and after; then `test:engine` as the ship gate.

The headings below are the CONTRACTS of these modules; `select` and `rebalance` here are the files
of the same names, `execute` + `report` are the executor and its note-writers.

**`plan/select`** — *"Given a profile, choose the week's dishes so every hard rule holds and the
macros land as close to target as the library allows."*
- **Public:** `selectWeekFromDb(profile, opts?)`, `selectBatchWeek`, `buildWeek`,
  `selectConditionAwareWeek`, `withSeed`, `RECIPES`, `recipeToMeal`, `recipeMicros`; and, added by
  Track E, **`swapCandidates(profile, plan, day, slot, limit?, minProtein?)`** — the dishes that
  could take a slot, each with the delta it would cause. It reuses the private `batchCandidates`
  pool, so the diet, allergen, dislike, cook-time and budget rules and the rated-1 bans all apply:
  **a candidate the executor would refuse must never be offered.**
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
  `{ plan, profile, notes, planChanged, profileChanged, replyOverride? }`; and, added by Track E,
  **`previewOperations(profile, plan, operations)`** — the same executor against a `structuredClone`,
  returning per-day deltas, the dish moves and the engine's notes, **committing nothing**. Seeded, so
  a preview does not disagree with itself between renders; a preview is therefore a prediction and
  the committed figures must be re-read.
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
  arithmetic of its own. A constrain that names nothing to change (`isEmptyConstrain`) is an honest
  no-op with a note when it is week-scoped or carries only `preserveMacros: false`
  (`noOpConstrain`, `emptyConstrainNote`); a BARE day-scoped constrain stays a re-plan, because it is
  the vocabulary's only re-roll (all three bare day constrains in the 2026-10-03 stored turns were
  "shake up the rest of the week").

**The vocabulary will grow — milestone C4** *(owner, 2026-09-19: "we will definitely need to expand
more on the primitives").* The model may emit 17 primitives plus any raw engine operation. Since
Track E, the **buttons can do things the assistant cannot say** — which is backwards for a product
whose pitch is "edit your week by chat". The gaps, found by comparing `actions.ts` against
`PrimitiveOpSchema`:

| A person can… | by hand (Track E) | by chat today |
|---|---|---|
| move a meal to another day | drag, or `M` | no — would need two swaps with exact dish names |
| fix every short day at once | "Fix my week" | no — one `rebalance_day` per day |
| skip a meal | — | no engine operation exists |
| cap tonight's cook time ("20 minutes tonight") | — | only as a standing constraint on every meal |
| put a saved or imported recipe in a slot | Explore → add to plan | partly — `swap` needs the exact name |
| say what is already in the cupboard | — | no engine operation exists |

**The rule for adding one, so the vocabulary grows without breaking the two-layer split:** a new
primitive is a *thin mapping onto an engine operation*; if the engine has no such operation, the
operation is built and tested in `test:engine` **first**, in its own commit. Every addition gets
hard-case eval rows, and a read-only one joins `reply.READ_ONLY_TOOLS`. **It changes the contract
the models lane evaluates against**, so it is announced to them before it lands. C4 comes **after**
Track A (owner comment 1) and after C2 (safety).

**Which model runs it — not this document's call.** The owner's question on the same comment —
the strongest cloud model that is still fast enough for a beta, and whether a 128 GB machine is the
answer — is the **models lane's** mandate (`docs/parallel/lane-models.md`): it is measuring quality
*and* latency on free NVIDIA NIM models now, against the 84% `gpt-oss-20b` baseline. The question
was forwarded to it verbatim on 2026-10-03. The constraint this side holds: whatever model wins
arrives through `ModelFn`, so the choice is a provider change, never a code change here.

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
- **Public:** `runAgent`, `ModelFn`, `TranscriptEntry`, `AgentTurn`, `MAX_STEPS`, `FALSE_CLAIM_NUDGE`.
- **Private:** step bookkeeping, transcript shaping, where the undo snapshot is taken.
- **Invariants:** **the model is injected as a `ModelFn`** — that is what makes the loop testable
  with no model at all, and it is the most important line in the file. `MAX_STEPS = 8` is a cap, not
  a target; hitting it sets `gaveUp` and the user is told. One undo snapshot per user turn, taken
  before the first write. A reply that claims a change nothing made gets one nudge and one retry,
  then never reaches the user (`falseClaimRetried` / `falseClaimCaught`).

**`assistant/reply`** — *"Compose the user-facing answer; engine notes are authoritative."*
Public: `composeReply`, `describeOperations`, `READ_ONLY_TOOLS`, `planWasChanged`, `claimsChange`,
`NOTHING_CHANGED_REPLY`. Invariant: a read-only tool may never report a plan change; a `replyOverride`
silences the model by **presence, not truthiness**; when the caller knows nothing changed
(`profileChanged: false` passed) and the engine is silent, model prose that `claimsChange` is
replaced by `NOTHING_CHANGED_REPLY`. `claimsChange` is the only copy of that detector, and the evals
import it.

### L5 · Adapters

**`providers/ai`** — *"One provider interface over Claude, any OpenAI-compatible server, or demo
mode."*
- **Public:** `resolveProvider`, `generatePlan`, `agentModelFn`, `parseAssistantTurn`,
  `assistantTurnSystemPrompt`, `withTargetDefaults`, `extractRecipeFromText`, and `localExtraBody`
  (`providers/extraBody.ts`: `LOCAL_AI_EXTRA_BODY`, a JSON object merged last into the local chat body —
  how reasoning is switched off on the 550B as configuration, not code; unset = the body unchanged).
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

**`presentation/actions`** (`src/app/sage/actions.ts`) — *"The one path every direct control takes:
run an operation, or preview it first."* **Added by Track E, 2026-10-02.**
- **Public:** `runOperation`, `previewOperation`, `slotCandidates`, `undoLast`, `canUndo`,
  `lastChangeLabel`, `movePair`, `fixMyWeek`, the `actions` and `previews` namespaces, `ActionError`.
- **Private:** the undo snapshot (a module variable, **deliberately not a storage key** — only
  `persistence/storage` may name one), and the fetch plumbing.
- **Invariants, and they are the whole reason this module exists:** the browser **never imports the
  engine** (501 recipes); **the engine's numbers win** — a control may render optimistically but the
  figures shown afterwards came from the response; and **the engine's notes are surfaced, not
  summarised**, because a silent refusal is the worst thing this layer can produce.
- **Dependents:** `/sage` client components only.

**`presentation/commands`** (`src/app/sage/commands.ts`) — *"Turn a typed line into an engine
operation, deterministically."*
- **Public:** `parseCommand`, `COMMAND_EXAMPLES`, `ParsedCommand`.
- **Private:** the day aliases, the filler-word set, `FOOD_FLOOR`.
- **Invariants:** pure function of a string, **no model** — "regenerate tuesday" is unambiguous, so
  anything that might answer *Wednesday* is a downgrade; it **refuses rather than approximating**
  when nothing parses; and a calorie figure is the largest number at or above 50, because taking the
  first one recorded a two-calorie breakfast from "log 2 eggs on toast 320".

**The `/sage` panels** — `Sheet.tsx` is the dialog shell (Escape, scroll-lock, focus trap, focus
return) that `MealSheet`, `ReconcileSheet` and the palette sit in. `explore/RecipeModal.tsx` predates
it and still carries its own copy of those mechanics; **folding it onto `Sheet` is owed** and is a
presentation-layer tidy-up, not engine work.

**`presentation/imagery`** (`recipes.ts`) — *"Exactly which photograph belongs to which dish."*
Public: `imageForMeal`, `cutoutForMeal`, `gradientForMeal`, `PHOTOGRAPHED_RECIPES`. Invariant: an
**exact recipe-name map**, never a pattern; a miss returns `null` and falls back to a typographic
tile; **an image appears only on the dish it depicts.**

---

## 5. The reorganisation proposal

### Modularise first — the owner's ruling, and where it actually stands *(2026-09-19, read 2026-10-03)*

> "Before starting working on all this, we should make sure everything is already modularised and we
> start building on that architecture, following its rules and structure. If this isn't done
> already, we should spend a good amount of time doing it."

**It is not done. Measured 2026-10-03:** there is **no `index.ts` barrel anywhere in `src/`**;
`recipeDb.ts` is **11,061 lines** (it was 10,850 when this map was written — Track E added ~210);
none of the three phases below has started. And the honest part: **Track E (2026-10-02) was built on
the old structure before this comment was read.** Nothing of it needs undoing — its modules
(`actions`, `commands`, `previewOperations`, `swapCandidates`) are already in this map, and Track E
kept the two-layer rule — but it was out of order, and it is the last thing that will be.

**What changes because of this comment:**

1. **Track A is a gate, not a lane.** No feature work (Tracks B, C, E) starts until Track A is
   finished: D1 the gate → D2–D3 split `recipeDb` → D4 the payload boundary → D5 ingredient identity
   → **D5a (A6) every module behind its barrel** → **D5b (A7) the maths proven exact**. Fixes to
   broken things are allowed; new features wait.
2. **Phase 3 (the folders) is committed, not optional.** Below it says Phase 3 is "worth doing only
   because it is cheap". The owner asked for the architecture to be *built on*, and a structure you
   can only see by reading this document is not one anyone builds on. It becomes milestone **A6**,
   done together with Phase 1, and the gate's rule 2 (barrels only) switches from reporting to failing.
3. **Files owned by the other lanes move only with their agreement.** `storage.ts`, `savedStore.ts`
   and `account/**` are the accounts lane's; `ai.ts`, `promptV2.ts` and `agentLoop.ts` are run daily
   by the models lane. Moving a file another agent is editing is how work gets lost in a rebase, so
   A6 is announced in `lane-v1.md` first, each owner moves (or approves moving) their own files, and
   the old path keeps a one-line re-export until every lane has rebased past it.

### Phase 1 — seal, without moving anything *(low risk, do first)*

Add an `index.ts` per module folder, move the ~60 unconsumed names off the public surface, delete
`runAssistant`. **No call site changes.** Gate: `test:engine` returns the identical count.

### Phase 2 — split `recipeDb.ts` *(the big one)*

It is 11,061 lines (10,850 when measured on 2026-09-19 — the line ranges below are from that
day and have drifted by ~210 lines since) and three unrelated jobs sharing a file:

| Lines | Share | What it is | Becomes |
|---|---|---|---|
| 179–7863 | **71%** | the 501 recipe seeds | `plan/data/seeds.ts` |
| 7864–9010 | 11% | selection, rebalancing, batch | `plan/select.ts`, `plan/rebalance.ts`, `plan/batch.ts` |
| 9011–10850 | 17% | the executor and its note-writers | `plan/execute.ts`, `plan/notes.ts` |

**Part 1 DONE 2026-10-03 (D2).** The seeds and the recipe vocabulary types are in
`src/lib/data/seeds.ts` (7,772 lines, zero imports); `recipeDb.ts` went **11,062 → 3,317 lines** and
re-exports the moved types, so **no importer was touched**. Proven three ways: a SHA-256 fingerprint of
the computed `RECIPES` (all 501, after macro derivation) and of a seeded week came out **identical**
before and after; `check:recipes` passes; `test:engine` is the same count. One stale comment was
dropped on the way ("7 breakfasts / 7 lunches / 7 dinners / 2 snacks" — from when the library had 23).

**Part 2 DONE 2026-10-03 (D3).** The rest of `recipeDb.ts` is `src/lib/plan/` — nine modules and
an index (§4 L3 has the graph) — and `recipeDb.ts` is a **10-line barrel**. It went further than the
table below planned, for a reason worth keeping: moving only the executor out would have left
`execute.ts` importing helpers from `recipeDb.ts` while `recipeDb.ts` re-exported `execute.ts` — an
import cycle, which `check:boundaries` forbids. So `recipeDb.ts` had to become a pure barrel, and
everything in it had to land somewhere. A 105-point behavioural fingerprint is identical before and
after.

Done in **two days, data first** (D2, D3 in the schedule), each behind a barrel that re-exports
today's 18 consumed names unchanged, so **no importer is touched on either day**. The gate is that
`npm run test:engine` produces the *same number of passes*, before and after — a split that changes
behaviour shows up as a count change, and a split that loses an export fails `tsc`.

### Phase 3 — the folders *(mechanical, one commit)*

**Decided 2026-10-03, when the first file had to go somewhere: the folders live under `src/lib/`**
(`src/lib/data/`, `src/lib/plan/`, …), not at `src/` beside `app/`. Two reasons: `src/app` and
`src/components` are Next's tree, and mixing the library into it blurs the one line the payload
boundary depends on; and keeping `src/lib/` means every `@/lib/…` import stays valid, so a move is a
path change inside the library rather than an edit to every screen. The layout below is the target
with `src/lib/` as its root. (This document and the schedule had disagreed with each other —
`plan/data/seeds.ts`, `src/lib/recipes/data.ts`, `src/data/seeds` — which is now settled.)

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

**D5a part 1 DONE 2026-10-03 — the folders exist.** 26 files moved: `core/` (types, slots),
`data/` (+ the USDA table, symptoms, substitutions, conditions), `nutrition/` (units + its unit table,
nutrients, targets, exclusions, safety, grocery), `assistant/` (primitives, agentTools, agentLoop,
reply, promptV2), `providers/` (ai, import, videoImport), `presentation/` (feed, feedFilter, recipes,
batchGrocery, streak). Every src/lib import now points at the real path; **every old path is a one-line
`export *`**, so `src/app`, `scripts/` and the other lanes' branches import exactly as before. The
models lane agreed first; the accounts lane's `storage.ts`, `savedStore.ts` and `account/` stay put
until they answer (asked in lane-v1.md). Gates: `tsc`, `check:boundaries` (same 6 debts,
`providers/` now server-only as a folder), a 139-hash fingerprint of every module's export surface
and the engine's behaviour (identical), and a production build (route sizes within 1 kB of HEAD's).
**Part 2 DONE** (`cc38524`): the micronutrient vocabulary → `core/micros.ts`, the imported-recipe shape and
converter → `core/imported.ts`; three debts paid. **Part 3 DONE** (2026-10-03): every folder has an
`index.ts` carrying only the names someone outside it uses (computed from the code, plus the models
lane's list), and the folders the browser uses also have a **`client.ts`** — `core/client` (no zod),
`nutrition/client` (no USDA table or ingredient data), `presentation/client` (no engine). 111 imports
were rewritten to the barrels; nothing in `src/` reaches past one, and **rule 2 now passes with no
exemption except the D5a re-export shims** (recognised by exact shape; a look-alike that adds code is
caught — both in the gate's self-test, now 14/0). **Measured, and the reason `package.json` declares
`"sideEffects": ["*.css"]`:** the barrels alone cost every `/sage` route 3–7 kB of first-load JS
(Explore 132 → 139 kB), because without that declaration webpack keeps every module a barrel touches.
With it, every `/sage` route is back to its exact pre-barrel size and `/plan` drops 207 → 186 kB. The
only bare side-effect import in `src/` is `globals.css`, and every listener in `src/lib` is registered
inside a function; a module that ever needs to run on import must be added to that list.
**Still open:** removing the shims — when the models lane (which will import the barrels), the
accounts lane (three imports, now listed debts) AND this lane's own `scripts/` have moved: 15 script
files import through the shims, and 11 of `test-engine`'s names are private (`extractVideoText`,
`UNIT_GRAMS`, `parseIngredient`, `decodeEntities`, and the seven read tools), so they move to deep
paths, which the `scripts/` exemption allows. `ship.mjs` now type-checks `scripts/` on every gated
commit, so a shim removed too early fails there rather than at Vercel. Also open: the accounts lane's
files into `persistence/` (asked), and the last two layer/payload debts (the assistant's find_recipes
through the feed; `/plan`'s library import).

**The value split, and why Phase 3 is done anyway:** Phases 1 and 2 deliver most of the
*enforcement* — sealed contracts and a file you can hold in your head. This section used to say
Phase 3 was worth doing "only because it is cheap". **The owner's ruling (top of this section)
overrides that:** the point is to build *on* the architecture, and a structure visible only in a
document is not one anyone builds on. So Phase 3 is milestone **A6**, done with Phase 1, `tsc` +
an identical `test:engine` as its gate, coordinated with the other lanes. **It must not be attempted
in the same commit as a behaviour change.**

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
| 7 | Every local import **resolves** — and none is computed | a path the gate cannot follow is a path it cannot check |
| 8 | Nothing depends on **running at import time** | `"sideEffects": ["*.css"]` lets the bundler drop it |
| 6 | No **emoji** in `src/` | a standing project rule with no enforcement today |

`scripts/` is exempt by name (§2). Every failure prints the offending file, the import, and the rule
in plain English — a gate that says "violation in 3 files" teaches nobody anything.

### Built 2026-10-03 — `scripts/check-boundaries.mjs`

**What it is.** One node script, no new dependency: it parses imports with the TypeScript compiler
(already installed), so a comment or a string can never fool it, and runs in ~1.3 s over the 78 files
in `src/`. It also enforces a **rule 0**: every file under `src/lib` must be placed in a layer, so a
new module cannot arrive unowned. The layer table in the script is §2 of this document as data;
**change one, change the other, same commit.**

**Two decisions that make its answers true rather than plausible:**

- **Rule 4 reads what the bundler ships, not what the source says.** Each file is transpiled first,
  and TypeScript drops an import whose names are only used as types, with or without the `type`
  keyword. Reading the source would have accused `import { Recipe } from "@/lib/recipeDb"` of
  shipping 501 recipes. Rule 1 (layers) deliberately counts type imports too: depending on a higher
  layer's *types* is still depending on that layer.
- **Rule 3 matches the key convention, not the prefix.** Keys are `nutriflow.<name>`. The first
  version matched anything starting `nutriflow` and flagged the export format tag
  `"nutriflow-export"` and the download filename `nutriflow-<date>.json` in the accounts lane's
  `portable.ts` — neither is a key. A gate that cries wolf gets ignored. A key in any other shape
  cannot reach the browser without touching `localStorage` directly, which the other half of the
  rule catches.

**Known debt, and why the list can only shrink.** The code broke some rules on the day the gate was
written. Failing on them forever would make the gate a thing people skip; weakening the rules would
make it a lie. So each one sits in `KNOWN_DEBT` with the milestone that removes it. A listed debt
passes and is printed every run. A **new** violation fails. A debt that has been **paid** also fails
until its entry is deleted, so the list never claims a problem that is gone.

| # | Debt | Owed to |
|---|---|---|
| 1 | ~~Explore → `feed.ts` → `recipeDb` (the whole library ships)~~ — **PAID 2026-10-03**: `feed.ts` split into the client-safe `feedFilter.ts` and a server `feed.ts`; the cards arrive as a prop. `/sage/explore` **189 → 114 kB** first-load JS (the HTML grew 32 → 80 kB gz — net ≈ −26 kB) | A4 |
| 2 | `/plan` → `feed.ts` → `recipeDb` | A4 / B2 |
| 3 | ~~`WeekBoard` → `../demo` (for `SLOTS`) → `recipeDb`~~ — **PAID 2026-10-03**: `SLOT_LABELS` moved to `@/lib/slots`; `/sage/plan` first-load JS **226 → 129 kB** | A4 |
| 4 | ~~**`GroceriesClient` → `batchGrocery` → `nutrients` → the USDA table**~~ — *new, found on the first run*; **verified real by build measurement** (`fdcId` in the route's chunks; 45 kB raw / 11 kB gz), then **PAID 2026-10-03**: the generator emits the unit weights into their own `unitGrams.generated.ts`, `gramsFor` lives in `units.ts`, `batchGrocery` imports that. `/sage/groceries` **123 → 113 kB** | A4 |
| 5 | ~~**`/plan` → `import.ts`** (a pure converter living inside the network adapter)~~ — **PAID 2026-10-03 (D5a part 2)**: `ImportedRecipe` and `importedToMeal` moved to `core/imported.ts`; `providers/import.ts` re-exports them | B2 / A6 |
| 6 | **`agentTools` (L4) → `feed` (L6)** — searching the library is engine work, the query moves down — *new* | A6 |
| 7 | ~~**`conditions`, `symptoms` (L1) → `nutrients` (L2)**~~ — **PAID 2026-10-03 (D5a part 2)**: `MICRO_KEYS`, `MicroKey`, `Micros`, `MICRO_LABEL`, `MICRO_UNIT` moved to `core/micros.ts`; `nutrients.ts` re-exports them | A6 |
| 8 | `ThemeSwitch` writes `localStorage` itself (the theme key predates the rule) | A6, with the accounts lane |
| 9–11 | **`storage.ts` → `./types` and `./import`; `account/validate.ts` → `../slots`** — the old flat paths, found when importing a D5a shim became a violation (2026-10-03). Every name they use is in `core/client` | the accounts lane |

Row 6 is keyed on its **names** since the D5a review: it covers `FEED_RECIPES`, `filterFeed`,
`sortFeed` and `FeedSort` and nothing else, so the import cannot grow behind the debt (it covered the
whole `presentation` index after part 3 renamed its key — imagery, batchGrocery, streak and all).

Rows 1–3 were known (they are A4's measured target). **Rows 4–7 were not known by anyone** — which is
the whole argument for having the gate. Rule 5 (cycles) and rule 6 (emoji) found nothing; rule 2
(barrels) is vacuous until A6 creates the first `index.ts`, and switches on by itself when it does.

**It has been seen to fail** — `npm run check:boundaries -- --self-test` runs every rule against
fixtures that break it on purpose (11/0), including the two cases it must *not* flag (a key in a
comment, a type-only import). It was also proven on the real tree: a probe component that touched
`localStorage` and imported `RECIPES` failed three rules in plain English, and a stale debt entry
failed as "paid".

**It runs without anyone remembering.** `scripts/ship.mjs` runs it first whenever a ship touches
`src/`, before `test:engine` or `tsc`, so a layering mistake fails in a second rather than after a
25-minute suite. A branch that predates the script skips it rather than failing.

### Hardened 2026-10-03 — what an adversarial review of D5a found in it

Four reviewers attacked the gate after the folder move, each with a probe against the real `check()`.
Every hole below was reproduced, then fixed, and each fix has the self-test fixture that would have
caught it (**11 → 41 cases**, all green; the real tree passes with the debts above).

- **It resolved imports with string concatenation.** `"@/lib/plan/"`, `"@/lib/./recipeDb"`,
  `"@/app/../lib/recipeDb"` and `require("@/lib/recipeDb")` each shipped the whole engine to a client
  component with the gate green (a real esbuild bundle printed 501 recipes for each). It now resolves
  with **TypeScript's own resolver under `tsconfig.json`**, over the in-memory tree (so fixtures still
  work); `require()`, `import x = require()` and `/// <reference>` are read; and a local import that
  resolves to nothing, or a computed `import()`, **fails** (rule 7) instead of being taken for a package.
- **Type positions were invisible.** `import("../assistant/agentLoop").ModelFn` reached past a barrel
  four times in `providers/ai.ts` and passed. Rules 1 and 2 now read `import("x").T` too (and the four
  are fixed).
- **An exemption by location exempted the importer as well.** A shim sits outside every module folder,
  so any file could import any PRIVATE name through an old flat path (66 such names; `runAssistant`,
  `fetchHtml`, every read tool). **Importing a shim from `src/` is now rule 2** (`old-path:`), with the
  accounts lane's three imports listed as debts. Shims are recognised from the **parsed** file, not a
  regex: a lone CR or U+2028 ends a `//` comment for the parser but not for `[^\n]*`, which let a
  look-alike carry code.
- **Entry points were matched by suffix.** A `client.ts` one folder deeper counted as the module's
  entry. Now exact: `index.ts`, or `client.ts` **only when it is a pure re-export barrel in a folder
  that is not server-only** — `account/client.ts` is sync glue, not a door.
- **`assistant/` was server-only by four file names**, so its fifth file, `reply.ts`, and any future
  `assistant/client.ts` were open. The whole folder is server-only now.
- **Packages were never followed, so zod was free.** `/onboarding` shipped all of zod for
  `DEFAULT_TARGETS` (six numbers); `core/client.ts` could have re-exported `types.ts` with the gate
  green. Rule 4 now fails a client component — **or a `client.ts` entry, imported or not** — that
  reaches `zod`, `@anthropic-ai/sdk` or `typescript` by value. `DEFAULT_TARGETS` moved to
  `core/defaults.ts` (in `core/client`); `/plan` takes `DAYS` from `core/client`.
- **`.js`/`.jsx` files were never walked**, though `allowJs` is on. They are now.
- **The sideEffects promise was prose.** Rule 8 fails a bare `import "./x"` of a script, any statement
  at the top level of `src/lib` that runs on load, and `package.json` drifting from `["*.css"]`.
- **No gate type-checked anything after a `src/lib` change**, and `tsc` never saw a `.mts` script —
  esbuild does not check that an imported TYPE exists, so a narrowed barrel passed every gate and
  would have failed only at Vercel. `ship.mjs` now runs `tsc -p tsconfig.scripts.json` (src + scripts,
  ~6 s) on every gated commit, and `--self-test` whenever the gate itself changes; CI runs both.
  (It found three type errors in `test-ui.mts`, fixed.)
- **Rule 5's self-test only had a plain-import cycle.** It now proves a cycle closed only through
  re-export barrels is caught, and one whose closing edge is `export type` is not.

**The method used to produce §3, so it can be re-run:** parse every `import { … } from "…"` in
`src/` and `scripts/`, resolve `@/lib/x` and relative specifiers to a module, and compare the set of
imported names against the set of `export`ed ones. Anything exported and never imported is
over-exposure. It takes about 40 lines of node and it should become part of the gate, so the
over-exposure count can only go down.
