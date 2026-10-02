# V1 — the dimensions, and the day-by-day schedule

*Deliverable 1 of the planning conversation briefed in `docs/v1-modularization-kickoff.md`.
Written 2026-09-19 against the code as it stands at `125d7b3`, not from memory — every "state"
claim below was checked by reading the file or the import graph, and the method is named where it
matters.*

**Read with:** `02-module-map.md` (the contracts these milestones are built on),
`03-kimi-decision.md` (which model the assistant days assume), `04-daily-history.md` (where each
day's result gets recorded).

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
| 3 | **Recipe library** | `recipeDb.ts` (501 in `SEED_RECIPES`, counted) | 501 recipes built on 182 ingredients | **Owner wants it expanded "by a lot"** — gated on #23, see §8 |
| 3b | **Ingredient data** | `nutrientTable.generated.ts` — **182 entries**, each with a real `fdcId` | Keyed by **name**; recipes reference it as **free text**, no id | **Identity (D5)** — the schema decision that unblocks both expansion and #24 |
| 4 | **Write surface / executor** | `recipeDb.ts` (`applyOperations`), `primitives.ts` (`applyPrimitives`) | Done, adversarially reviewed | Nothing behaviourally; it needs its own module (A3) |
| 5 | **Assistant — agent loop** | `agentLoop.ts`, `agentTools.ts`, `/api/assistant-v2`, `/sage/assistant` | Built + wired + on screen | A model behind it (Track C), and the quality bugs |
| 6 | **Assistant — safety** | `symptoms.ts`, `reply.ts` (`replyOverride`), `recipeDb.ts:9238` | Guard fires **only** if the model routes to `symptom_check` | **Pre-scan of the raw message — a V1 blocker** (C2) |
| 7 | **Import — URL + video** | `import.ts`, `videoImport.ts`, `/api/import` | Done, SSRF-guarded | Nothing. Residual DNS-rebinding is documented, post-V1. |
| 8 | **Explore / feed** | `feed.ts`, `sage/explore/*` | Done, interactive, 495 cards | Payload: the client imports the whole library (A4) |
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
| 20 | **Gates / observability** | `test:engine`, `check:recipes`, `check:data`, `test:api`, `eval:hardcases` | Strong (628/0 claimed at handoff) | `check:boundaries` (A1), `check:images` (B4), an eval **scorecard file** (C1) |
| 21 | **Deployment** | Vercel + GitHub Pages | Both live | Release pass (D4) |
| 22 | **Work record** | *nothing* | Sessions are reconstructed from `CONTEXT.md` | The daily history (D1 / doc 04) |
| 23 | **Library growth capacity** | the 182-entry ingredient table + `npm run build:nutrients` | Each new ingredient needs a **hand-curated FDC id**; auto-matching is banned | A curation helper (B7, D5) so the rate isn't an afternoon per ingredient |
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

**The relationship rule between tracks:** A changes *where code lives* and must not change what it
does (gate: `test:engine` identical before and after). B and C change *what it does* and must not
move files. Never run an A-day and a B/C-day against the same module on the same day — a red gate
then has two candidate causes, which is exactly the trap lesson 2 and lesson 44 both describe.

---

## 4. The schedule

Thirteen working days — twelve, plus **D5**, added when the owner asked for the library to grow a
lot (§8). Each day: one **main** milestone (the day's real work) and one **parallel**
item (small, independent, different module — the thing that keeps two threads moving without two
causes for one failure). Every day ends green and pushed; a day that ends red rolls forward and the
schedule slips by a day rather than pretending.

| Day | Main milestone | Parallel | Usable on its own when… | Depends on | Gate |
|---|---|---|---|---|---|
| **D1** | **A1 — freeze the contracts.** Land `02-module-map.md` as the enforced truth: add `npm run check:boundaries` (a homemade gate in the `check:recipes` family, no new dependency) asserting the layering: no client component imports the engine, no module imports above its layer, only `storage.ts` names a storage key. | **D1-p** — stand up the daily-history log (doc 04) and write day 1 into it | The gate runs, names a violation in plain English, and passes on a clean tree | — | `check:boundaries` + `tsc` |
| **D2** | **A2 — split `recipeDb.ts`, part 1: data out of engine.** `SEED_RECIPES` (≈7.9k lines) moves to `src/lib/recipes/data.ts`; selection + rebalancing stay. A barrel re-exports the existing 24 names so **no call site changes**. | — | `test:engine` is byte-for-byte the same result and no importer was touched | D1 | `test:engine` **628/0**, unchanged count |
| **D3** | **A3 — split part 2: the executor.** `applyOperations` → `src/lib/plan/execute.ts`; batch selection → `src/lib/plan/batch.ts`. Same barrel discipline. | **C1-a** — start the K3 re-run in the background (it takes ~50 min of wall-clock and marinates) | Same suite result; `recipeDb.ts` is under ~2k lines and is *one* idea | D2 | `test:engine` unchanged |
| **D4** | **A4 — the browser payload boundary.** Introduce the card projection (`RecipeCard`: only what a card renders) so Explore stops importing 501 full recipes. | **C1-b** — record the Kimi decision from the scorecard (doc 03) | Explore's first-load JS drops measurably against the 185 kB baseline, with the number recorded | A3 | `npm run build`, first-load JS compared |
| **D5** | **A5 — ingredients become a first-class entity.** The 182 curated ingredients are keyed by *name* and every recipe references them as **free text**. Give each a stable id, have recipes carry that id, and add `check:ingredients` asserting every one of the ~3,000 recipe ingredient references resolves to a real FDC-backed entry. Nutrition maths is unchanged — this is identity, not arithmetic. | **B7** — a curation helper that *proposes* USDA matches for a new ingredient for a human to confirm. Never auto-accepts: `salmon fillet → Salmonberries` is why. | Every recipe resolves to ids with zero unmatched, and adding an ingredient is a minutes-long job instead of an afternoon | D3 | `check:ingredients` + `test:engine` unchanged |
| **D6** | **C2 — safety + the three assistant bugs.** The **crisis pre-scan** on the raw message (before the model sees it); ban non-library dish names in replies; strip emoji (project rule); fix fuzzy swap-match ("burger" must not return a shrimp salad). | **B5** — per-batch locks (the batch tail) | A crisis phrasing is caught even when the model would have answered it, proven by a test | C1-b (model chosen) | `test:engine` + new safety tests |
| **D7** | **B1 — meal logging, end to end.** A UI write path for `log_meal`; Today stops inferring "eaten" from the clock and reads the log; `SLOT_HOUR` becomes the fallback, not the truth. | **D1-p** — daily history entry | Today shows what you actually logged, and says so honestly when you have logged nothing | A3 (executor is its own module) | `test:engine` + `test:api` |
| **D8** | **B2 — one app.** Execute the decision on `/plan` (1,819 lines): retire to `/classic`-style archive, or keep and justify. Whatever it is, one app is the product. | **B6** — wire condition-aware generation on the ASK path (VISION says ask) | Every nav path leads into one coherent app; nothing links to a dead screen | Owner decision (§5) | `tsc` + `build` + link crawl |
| **D9** | **C3 — the assistant speaks first.** RULE 3: a standing check produces a suggestion ("Thursday is 40 g short — fix it?") accepted in one tap, on Week and Today. | — | The suggestion is engine-derived, one tap applies it, and it never appears when there is no shortfall | B1, C2 | `test:engine` + a11y check |
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

---

## 6. The dependency graph, stated plainly

```
A1 contracts ─► A2 data split ─► A3 executor split ─┬─► A4 payload boundary
                                                    └─► B1 meal logging ─► C3 speaks first
C1 model decision ─► C2 safety + quality ───────────────────────────────► C3
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

- **501 recipes** standing on **182 curated ingredients** (`nutrientTable.generated.ts`), each with
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

**Set a number, or "a lot" has no gate.** Proposed: **182 → 400 ingredients, 501 → 900 recipes**,
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
