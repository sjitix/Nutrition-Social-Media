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
| 3 | **Recipe library + nutrition data** | `recipeDb.ts` (501 in `SEED_RECIPES`, counted), `nutrientTable.generated.ts` (4,106 lines) | Done; growth gated on hand-curated FDC ids | Nothing for V1. Library growth is post-V1 work. |
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

**Two dimensions are missing from the roadmap and are real:** #16 (there are two apps and only one
can be V1) and #19 (the plan is written but never *observed* — nothing records what was eaten, so
Today has to guess and the assistant can never say "you've been 20 g short all week"). Both are in
the schedule.

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

Twelve working days. Each day: one **main** milestone (the day's real work) and one **parallel**
item (small, independent, different module — the thing that keeps two threads moving without two
causes for one failure). Every day ends green and pushed; a day that ends red rolls forward and the
schedule slips by a day rather than pretending.

| Day | Main milestone | Parallel | Usable on its own when… | Depends on | Gate |
|---|---|---|---|---|---|
| **D1** | **A1 — freeze the contracts.** Land `02-module-map.md` as the enforced truth: add `npm run check:boundaries` (a homemade gate in the `check:recipes` family, no new dependency) asserting the layering: no client component imports the engine, no module imports above its layer, only `storage.ts` names a storage key. | **D1-p** — stand up the daily-history log (doc 04) and write day 1 into it | The gate runs, names a violation in plain English, and passes on a clean tree | — | `check:boundaries` + `tsc` |
| **D2** | **A2 — split `recipeDb.ts`, part 1: data out of engine.** `SEED_RECIPES` (≈7.9k lines) moves to `src/lib/recipes/data.ts`; selection + rebalancing stay. A barrel re-exports the existing 24 names so **no call site changes**. | — | `test:engine` is byte-for-byte the same result and no importer was touched | D1 | `test:engine` **628/0**, unchanged count |
| **D3** | **A3 — split part 2: the executor.** `applyOperations` → `src/lib/plan/execute.ts`; batch selection → `src/lib/plan/batch.ts`. Same barrel discipline. | **C1-a** — start the K3 re-run in the background (it takes ~50 min of wall-clock and marinates) | Same suite result; `recipeDb.ts` is under ~2k lines and is *one* idea | D2 | `test:engine` unchanged |
| **D4** | **A4 — the browser payload boundary.** Introduce the card projection (`RecipeCard`: only what a card renders) so Explore stops importing 501 full recipes. | **C1-b** — record the Kimi decision from the scorecard (doc 03) | Explore's first-load JS drops measurably against the 185 kB baseline, with the number recorded | A3 | `npm run build`, first-load JS compared |
| **D5** | **C2 — safety + the three assistant bugs.** The **crisis pre-scan** on the raw message (before the model sees it); ban non-library dish names in replies; strip emoji (project rule); fix fuzzy swap-match ("burger" must not return a shrimp salad). | **B5** — per-batch locks (the batch tail) | A crisis phrasing is caught even when the model would have answered it, proven by a test | C1-b (model chosen) | `test:engine` + new safety tests |
| **D6** | **B1 — meal logging, end to end.** A UI write path for `log_meal`; Today stops inferring "eaten" from the clock and reads the log; `SLOT_HOUR` becomes the fallback, not the truth. | **D1-p** — daily history entry | Today shows what you actually logged, and says so honestly when you have logged nothing | A3 (executor is its own module) | `test:engine` + `test:api` |
| **D7** | **B2 — one app.** Execute the decision on `/plan` (1,819 lines): retire to `/classic`-style archive, or keep and justify. Whatever it is, one app is the product. | **B6** — wire condition-aware generation on the ASK path (VISION says ask) | Every nav path leads into one coherent app; nothing links to a dead screen | Owner decision (§5) | `tsc` + `build` + link crawl |
| **D8** | **C3 — the assistant speaks first.** RULE 3: a standing check produces a suggestion ("Thursday is 40 g short — fix it?") accepted in one tap, on Week and Today. | — | The suggestion is engine-derived, one tap applies it, and it never appears when there is no shortfall | B1, C2 | `test:engine` + a11y check |
| **D9** | **B4 — imagery.** Build `check:images` (spec is in `CONTEXT.md`: bad key, missing file, orphan, two recipes one file, oversize) and generate a batch of dishes against `designs/midjourney-dish-photography.md`. | **D2-a** — recapture `designs/screens/*.png` | The gate catches a deliberately broken mapping; N recipes are photographed and the count on Home is derived, not asserted | — | `check:images` |
| **D10** | **B3 — your data is yours.** Profile/plan export + import (a file), so a device-local V1 is not a one-drive product. If the Supabase keys have arrived, this is instead **accounts behind `savedStore.ts`**. | — | You can move your plan to another device without an account | — | `test:api` |
| **D11** | **D2 — the device pass.** Real-phone verification (sub-500px is *unverified* by the headless tool — see lesson 19), a11y sweep, perf budget re-measured cold vs warm, prod vs dev (lesson 29). | — | Every screen is usable on a real phone, with the measurements recorded | D4, B2 | Lighthouse + manual |
| **D12** | **D4 — release.** Docs current (all four + STATUS honesty), OG/PWA/404 checked, gates green, tag `v1`. | — | A stranger can do the §1 walk-through | all | every gate |

**Slack is deliberate.** Days 5, 7 and 9 carry the parallel items that can move (`B5`, `B6`,
`D2-a`); if a main milestone overruns, the parallel item is what gets dropped, never the gate.

---

## 5. Owner-gated decisions, and when each must land

These are not work; they are answers only the owner can give. Each is listed with the day it starts
blocking, so none of them silently becomes the reason V1 slipped.

| # | Decision | Needed by | Default if unanswered |
|---|---|---|---|
| 1 | **Which model is behind the assistant in public** (see doc 03) | **D4** | Fast free hosted model for the live site; local gpt-oss-20b for dev |
| 2 | **One app or two** — is `/plan` retired, frozen, or kept? | **D7** | Freeze `/plan` (leave it reachable, stop maintaining it), ship `/sage` as the product |
| 3 | **Accounts** — Supabase project URL + anon key | **D10** | Device-local V1 + export/import; accounts land the day the keys do |
| 4 | **Condition-aware generation** — ask or auto-apply | **D7** | ASK (what VISION says) |
| 5 | **`public/week-designs.html`** — document or delete (undecided across three handoffs) | **D12** | Delete: it serves invented dish data from a product whose claim is that its numbers are real |

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
