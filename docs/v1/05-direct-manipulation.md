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

---

## 9. Build log

Appended as the blocks land, so the plan and the code do not drift apart.

### H1 — the spine · DONE (`55b4e50`)

`previewOperations` in the engine (clone, seeded, returns deltas + moves + the engine's notes);
`preview: true` on `/api/operation`, checked **before** the executor call so a preview has no path
that can commit; the allowlist widened by six tools, each with a comment saying why a control makes
it interpretation-free; and `actions.ts`, the single path every control takes.

**Gate:** `test:engine` 628/0 (unchanged, as this track promised), `tsc` clean, 19 new API tests.

### H2 — the Meal Sheet · DONE (`2e3294b`)

Every meal on the Week board is a button. One panel: portion (clamp disclosed), pin, rate, "why is
this here?", the full recipe, and a chip per ingredient for "no greek yogurt".

Two decisions: the dialog mechanics were **extracted** to `Sheet.tsx` rather than copied from
`RecipeModal` (a second copy is how a third starts), and the sheet's `profile` prop was made
**nullable** rather than taking a fabricated fallback — `tsc` rejected a stand-in profile, and the
right answer was to stop inventing one, not to widen the type.

### H3 — swap, with the trade shown · DONE

`swapCandidates` in the engine and `/api/candidates`. Six alternatives per slot, each with the delta
it would cause, its cook time, how many days it keeps and whether it freezes. **The pool is
`batchCandidates`**, the engine's own filter — so the diet, the allergen and dislike exclusions, the
cook-time and budget limits and the rated-1 bans all apply, and a candidate the executor would
refuse is never offered. Same-day dishes are excluded outright (invariant I4).

> **A measurement that changed the design.** I added a "better fit" badge for candidates closer to
> the slot's macro target, and then measured it: **0 of 12** on a typical slot. Obvious in hindsight —
> the engine already *chose* the best-fitting dish during generation, so by construction almost
> nothing beats it. A badge that never appears reads as "all of these are worse", so the UI now
> explains the situation instead: *what's there is already the closest fit, so these are alternatives
> by preference, and the day gets rebalanced around whichever you pick.* The flag stays in the API
> because it is true information; what changed is the sentence built on it.

### H4 — the macro dial and the reconcile sheet · DONE

- **The dial**: name a protein figure and get *both* ways to reach it, which is what the brief asked
  for. `resizeReaches` answers "can the dish already here get there?" using `SCALE_HI`, the engine's
  own 1.8× ceiling — so when resizing can do it, that is offered first, because the person keeps the
  meal they were going to cook. When it cannot, the panel says what the cap is and lists dishes that
  do reach the number.
- **`ReconcileSheet`**: previews any operation, shows only the days it actually moves, the dish moves,
  and the engine's notes **before** committing, then offers *Apply* / *Apply + rebalance the day* /
  *Cancel*. The rebalance is a **separate operation**, not a hidden part of the first, so it is
  undoable on its own.
- **Day controls** on each column (Balance · New day) route through it.
- **Fix my week** (a `[free]` item, pulled forward): one press, every day short of target rebalanced,
  built from `rebalance_day` rather than a new engine tool. It touches only days that are actually
  off, and **discloses that undo reaches one day back** rather than offering an Undo that quietly
  reverses a seventh of the change.

### Lessons from the build

1. **A failing test is the test's fault first.** A vegan-swap assertion went red and looked like a
   diet violation. The engine had refused correctly and said so — *"I didn't have X — I used Y"* —
   and my assertion was scanning the **whole day** for the dish name on a plan built for
   `diet: "none"`, so it found a chicken dinner that was there before the swap. It now checks the
   target slot. (WORKPLAN lesson 2, met in the wild.)
2. **Lesson 36 applies to `git stash`, not just `rm`.** Checking whether a failure pre-existed, I
   stashed the test file and chained the `pop` after a long test run; the run was backgrounded on
   timeout and the pop never executed, so 19 tests briefly vanished. Cleanup must be its own
   invocation — including when the "cleanup" is restoring your own work.
3. **`tsc` caught a real bug, not a type complaint:** `onClick={loadSwaps}` passed a React
   MouseEvent straight into a `minProtein` parameter. A handler that takes an argument must be
   wrapped, and the compiler is the only thing that would have noticed.

### H5 — drag and drop · DONE

A move is **a pair of swaps built from names captured before either applies**, so execution order
cannot matter, sent as ONE call — which makes it one undo, because the user made one gesture.
`/api/operation` now accepts an `operations` list (every tool in it checked against the allowlist, so
one permitted tool cannot smuggle in a forbidden one), and the drop opens the reconcile sheet.

**Keyboard parity is real, not promised:** `M` picks a plate up and the next press puts it down, the
held plate is announced in the `aria-label` of every slot ("Put X here, in Tuesday lunch"), and a
banner offers "put it back". Touch gets the same two-tap path, because HTML5 drag events do not fire
on a phone.

### H6 — the deviation flow · DONE

"I ate something else" takes free text plus optional calories, "I'm eating out" reserves a typical
meal, and both go through the preview before committing. Measured end to end:

```
BEFORE  Monday: 1999 kcal (target 2000)
  lunch   Chicken Shawarma Bowl   721 kcal
  dinner  Turkey & Bean Chilli    715 kcal

logged "a burger and chips", 900 kcal

AFTER   Monday: 2002 kcal
  lunch   Cheeseburger & Fries    769 kcal
  dinner  Turkey & Bean Chilli    670 kcal
```

> **The engine did something better than asked, and it matters.** The free text matched a real library
> dish, so it used **Cheeseburger & Fries' own macros (769 kcal) rather than the 900 that was typed** —
> correct, because a library match carries protein, carbs, fat and micros where the user supplied only
> calories. The important part is that it **says so** ("Logged Cheeseburger & Fries (769 kcal)…"),
> which the reconcile sheet shows before anything commits. Silently replacing someone's own number
> would be the dishonest version of being right, so there is now a test asserting the disclosure.

**This is the MyFitnessPal answer, in one line of output:** *"I re-solved the rest of Monday: it now
lands at 2002 kcal and 146 g protein."* A tracker would have told you that you were 700 over.

### H7 — speed: the command palette, keyboard, undo · DONE

**`commands.ts` is a pure parser with no model in it**, and that is the point rather than a saving:
"regenerate tuesday" is not ambiguous, so sending it somewhere that might answer *Wednesday* would
be a downgrade dressed as intelligence. It resolves a verb, a day (`today`, `tomorrow`,
`yesterday`, `mon`, `tues`…), a slot and a number from anywhere in the line, **shows the reading
before running it**, and **refuses rather than approximates** when nothing parses — pointing at the
assistant, which is what exists for sentences.

Two real bugs found by testing it against sentences people would actually type:

| input | first attempt | fixed |
|---|---|---|
| `log 2 eggs on toast 320` | **2 kcal**, dish `"eggs toast 320"` | 320 kcal, dish `"eggs toast"` |
| `ate a kebab for dinner yesterday` | dish `"kebab yesterday"` | dish `"kebab"`, on Friday |

The first is the instructive one: taking the *first* number recorded a two-calorie breakfast. A
calorie figure is now the largest value at or above a floor of 50, because a meal is not 2 kcal and
a quantity is rarely in the hundreds. The second taught that `yesterday` is a **common** case for
logging, not an edge one, so it resolves to a day instead of landing in the dish's name.

Also shipped: `Ctrl/⌘ K` and `/` open the palette, `u` undoes, `M` picks a plate up — none of which
fire while focus is in a text field, and `u` does nothing when there is nothing to undo, because a
key that silently does nothing teaches nothing. **The undo toast** reads the engine's own undo state
rather than assuming a change happened.

### H8 — gates, and a measurement that corrected me · DONE

**Gates:** `test:engine` **628/0** (unchanged), `tsc` clean, `test:api` **50/0** with 33 new tests,
`npm run build` **succeeds**.

> **I nearly reported a regression I had not caused.** The build showed `/sage/plan` at **225 kB**
> first-load JS, against the **109 kB** recorded in `CONTEXT.md` — a 116 kB jump, apparently mine. I
> found that `commands.ts` imported `DAYS`/`MEAL_TYPES` as *values* from `types.ts`, which carries
> zod, split them into a zod-free `src/lib/slots.ts`, rebuilt… and the number **did not move**.
>
> So I built the **pre-Track-E commit in a worktree and measured it**: `/sage/plan` was already
> **216 kB**, and **zod was already in the client bundle**. The 109 kB in CONTEXT is a stale figure
> from August, before batch mode. **The entire direct-manipulation layer costs +9 kB** — the meal
> sheet, the swap list with deltas, the macro dial, the reconcile sheet, drag-and-drop, the command
> palette and the undo toast, together.
>
> Three things worth keeping from that detour. **A documented number is evidence of the past, not of
> the present** — CONTEXT's figure was true when written and had quietly rotted, which is the exact
> failure mode the doc rules keep warning about. **A fix that does not move the number was not the
> fix**; `slots.ts` is still correct layering and still prevents a client from reaching zod through
> two constant arrays, but it is a guard, not a repair, and saying otherwise would have been a
> fabricated win. And **the real finding was sitting underneath**: the recipe library genuinely is in
> a client chunk — `Shakshuka`, `Miso-Glazed Cod`, `fdcId` and `approxCost` all grep out of
> `.next/static/chunks/*.js`. That is milestone **A4**, which now carries those four markers as its
> test and 216/212 kB as the baseline to beat.
