# Track E — direct manipulation: the app as a nutritionist you operate with your hands

*An 8-hour working plan, written 2026-10-02. Every decision in it is taken, not asked.*

**The owner's brief, in their words:** automated features rather than a chatbot — *"buttons you can
press that are very convenient"*: regenerate meals, tap a meal and change it ("more protein" → give
a number → it adapts the recipe or offers alternatives), replace a meal, drag and drop meals between
days with everything recalculated, a popup that says how the day changed and offers to fix it, and
a way to log the thing you actually ate when life happened. Inspirations: **Notion** (and Notion
Calendar's swap-anything directness) and **MyFitnessPal**, which is the competition to beat on
convenience.

---

## 1. The thesis, in one sentence

> **MyFitnessPal is a logging app: you tell it what you ate and it tells you a number you feel bad
> about. NutriFlow is a planning app: it tells you what to eat, and when you deviate it fixes the
> rest of the plan around you.**

Everything below is in service of that sentence. The competitive claim is not "we also track
calories" — it is **"every deviation is one tap, and the plan re-solves itself."** MFP cannot do
that, because it has no plan and no solver. We have both, already built and tested.

The second claim is speed. MFP's core loop is search → pick → portion → confirm, per item, by
typing. Ours should be **one tap from the thing you are looking at**, with a keyboard path for
everyone who prefers it.

---

## 2. Why eight hours is enough: almost all of this already exists

This track is **a UI surface over tested engine operations**, not new engine work. Verified in the
code today:

| What the brief asks for | What already exists |
|---|---|
| Regenerate a meal/day/week | `regenerate_week`, `regenerate_day` in `applyOperations` |
| Replace a specific meal | `swap_meal` — takes an exact dish name |
| "More protein, 45 g" | `targetProtein` on the operation; `rebalanceDay`'s two levers (portion scaling, then protein re-selection) already hold a day on target |
| Resize a portion | `scale_portions`, clamped to a realistic 0.6–1.8× and it says when it clamps |
| Recalculate after a change | `rebalance_day` / `rebalanceWeek` — the whole macro-preservation engine |
| **A popup showing how the day changed, before committing** | **`whatIf` in `agentTools.ts`** — clones the plan, simulates, and returns `notes` plus per-day `deltaCalories` / `deltaProtein` and which meals changed. Seeded, so a preview is reproducible. |
| "I ate something else" | `log_meal` (re-solves the REST of that day) and `eating_out` (reserves calories, lightens the rest) |
| "No onions tonight" | `substitute_ingredient` — returns safe swaps *and* the macro cost |
| Pin / rate a meal | `lock_meal`, `unlock_meal`, `rate_meal` (ratings already steer selection) |
| Undo | one-level undo with a snapshot taken before the first write of a turn |
| **A no-model endpoint for button presses** | **`/api/operation` already exists for exactly this.** Its own header: *"A button press already carries its intent — routing it through an LLM is slower, costs a model call, and can be wrong."* |
| Changes appearing on every screen | `PLAN_CHANGED_EVENT` in `myPlan.ts` — screens re-read in place, no reload |
| An accessible modal pattern | `RecipeModal` — real `role="dialog"`, Escape, focus trap, focus return, scroll lock |

**So the work is: widen what the no-model route allows, add a preview mode, and build the surfaces.**
The engine is the part that would have taken weeks, and it is done.

---

## 3. Decisions taken (no questions asked)

| # | Decision | Why |
|---|---|---|
| E1 | **Every write goes through `/api/operation`. The browser never imports the engine.** | The engine carries 501 recipes; importing it client-side is the Explore payload bug (module map §6). The route exists and is tested. |
| E2 | **Widen the route's `ALLOWED` set** to `swap_meal`, `regenerate_day`, `log_meal`, `eating_out`, `substitute_ingredient`, `rebalance_day`. | The route's own test is "anything that needs the model to INTERPRET a sentence goes to the assistant." **A dish picked from a list is not an interpretation** — the UI supplies the parameters the model would have had to guess. That is the whole argument for this track. |
| E3 | **Add `preview: true` to `/api/operation`**, returning `whatIf`'s shape without committing. | This powers every confirm-before-commit popup, and reuses tested code instead of writing a second simulator that would drift. |
| E4 | **One surface: the Meal Sheet.** Tap any meal, anywhere, and every action for that meal is in one panel. | Notion's model is "select a thing, see what you can do to it". The alternative — a scatter of buttons on every card — is what makes apps feel cluttered. |
| E5 | **Optimistic UI, engine truth.** Show the change instantly; reconcile with the response; **the engine's numbers always win and are re-read from it, never computed in the browser.** | The two-layer rule. A number the browser calculated is a number that can disagree with the plan. |
| E6 | **Every plan-changing action raises an Undo toast** wired to the engine's `undo`. | Direct manipulation without undo is a dare, not a feature. It also makes experimenting cheap, which is most of why Notion feels good. |
| E7 | **Drag and drop with native HTML5 DnD + a pointer-events fallback for touch. No library.** | No new dependency, CSP-clean, and the repo has no DnD dep today. |
| E8 | **Keyboard parity for every mouse action.** | The efficiency claim has to be true for the people who care about it most. |
| E9 | **Build on `/sage` only. `/plan` is not touched.** | Decision 2 in the V1 plan defaults to freezing `/plan`; doing this work twice would be the waste that decision exists to prevent. |
| E10 | **Reduce C3 ("the assistant speaks first") rather than adding a day.** | Most of RULE 3's value — "Thursday is 40 g short, fix it?" — is delivered here as a one-tap chip with no model at all. What remains for C3 is genuinely conversational, and it shrinks. |

---

## 4. The eight hours

Each block ends with something usable. The gate at the end of each is the standing one: `tsc` plus
`npm run test:api` for route work, `npm run test:engine` if anything under `src/lib` moves, and a
commit **pushed** before the next block starts.

### H1 · 0:00–1:00 — the spine
- Widen `ALLOWED` (E2) with a comment per tool saying *why the UI makes it interpretation-free*.
- Add `preview: true` (E3): clone, simulate via the same executor, return `notes` + deltas + changed
  meals. Never commits.
- `src/app/sage/actions.ts` — one typed client for the whole layer: `runOp`, `previewOp`, optimistic
  state, `PLAN_CHANGED_EVENT`, error surfacing. Every surface below calls this and nothing else.
- **Usable when:** a scripted `curl` can preview a swap and then commit it, and the preview's numbers
  match what committing produces.
- **Gate:** `test:api` extended — one test per newly allowed tool, plus one asserting **preview
  does not mutate** (the whole point).

### H2 · 1:00–2:00 — the Meal Sheet
Tap a meal on Week or Today → an accessible panel (RecipeModal's discipline: Escape, focus trap,
focus return). It shows the dish, its real macros, its cook time, and the actions. Wire the cheap
ones first, each live:
- **Lock / unlock** (pin — survives every regenerate)
- **Rate ★1–5** (feeds selection)
- **Portion stepper** 0.5×…2× with live totals, and when the engine clamps to 0.6–1.8× **the sheet
  says so in the engine's words**
- **Why is this here?** → `explain_meal`
- **Full recipe** → the existing modal content
- **Usable when:** you can pin, rate and resize any meal from any screen, and the week's figures move.

### H3 · 2:00–3:15 — swap, with the trade shown
- **Swap** → six alternatives that fit the slot, respecting diet, allergies, dislikes and cook time,
  each row showing **the delta it would cause**: `+8 g protein · −40 kcal · 15 min`.
- Sorted by fit to the slot's macro target; "surprise me" reshuffles.
- **Usable when:** swapping from the list lands the dish and the day stays on target, with the
  engine's note shown if it had to rebalance something.

### H4 · 3:15–4:30 — the macro dial and the reconcile sheet
- **"I want more protein here"** → a number input (and ±5 g steppers). The engine decides *how*:
  rescale the portion, or re-select a higher-protein dish for the slot. **The sheet reports which it
  did**, because those are different things to a cook.
- **The reconcile sheet** (the brief's popup), powered by `preview`:
  - what each meal and each day total *would* become, with deltas,
  - three choices: **Keep as is** · **Rebalance the day** · **Cancel**,
  - and the engine's own notes, including anything it would refuse or relax.
- **Usable when:** no plan-changing action commits without the option to see its consequence first,
  and the committed result equals the preview.

### H5 · 4:30–5:30 — drag and drop
- Drag a meal to another slot or day. While dragging, an **impact bar** shows both affected days'
  calorie and protein deltas live.
- On drop: the reconcile sheet (H4) — the same one, not a second implementation.
- Touch supported via pointer events; keyboard equivalent: select, then `[` / `]` to move day, `↑`/`↓`
  for slot.
- **Usable when:** a meal can be moved by mouse, finger or keyboard, and both days re-solve.

### H6 · 5:30–6:30 — the deviation flow (the MyFitnessPal answer)
- **"I ate something else"** on any meal:
  - search the 501-recipe library (instant, it is already indexed for Explore), **or**
  - free text + calories when it is not in the library — and if the user does not know the calories,
    `eating_out` reserves a typical restaurant main **and says that it estimated**.
- Then the move MFP cannot make: **"Re-solve the rest of today"** — one tap, the remaining meals
  adjust so the day still lands on target, and if it cannot reach target it says **by how much it
  missed**.
- **Usable when:** logging a 900-kcal burger for lunch visibly lightens the rest of the day, honestly.

### H7 · 6:30–7:15 — speed and the standing coach
- **Command palette** (`⌘K` / `Ctrl K`, and `/` on Week): `swap lunch`, `protein 180`,
  `log burger 650`, `regenerate tue`, `lighter dinner`, `undo`. Parsed deterministically against the
  operation vocabulary — **no model**, so it works offline and cannot misread you.
- **Keyboard map:** `j`/`k` move between meals, `s` swap, `p` portion, `l` lock, `r` regenerate day,
  `u` undo, `?` shows the map.
- **Fix chips** — the engine already computes shortfalls, so Week and Today carry
  *"Thursday is 40 g short on protein → Fix"* as a one-tap action. This is VISION RULE 3 with no
  model in it.
- **Undo toast** after every change (E6).

### H8 · 7:15–8:00 — close it out properly
`npm run test:engine` (if `src/lib` moved) · `test:api` · `tsc` · `npm run build` · a real phone
check of the sheet and the drag. Then the documents: `CLAUDE.md` (the new route surface),
`CONTEXT.md`, the module map if a boundary moved, `docs/worklog/2026-10-02.md`, and the schedule
board. Commit and push each step as it lands, not in a batch at the end.

**If a block overruns, this is the drop order** (slack first, never the gate): the command palette
(H7) → drag and drop (H5, the keyboard move still covers the need) → "surprise me" (H3). **H1, H4
and H6 are the spine and do not get dropped** — they are the preview contract and the competitive
claim.

**If a block finishes early, pull forward from the `[free]` list in §5, in this order** — each is a
control over an engine capability that already exists and is tested, so each is minutes rather than
hours:

1. **Fix my week** (one button, whole week rebalanced) — biggest effect per line of code.
2. **Shopping-list diff** — pure function over two grocery lists; turns a silent rebuild into an
   answer.
3. **Skip this meal** and **"I have 20 minutes tonight"** — the two most common real-life frictions.
4. **Weekly review card** and **hydration widget** — both already allowed by the route.
5. **Keeps / freezes badges** — two exported predicates, read straight onto the card.
6. **Nutrient spotlight with one-tap fixes** — the clearest "this app is a nutritionist" moment.
7. **Compare two options** — one extra preview call, no competitor has it.

---

## 5. The feature inventory

**[8h]** ships in this plan. **[free]** means the engine already does it and the only missing piece
is a control — these are the first things to pull forward whenever a block finishes early, in the
order listed. **[next]** is named so it does not get re-invented badly later.

### On a meal — tap it

| | |
|---|---|
| **[8h]** | **Swap**, six alternatives, each showing the delta it causes (`+8 g protein · −40 kcal · 15 min`) |
| **[8h]** | **Macro dial** — "this meal, 45 g protein"; the engine rescales or re-selects and says which |
| **[8h]** | **Portion** 0.5×…2×, live totals, clamp disclosed |
| **[8h]** | **Lock** (survives every regenerate) · **Rate ★** (steers future selection) |
| **[8h]** | **I ate something else** → the deviation flow |
| **[8h]** | **No ⟨ingredient⟩ tonight** → safe swaps with the macro cost |
| **[8h]** | **Why is this here?** · **Full recipe** |
| **[free]** | **Skip this meal** → its calories redistribute across the day, or don't — you pick |
| **[free]** | **Keeps / freezes badges** — `keepDays` and `freezesWell` are already exported; a dish that holds three days or freezes well should say so on its face |
| **[free]** | **Cook once, eat twice** — "make this tomorrow's lunch too", on the batch machinery |
| **[next]** | "More like this" · leftovers-aware swaps · per-meal cook-time filter |

### On a day

| | |
|---|---|
| **[8h]** | **Regenerate** · **Rebalance** ("make today add up") · **Eating out** (reserve + lighten the rest) |
| **[8h]** | **Fix chips** — "Thursday is 40 g short → Fix", one tap |
| **[free]** | **"I have 20 minutes tonight"** — a cook-time cap on the day; `maxCookTime` already filters selection |
| **[free]** | **"I'm starving" / "not hungry"** — a day-level portion nudge in one tap, clamped and disclosed |
| **[next]** | Copy a day · save a day as a template · rest-day targets (lower activity for one day) · cheat day |

### On the week

| | |
|---|---|
| **[8h]** | **Drag and drop** between slots and days, with a live impact bar |
| **[8h]** | **Undo** on every change |
| **[free]** | **Fix my week** — one button, rebalances every day and reports what it actually fixed |
| **[free]** | **Shopping-list diff** — "since you changed Tuesday: +2 avocados, −1 salmon fillet" instead of a silently rebuilt list. High value, pure function over two weeks' groceries |
| **[free]** | **Shift my week** — travelling Thursday? push the plan forward a day |
| **[next]** | Multi-select days → bulk regenerate · duplicate last week · week templates · "make this week cheaper" (needs the price layer) |

### Speed

| | |
|---|---|
| **[8h]** | **Command palette** (`⌘K`, `/`) — `swap lunch`, `protein 180`, `log burger 650`, `regenerate tue`, `undo`. Parsed deterministically; no model, works offline, cannot misread you |
| **[8h]** | **Keyboard map** — `j`/`k` meals, `s` swap, `p` portion, `l` lock, `r` regenerate, `u` undo, `?` help |
| **[free]** | **Today quick-row** — the three most likely actions on the next meal, without opening anything |
| **[next]** | Recent actions · swipe gestures · bulk select meals → one action on all |

### The standing coach — all of it without a model

| | |
|---|---|
| **[8h]** | **Fix chips** (above) — this is VISION's RULE 3, delivered by arithmetic |
| **[free]** | **Weekly review card** — `weeklyReportNote` already computes averages and nutrient gaps, and the route already allows it |
| **[free]** | **Nutrient spotlight** — "iron is at 60% of reference" with **three one-tap swaps that fix it**, via `boostNutrient` |
| **[free]** | **Hydration widget** — tap a glass; `hydrationTarget` is computed from body weight and already allowed |
| **[free]** | **What changed** — a short per-day history of applied operations, from the engine's own notes. Answers "why does Tuesday look different?" without guessing |
| **[next]** | Adherence streak (`streak.ts`) · fridge mode (`guaranteeFridge`) · "explain my whole week" |

### Two that are worth calling out as differentiators

- **Compare before committing.** `preview` is cheap and pure, so two options can be simulated side by
  side: *"A — swap to the salmon: +8 g protein, −40 kcal"* against *"B — resize this: +6 g protein,
  +90 kcal"*. Choosing between two honest consequences is a thing no competitor offers, and it costs
  one extra preview call. **[free]**
- **Everything is reversible, visibly.** Undo on every action, plus the "what changed" history, means
  a user can poke at the plan without fear. That — not any single feature — is what makes Notion feel
  good to use, and it is the quality we are actually copying.

### Against MyFitnessPal, point by point

| Their friction | Our answer |
|---|---|
| You type every item in | You start from a plan; typing is the exception, not the loop |
| It judges the day and leaves you with it | **It re-solves the rest of the day** |
| Barcode scanning is the headline feature | The plan already knows the dish, so there is nothing to scan |
| No notion of a week | The week is the unit, and a change propagates across it |
| Macro targets are a scoreboard | Macro targets are a **constraint the solver holds for you** |
| Changing your mind means re-entering data | Drag it, or tap once, and everything recalculates |
| Micronutrients are a paywalled afterthought | Nine micros are computed from ingredients, and the spotlight offers one-tap fixes |

### Against MyFitnessPal, point by point

| Their friction | Our answer |
|---|---|
| You type every item in | You start from a plan; typing is the exception, not the loop |
| It judges the day and leaves you with it | **It re-solves the rest of the day** |
| Barcode scanning is the headline feature | The plan already knows the dish, so there is nothing to scan |
| No notion of a week | The week is the unit, and a change propagates across it |
| Macro targets are a scoreboard | Macro targets are a **constraint the solver holds for you** |
| Changing your mind means re-entering data | Drag it, or tap once, and everything recalculates |

---

## 6. Honesty rules for this layer

The engine's honesty discipline does not weaken because a button triggered it instead of a sentence:

1. **No number on screen that the engine did not compute.** Deltas come from `preview`, totals from
   the committed response.
2. **A preview is labelled a preview**, and the committed figures are re-read from the response — a
   seeded simulation and a live commit can differ, and the commit is the truth.
3. **When the engine clamps, relaxes or refuses, the sheet shows its note** — "I can't resize that
   past 1.8×", "no compliant dish under 20 minutes, so I relaxed the cook time".
4. **A re-solve that misses says by how much.** "Still 12 g under on protein" beats a green tick.
5. **Hard rules stay hard.** No button may produce an allergen or break a diet — the invariants
   (I1–I8) hold whatever the UI does, and the fuzzer keeps proving it.

---

## 7. Not doing this in eight hours, deliberately

Accounts and sync (owner-gated), the price layer (needs the ingredient identity from D5), anything
needing a model, the workout vertical, and **`/plan`**. Also not touching `recipeDb.ts`'s internals:
this track adds no engine behaviour, which is exactly why it is safe to do in a day — and it means
`npm run test:engine` should come back with **the same 628** at the end.
