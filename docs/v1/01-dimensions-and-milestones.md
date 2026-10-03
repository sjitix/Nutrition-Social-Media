# V1 — the dimensions, and the day-by-day schedule

*Deliverable 1 of the planning conversation briefed in `docs/v1-modularization-kickoff.md`.
Written 2026-09-19 against the code as it stands at `125d7b3`, not from memory — every "state"
claim below was checked by reading the file or the import graph, and the method is named where it
matters.*

**Read with:** `02-module-map.md` (the contracts these milestones are built on),
`03-kimi-decision.md` (which model the assistant days assume), `04-daily-history.md` (where each
day's result gets recorded), and **`05-direct-manipulation.md`** — Track E, the 8-hour day that turns
the engine's 19 tested operations into controls you press. That is the product thesis and it needs no
model at all.

---

## 1. What V1 means

A version number is worthless until it names a bar. The one proposed here, and it is the bar every
milestone below is judged against:

> **V1 is the product a stranger can use end to end on their own phone, that is honest about every
> number it shows, and that we can put in front of an audience without a caveat.**

Concretely, the V1 walk-through that must work with no explanation from us:

1. Open the site on a phone → understand what it is in five seconds.
2. Onboard → get a real week (fresh **or** meal-prep), macros on target, constraints respected.
3. Change it by talking to it — "make Tuesday vegetarian", "I hate mushrooms", "I ate a burger" —
   and watch the plan actually change, correctly.
4. Shop from it (aisle-grouped list, check-offs that persist).
5. Come back tomorrow and it is all still there.

**Explicitly OUT of V1** (roadmap Phases 4–5, unchanged): user uploads / creator tools, the workout
vertical, and any social feed beyond Explore. They are the *next* product, not a finished one.

**The three things that would make it not-V1 if they shipped broken**, in priority order: a
constraint violation (an allergen on a plate), a number that lies (a figure the engine did not
produce), and a dead end on a phone. Everything in the schedule serves one of those three.

---

## 2. The dimensions, enumerated against the code

Every product dimension, where it actually lives, and what V1 still needs from it. State was
verified by reading the files listed — `state` is what the code does today, not what a doc claims.

| # | Dimension | Lives in | State today | What V1 still needs |
|---|---|---|---|---|
| 1 | **Plan engine — fresh** | `recipeDb.ts` (`selectWeekFromDb`, `rebalanceWeek`) | Done, hardened, fuzz-tested | Nothing. Don't touch except to split the file (Track A). |
| 2 | **Plan engine — batch/meal-prep** | `recipeDb.ts` (`selectBatchWeek`, `rebalanceBatchWeek`, `buildWeek`), `batchGrocery.ts` | Done M1–M6 + tail | Per-batch locks (benign; slack item B5) |
| 3 | **Recipe library** | `recipeDb.ts` (501 in `SEED_RECIPES`, counted) | 501 recipes built on 180 ingredients | **Owner wants it expanded "by a lot"** — gated on #23, see §8 |
| 3b | **Ingredient data** | `nutrientTable.generated.ts` — **180 entries** (verified 2026-10-03; 182 was quoted before), each with a real `fdcId` | Keyed by **name**; recipes reference it as **free text**, no id | **Identity (D5)** — the schema decision that unblocks both expansion and #24 |
| 4 | **Write surface / executor** | `recipeDb.ts` (`applyOperations`), `primitives.ts` (`applyPrimitives`) | Done, adversarially reviewed | Nothing behaviourally; it needs its own module (A3) |
| 5 | **Assistant — agent loop** | `agentLoop.ts`, `agentTools.ts`, `/api/assistant-v2`, `/sage/assistant` | Built + wired + on screen | A model behind it (Track C), and the quality bugs |
| 6 | **Assistant — safety** | `symptoms.ts`, `reply.ts` (`replyOverride`), `recipeDb.ts:9238` | Guard fires **only** if the model routes to `symptom_check` | **Pre-scan of the raw message — a V1 blocker** (C2) |
| 7 | **Import — URL + video** | `import.ts`, `videoImport.ts`, `/api/import` | Done, SSRF-guarded | Nothing. Residual DNS-rebinding is documented, post-V1. |
| 8 | **Explore / feed** | `feed.ts` (server) + `feedFilter.ts` (client-safe), `sage/explore/*` | Done, interactive, 495 cards; **payload fixed in A4** (212 → 114 kB first-load JS) | Load the modal's ingredients + steps lazily (the cards now ride in the HTML: 32 → 80 kB gz) |
| 9 | **Groceries** | `grocery.ts`, `batchGrocery.ts`, `sage/groceries/*` | Done, fresh + batch | Nothing |
| 10 | **Today** | `sage/today/*` | Real weekday, real clock | "Eaten" is **inferred from the clock** — needs a real log (B1) |
| 11 | **Week board** | `sage/plan/WeekBoard.tsx`, `myPlan.ts` | Per-user, regenerate + assistant link | Nothing blocking |
| 12 | **Onboarding / profile** | `onboarding/page.tsx` (388 lines), `targets.ts` | Done | First-run resilience pass (B3) |
| 13 | **Persistence** | `storage.ts` (17 keys), `savedStore.ts` | localStorage only | Export/import escape hatch (B3); accounts behind the seam |
| 14 | **Accounts** | *nothing* — `savedStore.ts` is the seam | Decided, not started, blocked on Supabase URL + anon key | Owner-gated. V1 ships without; see §5. |
| 15 | **Design system / shell** | `sage/layout.tsx`, `SidePanel.tsx`, `globals.css` (14 tokens) | Done, approved | Mobile verification below 500px (D2) |
| 16 | **The second app** | `plan/page.tsx` — **1,819 lines**, a full parallel app | Live at `/plan`, duplicates /sage's features | **Decide: retire, freeze, or keep** (B2) |
| 17 | **Photography** | `recipes.ts` (`RECIPE_IMAGES`), `public/food/` | 5 of 501 photographed | `check:images` gate + a batch of dishes (B4) |
| 18 | **Micronutrients + conditions** | `nutrients.ts`, `conditions.ts` | Engine done; `selectConditionAwareWeek` **not wired** | Ask-vs-auto-apply call, then wire (B6) |
| 19 | **Meal logging / streak** | `streak.ts`, `log_meal` in the executor | Engine-only; **nothing in the UI writes a log** | B1 — this is the missing feedback loop |
| 20 | **Gates / observability** | `test:engine`, `check:recipes`, `check:data`, `test:api`, `eval:hardcases` | Strong (`test:engine` 660/0, `test:ui` 51/0, `test:api` 60/0 on 2026-10-03; `check:recipes` passes but nothing runs it automatically — A7) | `check:boundaries` (A1), `check:images` (B4), an eval **scorecard file** (C1) |
| 21 | **Deployment** | Vercel + GitHub Pages | Both live | Release pass (D4) |
| 22 | **Work record** | *nothing* | Sessions are reconstructed from `CONTEXT.md` | The daily history (D1 / doc 04) |
| 23 | **Library growth capacity** | the 180-entry ingredient table + `npm run build:nutrients` | Each new ingredient needs a **hand-curated FDC id**; auto-matching is banned | A curation helper (B7, D5) so the rate isn't an afternoon per ingredient |
| 24 | **Real-world products** (Lidl and the like) | *nothing* | No product, price, pack-size or availability layer exists at all | **A decision, not a build — see §8** |

**Two dimensions were missing from the roadmap and are real:** #16 (there are two apps and only one
can be V1) and #19 (the plan is written but never *observed* — nothing records what was eaten, so
Today has to guess and the assistant can never say "you've been 20 g short all week"). Both are in
the schedule.

**Two more were added by the owner on 2026-09-19** (as a comment on the schedule board): #23 and
#24 — expand the library a lot, and think about wiring ingredients to real retailer products.
§8 works through what that actually costs and what belongs in V1.

---

## 3. The four tracks, and why the order is what it is

The tracks run **in parallel**; the ordering *within* a track is a dependency, not a preference.

| Track | Owns | Why it is sequenced this way |
|---|---|---|
| **A — Architecture** | the module contracts + the splits | Contracts first, then splits, then the payload boundary. Splitting a 10.8k-line file before its public surface is written down is how a consumer silently loses a function. |
| **B — Product** | the gaps a user would hit | Logging before anything that reasons about history; the one-app decision before polish, so polish is spent once. |
| **C — Assistant** | model choice + behaviour | The **crisis pre-scan gates a public live model** — it is the one hard ordering constraint in the whole plan. Proactive suggestions come after logging, because "you're short on protein" is better evidence than "your plan is". |
| **D — Trust & release** | the record, the device, the ship | The daily history starts on day 1 or it never starts. Device verification comes late, after layout stops moving. |
| **E — Direct manipulation** | the app as something you operate with your hands: tap a meal and change it, drag it to another day, log what you actually ate, and watch the plan re-solve | **This is the product thesis, and it needs no model.** 19 engine operations, `whatIf` previews and a no-model route already exist and are tested — the only missing layer is the controls. Full plan: **`05-direct-manipulation.md`** (one 8-hour day). It also **shrinks C3**: "Thursday is 40 g short → Fix" is a one-tap chip here, so what is left for the assistant is only the genuinely conversational part. |

**The relationship rule between tracks:** A changes *where code lives* and must not change what it
does (gate: `test:engine` identical before and after). B and C change *what it does* and must not
move files. Never run an A-day and a B/C-day against the same module on the same day — a red gate
then has two candidate causes, which is exactly the trap lesson 2 and lesson 44 both describe.

**Track A first — the owner's ruling** (comment on the module-map board, 2026-09-19: *"make sure
everything is already modularised and we start building on that architecture … if this isn't done
already, we should spend a good amount of time doing it"*). **Track A is a gate on all feature work,
not one lane among four:** no B, C or E milestone starts until D1–D5b are done. Fixes to broken
things are allowed; new features wait. **This comment went unread until 2026-10-03, and Track E was
built in between on the old structure** — nothing of it needs undoing (its modules are in the map
and it kept the two-layer rule), but it ran out of order, and that is recorded rather than smoothed
over. Track A also grew because of it: **D5a (A6)** puts every module behind a barrel in its folder
— Phase 3 of the reorganisation, previously "optional, because cheap", now committed — and **D5b
(A7)** proves the maths exact (owner comment on L2). Full reasoning: `02-module-map.md` §0 and §5.

---

## 4. The schedule

Sixteen working days — the original twelve, plus **D5** (the owner asked for the library to grow a
lot, §8), plus **D5a, D5b and D9a** (from the owner's comments on the module-map board,
2026-09-19). The inserted days carry letter suffixes rather than renumbering the rest, because other
lanes' files and the history already point at D6–D13 by number. Each day: one **main** milestone (the day's real work) and one **parallel**
item (small, independent, different module — the thing that keeps two threads moving without two
causes for one failure). Every day ends green and pushed; a day that ends red rolls forward and the
schedule slips by a day rather than pretending.

| Day | Main milestone | Parallel | Usable on its own when… | Depends on | Gate |
|---|---|---|---|---|---|
| **D1** | **DONE 2026-10-03 (`4e3be01`)** — all six rules plus a rule 0 (every `src/lib` file placed in a layer), parsed with the TypeScript compiler, run by `ship.mjs` on every `src/` change, seen to fail (`--self-test` 11/0). It found **four debts nobody knew** (the USDA table shipping on Groceries; the assistant importing the feed; two data files importing the maths layer; `/plan` shipping the importer) — nine debts listed in all, each with the milestone that pays it, and the list may only shrink. Details: `02-module-map.md` §9. **A1 — freeze the contracts.** Land `02-module-map.md` as the enforced truth: add `npm run check:boundaries` (a homemade gate in the `check:recipes` family, no new dependency) asserting the layering: no client component imports the engine, no module imports above its layer, only `storage.ts` names a storage key. | **D1-p** — stand up the daily-history log (doc 04) and write day 1 into it | The gate runs, names a violation in plain English, and passes on a clean tree | — | `check:boundaries` + `tsc` |
| **D2** | **DONE 2026-10-03** — the seeds and the recipe types are in `src/lib/data/seeds.ts` (zero imports); `recipeDb.ts` **11,062 → 3,317 lines**; no importer touched; the computed library and a seeded week fingerprint **identical** before and after. Folders live under `src/lib/` (decided here, `02-…md` §5). **A2 — split `recipeDb.ts`, part 1: data out of engine.** `SEED_RECIPES` (≈7.9k lines) moves to `src/lib/recipes/data.ts`; selection + rebalancing stay. A barrel re-exports the existing 24 names so **no call site changes**. | — | `test:engine` is byte-for-byte the same result and no importer was touched | D1 | `test:engine` **660/0** (the count on 2026-10-03), unchanged |
| **D3** | **DONE 2026-10-03** — all of the engine is in `src/lib/plan/` (library, rules, rebalance, select, batch, report, boost, candidates, execute + `index.ts`); `recipeDb.ts` is a **10-line barrel**, under the ~2k target by two orders of magnitude, because a half-split would have been an import cycle. No importer touched; a 105-point fingerprint identical before/after; `check:boundaries` rule 2 now enforces the `plan/` index. **A3 — split part 2: the executor.** `applyOperations` → `src/lib/plan/execute.ts`; batch selection → `src/lib/plan/batch.ts`. Same barrel discipline. | **C1-a** — start the K3 re-run in the background (it takes ~50 min of wall-clock and marinates) | Same suite result; `recipeDb.ts` is under ~2k lines and is *one* idea | D2 | `test:engine` unchanged |
| **D4** | **IN PROGRESS 2026-10-03.** *Re-measured at `c61cb13`, per route from the build manifest:* the library chunk (344 kB raw / **69 kB gz**) shipped on `/plan`, `/sage/explore`, `/sage/plan`; the USDA table (45 kB / **11 kB gz**) on those three **and `/sage/groceries`** (real, not a tree-shaking artefact — it sits in a chunk shared across routes). **The marker test is corrected:** `Shakshuka` and `Miso-Glazed Cod` stay in client chunks legitimately (two of the five photographed dishes, in the exact image map, e.g. on `/sage/today`), so the markers that prove the library is gone are **`approxCost`** (library) and **`fdcId` / `perIngredient`** (table). **Step 1 done:** WeekBoard took `SLOTS` from `demo.ts` → now `SLOT_LABELS` in `@/lib/slots`: **`/sage/plan` 226 → 129 kB**, `approxCost`/`fdcId` gone from it (Explore 212 → 189, `/plan` 219 → 196 from the re-split shared chunks). **Step 2 done:** the unit weights are generated into their own `unitGrams.generated.ts` and `gramsFor` lives in `units.ts` (both generated files verified content-identical to what they replaced): **`/sage/groceries` 123 → 113 kB**, `fdcId` gone (`perIngredient` stays — it IS the unit weights the list needs, so it is the wrong marker for the table). **Step 3 done:** `feed.ts` split — the client-safe `feedFilter.ts` (card type, `filterFeed`, `sortFeed`) and a server `feed.ts` that builds `FEED_RECIPES`; Explore's server page passes the cards as a prop: **`/sage/explore` 189 → 114 kB first-load JS**, no library marker left on it. **Honest net:** the cards now travel in the HTML instead (Explore's HTML 32 → 80 kB gzipped), so over the wire it is ≈ −26 kB, plus the browser no longer parses and runs a 344 kB library to show a list. **Every `/sage` route is now free of the library and the table.** Left: `/plan` (owner decision #2 — retire/freeze), and a follow-up to load the modal's ingredients+steps lazily (cuts most of that +49 kB HTML). **A4 — the browser payload boundary.** Introduce the card projection (`RecipeCard`: only what a card renders) so the client stops importing 501 full recipes. **Measured 2026-10-03: the library IS in a client chunk** — `Shakshuka`, `Miso-Glazed Cod`, `fdcId` and `approxCost` all appear in `.next/static/chunks/*.js`, and zod with them. Baseline first-load JS: **`/sage/plan` 216 kB, `/sage/explore` 212 kB** against 102 kB shared. Those four greps are the test. | **C1-b** — record the Kimi decision from the scorecard (doc 03) | Those markers are GONE from the client chunks and first-load JS drops against the 216/212 kB baseline, with the number recorded | A3 | `npm run build`, markers grepped, first-load JS compared |
| **D5** | **DONE 2026-10-03** (`docs/v1/06-ingredient-identity.md` is the design and the log). Every curated ingredient has a permanent `slug`; all 2,296 recipe references carry it as a REQUIRED `IngredientSlug` — **a misspelled ingredient now fails `tsc`**; one resolver (`tableKey`) decides "which ingredient is this" for every nutrition lookup; `Meal.ingredients[].slug` is optional, so stored/synced plans stay valid; `npm run check:ingredients` gates it. Slug-blind fingerprint identical through all five steps. Curation follow-ups it surfaced (one unused ingredient; the same food named twice — egg/eggs, bell-pepper/bell-peppers) wait for B7. **A5 — ingredients become a first-class entity.** The 180 curated ingredients are keyed by *name* and every recipe references them as **free text**. Give each a stable id, have recipes carry that id, and add `check:ingredients` asserting every one of the **2,296** recipe ingredient references (measured from the engine 2026-10-03 — 179 distinct names, 103 of them resolving only after case/whitespace normalisation, which is the fragility an id removes) resolves to a real FDC-backed entry. Nutrition maths is unchanged — this is identity, not arithmetic. | **B7** — a curation helper that *proposes* USDA matches for a new ingredient for a human to confirm. Never auto-accepts: `salmon fillet → Salmonberries` is why. | Every recipe resolves to ids with zero unmatched, and adding an ingredient is a minutes-long job instead of an afternoon | D3 | `check:ingredients` + `test:engine` unchanged |
| **D5a** | **A6 — every module behind its barrel, in its folder.** *(Owner comment 1, 2026-09-19.)* Phases 1 and 3 of `02-module-map.md` §5 together: an `index.ts` per module carrying only its public names, the folders (`core/`, `data/`, `nutrition/`, `plan/`, `assistant/`, `providers/`, `persistence/`, `presentation/`), and the gate's rule 2 (no deep imports) switched from reporting to failing. **Coordinated with the other lanes**: their files move only with their agreement, and each old path keeps a one-line re-export until every lane has rebased past it. | — | No deep import anywhere outside `scripts/`; the 68 promises-kept-to-nobody count is driven down and the new number recorded | D5 | `check:boundaries` (rule 2 enforcing) + `tsc` + `test:engine` identical |
| **D5b** | **DONE 2026-10-03** (`fdc6e3a` the automation, then the laws). 83 laws over five families (units, macro derivation, targets, the USDA table, allergens), derived by a workflow and run against the code; each of the 30 failing laws judged by three adversarial verifiers, every real one fixed with its cases kept as tests. Found and fixed: an allergy regression from the same afternoon ("fine with almonds but allergic to peanuts" was served peanuts — lesson 60) and 15 of 17 ordinary ways of typing an allergy losing it; synonyms, compound foods (whey protein powder, pizza base, tikka masala, kimchi), five wrong diet tags; unit plurals, size words and a parser that read "2 (400 g) cans" as 200 g (seven recipes re-weighed); body stats outside the adult range now refused (age 500 was told "-570 kcal"); shrimp B12 filled, every other USDA gap documented; the library refuses an unpriced ingredient; Atwater 20% → 16% plus a calorie ceiling, because Atwater cannot catch a wrong quantity. Detail: `02-module-map.md` §4 L2. **A7 — the maths, proven exact.** *(Owner comment on L2, 2026-09-19: "this has to work perfectly".)* Property tests for every L2 function (linear scaling, unit round-trips, published Mifflin-St Jeor examples, allergen matching both ways); every USDA entry checks its own 4/4/9; `deriveMacros` refuses an unknown ingredient instead of skipping it; **`check:recipes` + `check:ingredients` join the `ship.mjs` gate and CI**, so a new ingredient or recipe is verified automatically; Atwater tightened from 20% to the tightest the library passes. Full list: `02-module-map.md` §4 L2. | — | Adding an ingredient or recipe cannot reach `main` without every check running, and each L2 law has a property test | D5 | `test:engine` + `check:recipes` + `check:ingredients`, all now automatic |
| **D6** | **The pre-scan is DONE EARLY, 2026-10-03** — a safety mechanism that demonstrably failed is a fix, so the Track A gate allows it. The models lane measured the old guard missing a real crisis message twice (a model paraphrased it inside `symptom`; another emitted no `symptom` at all). Now `redFlag` (`src/lib/safety.ts`) runs on the user's RAW latest message in **both** assistant routes **before any model and before demo mode** (the public URL runs demo mode and was answering crisis messages with the canned demo reply); `symptomNote` calls the same function. On the models lane's set: should-hit **15/15** (+5/5 curly-apostrophe variants — phone keyboards broke the word split), must-not-hit fires on exactly **5 known conflicts** (owner decision #8), gap **0/7** (#8). Found on the way: the flag "end it all" collapsed to the single word "end" after noise removal, so "at the end of the day" was a suicide crisis — fixed (a short flag must now appear word for word). **Remaining for D6:** ban non-library dish names, strip emoji, the fuzzy swap-match. **C2 — safety + the three assistant bugs.** The **crisis pre-scan** on the raw message (before the model sees it); ban non-library dish names in replies; strip emoji (project rule); fix fuzzy swap-match ("burger" must not return a shrimp salad). | **B5** — per-batch locks (the batch tail) | A crisis phrasing is caught even when the model would have answered it, proven by a test | C1-b (model chosen) | `test:engine` + new safety tests |
| **D7** | **B1 — meal logging, end to end.** A UI write path for `log_meal`; Today stops inferring "eaten" from the clock and reads the log; `SLOT_HOUR` becomes the fallback, not the truth. | **D1-p** — daily history entry | Today shows what you actually logged, and says so honestly when you have logged nothing | A3 (executor is its own module) | `test:engine` + `test:api` |
| **D8** | **B2 — one app.** Execute the decision on `/plan` (1,819 lines): retire to `/classic`-style archive, or keep and justify. Whatever it is, one app is the product. | **B6** — wire condition-aware generation on the ASK path (VISION says ask) | Every nav path leads into one coherent app; nothing links to a dead screen | Owner decision (§5) | `tsc` + `build` + link crawl |
| **D9** | **C3 — the assistant speaks first.** RULE 3: a standing check produces a suggestion ("Thursday is 40 g short — fix it?") accepted in one tap, on Week and Today. | — | The suggestion is engine-derived, one tap applies it, and it never appears when there is no shortfall | B1, C2 | `test:engine` + a11y check |
| **D9a** | **C4 — the assistant's vocabulary grows.** *(Owner comment on primitives, 2026-09-19.)* Everything a button can do, the assistant can say: move a meal to another day, fix every short day at once, skip a meal, cap one meal's cook time, put a saved or imported recipe in a slot, "I already have rice". Each primitive is a thin mapping onto an engine operation; a missing operation is built and tested in the engine first, in its own commit. Announced to the models lane before landing — it changes the contract they evaluate. Gap table: `02-module-map.md` §4 L4. | — | Every Track E control has a chat equivalent, each with hard-case eval rows | C2, A6 | `test:engine` + `test:api` + eval rows added |
| **D10** | **B4 — imagery.** Build `check:images` (spec is in `CONTEXT.md`: bad key, missing file, orphan, two recipes one file, oversize) and generate a batch of dishes against `designs/midjourney-dish-photography.md`. | **D2-a** — recapture `designs/screens/*.png` | The gate catches a deliberately broken mapping; N recipes are photographed and the count on Home is derived, not asserted | — | `check:images` |
| **D11** | **B3 — your data is yours.** Profile/plan export + import (a file), so a device-local V1 is not a one-drive product. If the Supabase keys have arrived, this is instead **accounts behind `savedStore.ts`**. | — | You can move your plan to another device without an account | — | `test:api` |
| **D12** | **D2 — the device pass.** Real-phone verification (sub-500px is *unverified* by the headless tool — see lesson 19), a11y sweep, perf budget re-measured cold vs warm, prod vs dev (lesson 29). | — | Every screen is usable on a real phone, with the measurements recorded | D4, B2 | Lighthouse + manual |
| **D13** | **D4 — release.** Docs current (all four + STATUS honesty), OG/PWA/404 checked, gates green, tag `v1`. | — | A stranger can do the §1 walk-through | all | every gate |

**Slack is deliberate.** Days 5, 7 and 9 carry the parallel items that can move (`B5`, `B6`,
`D2-a`); if a main milestone overruns, the parallel item is what gets dropped, never the gate.

---

## 5. Owner-gated decisions, and when each must land

These are not work; they are answers only the owner can give. Each is listed with the day it starts
blocking, so none of them silently becomes the reason V1 slipped.

| # | Decision | Needed by | Default if unanswered |
|---|---|---|---|
| 1 | ~~Which model is behind the assistant in public~~ — **SETTLED 2026-09-19** (`63b6313`): `openai/gpt-oss-20b` on NVIDIA NIM, ~2.8 s, free, and the same model as the 84% baseline. See doc 03 §7 | — | *decided* |
| 2 | **One app or two** — is `/plan` retired, frozen, or kept? | **D8** | Freeze `/plan` (leave it reachable, stop maintaining it), ship `/sage` as the product |
| 3 | **Accounts** — Supabase project URL + anon key | **D11** | Device-local V1 + export/import; accounts land the day the keys do |
| 4 | **Condition-aware generation** — ask or auto-apply | **D8** | ASK (what VISION says) |
| 5 | **`public/week-designs.html`** — document or delete (undecided across three handoffs) | **D13** | Delete: it serves invented dish data from a product whose claim is that its numbers are real |
| 6 | **Retailer products inside V1, or straight after it?** And what the library target number is (§8) | **D5** | Ingredient *identity* in V1; the Lidl-style product layer as the first thing after it. Library target 400 ingredients / 900 recipes |
| 7 | **When you swap one meal, may the app replace your OTHER meals to keep your macros?** Today: yes, and it now always says which ("I bumped your breakfast to X"); "just"/"only" turns it off and it offers instead. The alternative default: never replace unasked — resize only and offer the swap. (Raised 2026-10-03, VISION.md constraint layer 2.) | **D9a** (C4 grows the vocabulary around it) | Keep today's default (it is VISION's written rule), with every replacement named |
| 8 | **The crisis guard: which way to err, and what it should also catch.** (a) Five ordinary food/fitness lines contain a crisis phrase word for word — "killing myself at the gym every day, I need more calories", "I hurt myself at the gym", "I don't want to live on salads anymore", "let's end it all with a big cheat day", "I don't want to be here at this restaurant" — and now get the crisis reply instead of an answer. (b) Seven clinically worrying lines match nothing today, among them eating-disorder signals ("I make myself throw up after every meal", "I'm starving myself on purpose") and hopelessness ("I'm a burden to everyone", "I want to disappear"); a nutrition app will hear the first kind more than most. Both lists: `scripts/models/crisis-phrasings.json`; both asserted AS-IS in `test:engine`. | **D6** (before any public live model) | (a) Keep erring toward safety — a false positive costs an awkward reply, a false negative can cost a life — but consider one line in the crisis reply letting someone who meant food say so. (b) Add an eating-disorder response with its own resources (not the suicide-line text), reviewed by someone qualified before it ships. |

---

## 6. The dependency graph, stated plainly

```
A1 contracts ─► A2 data split ─► A3 executor split ─┬─► A4 payload boundary
                                                    ├─► A5 ingredient ids ─► A6 barrels + folders
                                                    │                     └► A7 maths proven ─► library expansion
                                                    └─► B1 meal logging ─► C3 speaks first
all of Track A (A1–A7) ─► any B / C / E feature work      (owner's ruling, 2026-09-19)
C1 model decision ─► C2 safety + quality ───────────────────────────────► C3
C2 + A6 ─► C4 the vocabulary grows
B2 one app ─► D2 device pass ◄─ A4
everything ─► D4 release
D1 daily history: starts day 1, runs every day, blocks nothing
```

Two edges are worth stating out loud because getting them backwards costs a day each:

- **A3 before B1.** Meal logging writes through the executor. Splitting the executor *after*
  putting a new caller on it means doing the split with a moving target.
- **C2 before any public live model.** The crisis pre-scan is not a feature, it is the condition
  under which a real model is allowed to answer a stranger.

---

## 7. How a day is judged

Borrowed from the standing loop in `WORKPLAN.md` §1, with one addition for this plan:

1. The milestone's **usable-on-its-own bar** is met — not "the code is written".
2. The **gate named in the row is green**. Never push red.
3. It is **committed and pushed** the same day (`git log origin/main..HEAD` empty).
4. The **daily-history entry is written** — what was tackled, how much was solved, what else
   surfaced, and whether that goes on tomorrow or a later day.
5. If the day moved a module boundary, `02-module-map.md` is updated **in the same commit**. A
   module map that lags the code is worse than none, because it is believed.

---

## 8. Expanding the library, and wiring it to real-world products

**Owner's direction**, left as a comment on the schedule board (2026-09-19): *expand the database by
a lot, think about an ingredients database, and whether it can be wired to real-world products such
as Lidl's — keep it in mind for Version 1.*

That is three separate things with three very different costs, so they are separated here.

### What is actually there today (checked, not remembered)

- **501 recipes** standing on **180 curated ingredients** (`nutrientTable.generated.ts`), each with
  a real USDA `fdcId` and a traceable per-100 g row.
- A recipe references an ingredient as **free text**: `{ name: "brown rice", quantity: "80 g" }`.
  There is no id; resolution is a name lookup at derive time.
- **No product, price, pack-size or availability layer exists at all.** `approxCost` is a 1–3
  integer on the recipe, and nothing in the library costs more than 3 — which is why
  `budget: high` currently behaves identically to `medium`.

### (a) Expanding the library — the constraint is ingredients, not recipes

VISION already records this and it bears repeating because it is counter-intuitive: **the binding
constraint on library growth is the ingredient table, not the recipe count.** A new recipe may only
use ingredients already curated to an FDC id, because auto-matching is unsafe — it produced
`salmon fillet → Salmonberries`, and shipping that would mean fabricated nutrition presented as USDA
data.

So "expand by a lot" decomposes into a slow half and a fast half:

1. **Curate more ingredients** — hand-verified, one FDC id at a time. The slow half.
2. **Write recipes over them** — fast, and `check:recipes` already gates plausibility and Atwater.

Which is exactly why **D5 exists and B7 sits beside it**: a helper that *proposes* candidate USDA
matches with their `fdcId` and description for a human to accept or reject, and **never
auto-accepts**. That turns ingredient curation from an afternoon into minutes, and it is the only
thing that makes "a lot" reachable rather than aspirational.

**Set a number, or "a lot" has no gate.** Proposed: **180 → 400 ingredients, 501 → 900 recipes**,
judged by `npm run export:recipes`' Gaps sheet — any diet/slot cell under seven options forces a
week to repeat a dish, so that sheet is the real measure of whether growth bought variety or just
volume. The target itself is the owner's to set.

### (b) The ingredients database — a V1 schema decision, cheap now and expensive later

The ingredient layer exists. What it lacks is **identity**, and the consequences are concrete:

- renaming an ingredient silently breaks every recipe that used the old spelling,
- two spellings are two ingredients, with two nutrition rows,
- and **nothing can hang off an ingredient** — not a price, not a product, not an allergen flag,
  not a substitution rule.

Giving each entry a stable id and having recipes carry it is **D5**. It changes no arithmetic
(deriving still sums per-100 g against the quantity); it only makes the reference explicit. Doing it
before the library doubles is the difference between migrating 501 recipes and migrating 900.

**This is the part that genuinely belongs in V1**, and it is now in the schedule.

### (c) Real retailer products — the honest answer is "immediately after V1", and here is why

A product layer is a **third entity** with rules of its own:

- a product maps to an ingredient **many-to-one** (six own-brand olive oils are one ingredient),
- it carries a **pack size**, and the gap between "buy 500 g" and "the recipe wants 80 g" is
  precisely where meal-prep mode's money claim lives,
- it carries a **price that goes stale**, so it needs a refresh path and a visible "last seen" date,
  or the app starts lying about money — in a product whose whole claim is that its numbers are real,
- and it is **per-store and per-country**, which makes it a user setting, not a constant.

What it buys is real: `approxCost` stops being a 1–3 guess, the grocery list becomes shoppable with
a true total, and the bulk-buy saving in meal-prep mode becomes a measured figure instead of a
model. This is a genuinely good direction.

What it costs is also real: it touches the grocery list, the cost model and the profile.

#### The data source — now researched (2026-10-02), not assumed

**Lidl has no official public API.** Confirmed across the vendor landscape: every "Lidl API" on
offer is a third-party scraper service, which is itself the tell.

The useful finding is that **product data and price data are two different problems with two
different answers**:

| | source | state, measured |
|---|---|---|
| **Products** — barcode, name, brand, nutrition | **Open Food Facts** (ODbL, free, real API) | **Well covered.** Lidl's own-brands are there: Milbona **3,922** products, Italiamo **1,022**, Combino **562**. Barcodes are stable ids — exactly what an ingredient→product mapping needs. |
| **Prices** | **Open Prices** (Open Food Facts' sister project, free API, proof-photo required) | **Thin and clumpy.** 320k prices globally across 125 countries; **578 Lidl stores** in the database, but a 12-store sample gave a **median of 4 prices per store** (mean 59, skewed by two enthusiast-covered stores). Growing — NLnet is funding ML price extraction from shelf photos. |
| **Prices, commercial** | third-party scrapers (Apify, Axesso, ShoppingScraper, Piloterr) | Live and cheap — **$0.90–$2.99 per 1,000 products**, some with free tiers across 10+ EU countries. Fragile, and see the legal note. |

*Method, so it can be re-checked: counts come from the Open Food Facts v2 search API
(`brands_tags=<brand>`) and the Open Prices v1 API (`/stats`, `/locations`, `/prices?location_id=`).
Note that the only working location filter is `location_id` — `location_osm_name` and
`location_osm_brand` are silently ignored and return the unfiltered total, which is how a 320,327
"Lidl prices" figure could be reported by accident.*

**The legal shape matters more than the legality.** With no official API, commercial options are
scraping by another name. EU law gives a database maker a *sui generis* right against extraction of
a substantial part, Germany's Federal Court of Justice reiterated protection against systematic
scraping in a 2025 flight-price case, and the consistent reading is that **a few hundred targeted
lookups are low risk while mirroring an entire catalogue is not.** So "pull the whole Lidl
catalogue nightly" is the shape to avoid; "look up the 200 things this library actually uses" is the
defensible one — which happens to be all we need.

**Revised recommendation, which the research strengthens rather than changes:**

1. **Map ingredients to products on Open Food Facts.** Free, open licence, already covers Lidl's
   own-brands, and barcode-keyed — so it needs the ingredient identity from **D5** and nothing else.
2. **Hand-price the ~200 staples**, each with a visible "priced on" date. Works on day one, needs
   nobody's permission, and is honest about its own staleness.
3. **Then make the user's shopping trip contribute.** The grocery list already has check-offs;
   "tick it off, snap the price tag" feeds a real price into both our data and the Open Prices
   commons. This is the same pattern VISION already applies to photography — *user uploads are the
   upgrade, not the threat* — and it turns the weakest data dependency into an asset that improves
   with use rather than decaying.
4. **A paid scraper stays a later optimisation**, taken only if 1–3 prove insufficient, and scoped
   to targeted lookups rather than a catalogue mirror.

**Recommendation.** V1 ships **(b)**, the identity, and not **(c)**. The product layer becomes the
first post-V1 feature, with a research spike on the data source as its opening task. The reason is
ordering rather than reluctance: with ingredient ids in place, adding products is **additive** and
touches nothing that already works; without them it is a rewrite of the recipe data. If the retailer
link should sit inside V1 itself, the release date moves — that is the trade, and it is the owner's
call (decision 6 in §5).
