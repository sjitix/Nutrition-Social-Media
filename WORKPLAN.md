# NutriFlow — Strict Work Plan

> **Status:** living document. I follow this top-to-bottom. A phase is not "done" until its
> **exit criteria** pass and the work is **pushed to git**.
> **VISION.md** = what we're building and why. **CLAUDE.md** = how the repo works.
> **This file** = the ordered list of what gets built, how it gets tested, and in what order.

---

## RESUME HERE (last updated: 2026-07-10)

`main` is green: `npm run test:engine` 241 passed / 0 failed, fuzz clean, plus `npm run
check:recipes` and `npm run check:data`.

**v7 is trained, converted, loaded, and is the production model.** It is the first model whose
labels contained `age/heightCm/weightKg/sex/activity/goal/loggedCalories/estimatedCalories/
ingredient/symptom`, and the first trained on all 1030 examples (0 skipped).

```bash
~/.lmstudio/bin/lms.exe load nutriflow-assistant-v7 --gpu max --context-length 8192 --identifier nutriflow-v7 -y
ENFORCE=1 MODEL=nutriflow-v7 npm run eval:assistant   # the production path
MODEL=nutriflow-v7 npm run eval:assistant             # unconstrained stress test
```

### The scoreboard was measuring memory, not skill

24 of the 56 eval cases were **verbatim training strings** — "i'm always tired", "make it better",
"i need more b12", "what can you do". Another 13 differed from a training string by exactly the
field under test. 66% of the eval was contaminated, and **every score from v4 to v7 was partly a
recall score.** The eval cases now live in `data/eval-cases.json`; the 24 verbatim ones were
rewritten to held-out phrasings; `check:data` fails if a training message ever equals an eval
message again, and `gen-synthetic.mjs` drops (and names) any example that collides.

Re-measured on the honest set, the model comparison did not shrink — **it grew**. v6 had memorized
the same strings, so the contamination was hiding v7's real advantage.

| enforced (`ENFORCE=1`, the production path) | v5 | v6 | **v7** |
|---|---|---|---|
| validJson / schemaOk | 100% | 100% | **100%** |
| noHallucination | 100% | 100% | **100%** |
| **toolAccuracy** | — | 84% | **95%** |
| **fieldAccuracy** | — | 79% | **93%** |
| clarify/answer | — | 8/10 | **8/10** |

*(v5's honest numbers were never taken; its old contaminated row read 82% / 86% / 9-10. The v6 and
v7 rows above are on the held-out set and are the only two directly comparable numbers here.)*

v7 unconstrained scores **higher** than enforced — 98% tool / 95% field / 9-10 clarify. JSON-schema
enforcement costs this model a little accuracy rather than buying it any; worth revisiting whether
the app still needs it now that the fine-tune emits the envelope natively.

### What v7 still gets wrong (all three are "read the sentence" failures)

1. `i ate pizza for lunch on monday` -> answers **breakfast**. Training contains "i ate pizza for
   breakfast on Monday". It matches the dish and the day and stops reading. Two generated examples
   ("Friday breakfast is at a work dinner") had actively taught it that the meal word is noise;
   those are gone and `check:data` now rejects any message naming a meal it isn't about.
2. `i'm out for dinner tuesday, probably 1000 calories` -> drops `estimatedCalories`. All 26
   training examples carrying a number label it correctly, but the closest phrasing it memorized
   ("i'm going out for dinner on friday") has no number.
3. `i feel worn out every afternoon` -> `weekly_report`, not `symptom_check`.

The fix for all three is **minimal pairs in the training data**: same dish, same day, different
slot; same outing, with and without a calorie estimate; more fatigue phrasings. Queued for v8.

**The assistant's 13 tools:** `update_profile`, `regenerate_week`, `regenerate_day`, `swap_meal`,
`compute_targets`, `log_meal`, `weekly_report`, `eating_out`, `explain_meal`,
`substitute_ingredient`, `symptom_check`, `lock_meal`, `unlock_meal`.

**Next, in order:** `rate_meal` -> hydration (needs `UserProfile.weightKg`, which `compute_targets`
should persist) -> `scale_portions` -> `undo`. Adding a tool stales the model, so build all four,
add the v8 minimal-pair data, then train **once**.

---

## 0. The aim (never lose sight of this)

Build an AI that **replaces a nutritionist *and* a knowledgeable health coach**. The user talks
in plain language; the AI understands, decides, and the plan **actually changes correctly**.

It must feel like a **genuine convenience**, not a toy: it should absorb real life (you ate a
burger, you're travelling, the spinach is about to turn, you're exhausted) and quietly keep you
on track.

### The one architectural rule

> **The LLM decides *what* to do. Deterministic code guarantees *that it is correct*.**

- **Intent layer (LLM):** understands the conversation, infers unstated constraints, picks a
  tool and its arguments, decides whether to ask a clarifying question. Flexible. Fine-tuned.
- **Correctness layer (code):** macros, nutrients, portions, safety. Never guesses. **The model
  does no arithmetic, ever.**

Every new capability is therefore: **a tool the LLM may choose** + **an engine that executes it
reliably**. Never a keyword trigger, never an if-else chatbot.

### The second rule: almost everything is the same primitive

`log_meal`, `eating_out`, `substitute_ingredient`, `scale_portions` are **not new engines**.
They are new *entry points* into the solver we already have:
**"re-solve the remainder of the plan under the constraints that are now true."**

### The third rule: honesty over silence

If the engine substitutes a dish, relaxes a limit, changes another meal, or *cannot* satisfy a
request — **it says so.** A silent wrong answer is worse than a refusal. Impossible constraint
sets get an explanation and a proposed trade-off, never a quietly broken plan.

---

## 1. Standing loop (applies to EVERY task, no exceptions)

```
build  →  typecheck  →  test from the USER's perspective  →  adversarial / edge cases
      →  invariants + fuzz  →  green?  →  commit + push  →  next task
```

**Rules I hold myself to:**
1. **Never push red.** If a test fails, fix it or revert; do not "temporarily" disable it.
2. **Never weaken a test to make it pass.** If a test is wrong, fix the *test* and say so
   explicitly. If the code is wrong, fix the *code*.
3. **Test as a user, not as a programmer.** Tests are phrased as real utterances
   ("*I'm allergic to peanuts*" → "*swap lunch for the Thai peanut bowl*").
4. **Adversarial by default.** Every feature gets: a contradiction test, an impossible-request
   test, an unknown-input test, and a "does it violate a hard rule?" test.
5. **Hard rules are inviolable:** diet, allergies, exclusions. Everything else (cook time,
   budget, ingredient count) is a *preference* that may be relaxed **only with disclosure**.
6. **Report honestly** at each milestone: what passed, what broke, what I changed.
7. **The GPU training run is never interrupted** by this work.

---

## 2. Test architecture (`npm run test:engine`)

Three layers, in `scripts/test-engine.mts`:

| Layer | Purpose |
|---|---|
| **Scenarios** | User-perspective behaviours ("swap breakfast but keep me lean") |
| **Adversarial** | Contradictions, allergies vs requests, unknown dishes, idempotence, ordering |
| **Invariants + Fuzz** | Random operation sequences; properties asserted after **every** op |

### The invariants (must hold after ANY operation, forever)

| id | property |
|---|---|
| `I1` | Diet never violated (per-day overrides respected) |
| `I2` | Allergen / excluded ingredient never present — **inviolable** |
| `I3` | Every day has exactly `mealsPerDay` meals (never silently drop a meal) |
| `I4` | No duplicate dish within a day |
| `I5` | Day calories on target unless `preserveMacros:false` (or physically unreachable) |
| `I6` | Portion scale stays within realistic bounds (0.6–1.8×) |
| `I7` | Cook-time limit respected — relaxed only when **no** compliant recipe exists, and disclosed |
| `I8` | Per-day overrides never persist into the saved profile |

> The fuzzer exists to **break** the engine, not to flatter it. It has already found three real
> bugs (silent meal-drop, swaps ignoring cook time, silent dish substitution).

---

## 3. Phases

Order chosen deliberately. Safety is **deferred to the end at the owner's explicit direction** —
he wants to see the AI be *rational and coherent* first. (Existing allergy/exclusion invariants
stay in force regardless; removing them would be a regression.)

### ✅ Phase 0 — Testing as a first-class asset
- [x] Move suite into repo → `scripts/test-engine.mts`, `npm run test:engine`
- [x] Invariants `I1`–`I8` + fuzzer over random op sequences
- [x] Fix bugs the fuzzer found: silent meal-drop, swap ignoring cook time, silent substitution,
      calorie weight losing to carbs/fat/fiber
- **Exit:** suite green, fuzz clean, pushed.

### Phase 2 — Micronutrient engine (USDA FoodData Central) ← *owner chose option (a)*
The foundation for every health skill. VISION already predicted it: **same solver, more axes.**
- [x] Download **USDA FoodData Central SR Legacy** bulk CSV (public domain, 7,793 generic foods).
- [x] Scope: **132 recipes, 174 distinct ingredients**. Units: `g` (305), *none* (84), `tbsp` (62),
      `tsp` (26), `piece`, `can`, `scoop`, `clove`, `slice`.

> **⚠️ Finding: auto-matching ingredients to USDA is UNSAFE and must not be shipped.**
> Naive token-overlap gave `salmon fillet → "Vegetarian fillets"`, `eggs → "Eggs, scrambled,
> frozen mixture"`, `brown rice → "Rice flour, brown"`, `greek yogurt → "Yogurt, Greek,
> **strawberry**"`. Even after tuning the ranker, `eggs` still returns fish roe and
> `salmon fillet` returns *Salmonberries*. Shipping that would mean **fabricated nutrition
> presented as USDA data** — exactly the hallucination this engine exists to prevent.

**Therefore:**
- `scripts/usda-search.mjs` surfaces **candidates for human review**; its top-1 is never trusted.
- `ingredient → fdc_id` is **hand-curated and committed**, so every nutrient value is traceable
  to a real FDC record.
- **Automatic accuracy gate:** each recipe already carries hand-authored macros. Recomputing its
  macros from the mapped ingredients + gram conversions must land close to them. Large divergence
  = a bad mapping or a bad unit conversion. This validates all 174 mappings without eyeballing them.
- Unmapped ingredients must **not** silently contribute zero; coverage is reported, and micros are
  only exposed once coverage is high.
- Unit → grams uses a curated, versioned table (`scripts/food-units.json`).

**Status:** `npm run build:nutrients` → **175/175 ingredients resolved, 132/132 recipes covered.**
The `--audit` trail confirms the curation: `brown rice → Rice, brown, long-grain, raw (367 kcal/100g)`,
`chicken breast → skinless boneless raw (120)`, `eggs → Egg, whole, raw, fresh (143)`,
`olive oil → 884`, `oats → dry (379)`. The gate caught a real 3× error (`red lentils` are used **dry**
— no "cooked" marker — while `lentils`/`green lentils` say "150 g cooked").

> **⚠️ Finding: recipe ingredient lists are simplified, not complete formulations.**
> Each recipe lists ~4 ingredients for easy cooking/shopping. So ingredient-derived calories
> diverge from the authored macros in both directions: *Shakshuka* computes 244 vs 430 (its list
> omits oil/bread), while *Peanut Banana Oatmeal* computes 557 vs an authored 410 (oats 233 + milk
> 128 + banana 105 + PB 94 = 560 — **the computed figure is right and the authored one is wrong**).
> Median divergence: **16.2%**.

**Decisions:**
1. **Do NOT auto-replace authored macros with ingredient-derived ones** — the lists are incomplete,
   so that would introduce a different error. Authored macros stay canonical for the solver.
2. **Micronutrients ARE derived from the mapped ingredients** and labelled as such. For the engine's
   real purpose (bias selection toward iron-rich meals), *relative* nutrient density across recipes
   is what matters, and the listed ingredients carry the dominant sources (lentils, spinach, beef).
3. **Never silently scale micros** to force agreement with authored calories — that would inflate
   the nutrients of whichever foods happen to be listed.
4. **Two real bugs to fix:** (a) batch recipes need a `servings` field — *Banana Walnut Protein
   Muffins* computes 913 vs 360 because the ingredients make ~2.5 servings; (b) recipes whose
   computed calories fall far below authored have incomplete lists → complete them over time,
   prioritised by the gate's worst-offenders report.
- Extend the vector: `{cal, protein, carbs, fat, fiber, iron, calcium, vitD, B12, magnesium,
  potassium, folate, zinc, vitC}`. Recipe micros **computed from ingredients**, deterministically.
- `targetNutrient` support: "boost my iron" → engine biases iron-rich foods **while macros hold**.
- **Tests:** nutrient sums; sanity checks (spinach→iron/folate, salmon→vitD/B12); iron-boost
  raises iron without breaking macros; all invariants still hold under fuzz.
- **Exit:** micro values traceable to an FDC id; suite green; pushed.

### ✅ Phase 3 — `compute_targets` + `log_meal` — **DONE**
- **`compute_targets`** — user never types "2000 kcal" again. Age/height/weight/sex/activity/goal
  → Mifflin-St Jeor + activity factor + a sane rate → sets calories & protein. Pure math.
- **`log_meal`** — 🔥 *the killer feature.* "I ate a burger for lunch" → **the rest of the day
  re-solves** to keep you on target. Turns the plan from a document into a living coach.
- **Tests:** "I ate pizza for lunch" → dinner adapts, day still near target; logging a huge meal
  → engine says honestly that the day can't be saved rather than starving dinner.

### Phase 4 — Hydration — *not started* (needs `UserProfile.weightKg`, which `compute_targets` should persist)

- Water target from bodyweight/activity; `set_hydration_target`, `log_water`.
- Plan surfaces hydration; suggests water-rich / electrolyte foods when short.
- **Tests:** "how much water should I drink?", "I only drank 1L today".

### ✅ Phase 5 — Symptom → nutrient reasoning — **DONE** (`symptom_check`)
Built differently, and better, than planned. The tool does **not** map a symptom to a nutrient
and then recommend food. It names what the symptom is *associated* with, then checks those
nutrients **against the user's actual week**, and reports which are genuinely low *in their
own numbers*. A claim about their food, never about their body.
- Recommends **no supplement and no dose** — asserted by test across every symptom.
- A tired vegan is told B12 is at 3%, vitamin D at 0%, and that *no vegan food in the library
  can fix it* — see a dietitian. Honest where a lookup table would have lied.
- **Red flags moved here from Phase 9**, because shipping the symptom tool without them was not
  defensible: chest pain / blood / fainting / slurred speech → urgent care, no nutrient talk.
  Self-harm is a **separate** category with a crisis line, because "see a doctor" is the wrong
  sentence. The engine **overrides the model's reply entirely** on these paths.

### Phase 6 — Personalization & trust — *partly done*
- ✅ **`explain_meal`** — justifies every choice from the plan and the USDA table. Drops a
  nutrient claim entirely when ingredient coverage is under 60% rather than softening it, and
  refuses to invent reasons for a meal the user told it about (a restaurant reserve, a logged
  meal).
- ✅ **`weekly_report`** — computed averages, admitted shortfalls, micronutrients under 80% of
  reference. Distinguishes gaps it *can* close from gaps no compliant food can close.
- ⬜ `rate_meal` / `lock_meal` → persistent taste model.
- ⬜ `undo` — "actually, revert that."

### Phase 7 — Real life — *partly done*
- ✅ **`eating_out`** — reserves a realistic calorie budget for a meal it cannot see, books
  **zero protein** for it (you can't know what you'll order), re-solves the rest of the day, and
  tells you *what to order*: "your other meals carry 102g of protein, so order something with
  roughly 48g." Refuses to prescribe the physically impossible (121g of protein in a 300 kcal
  salad).
- ✅ **`substitute_ingredient`** — safety filter first (diet, allergies, dislikes), curated
  candidates second (a nutrient table doesn't know lentils can't replace a chicken breast),
  computed macro cost third. 440 ingredient×restriction combinations verified safe.
- ⬜ Remaining:
- `scale_portions` ("cooking for 2", "my partner is vegetarian, I'm not")
- `whats_for_now` ("15 minutes and these 5 things")
- `pantry_expiry` ("use the spinach before it turns") · `batch_cook` (cook once, eat twice)
- `travel_mode` · `meal_timing` ("I train at 6pm") · `fasting_window` (16:8)
- `set_budget` (weekly £/$ cap, enforced by the engine)

### 🔄 Phase 8 — Model evaluation, data expansion, **retrain** — *in progress, v5 shipped, v6 queued*
1. `merge_lora.py` → GGUF `q8_0` → LM Studio → `.env.local` (toolchain verified).
2. **Eval harness, not vibes.** Held-out set + hand-written hard cases. Metrics:
   valid-JSON %, correct-tool %, field exactness, hallucination rate, clarification
   appropriateness, refusal correctness. **Fine-tuned vs prompted base**, head to head.
3. **Expand training data 452 → 2,000+**, diversified across:
   every new skill · safety refusals & escalations · symptom conversations · hydration ·
   micronutrients · contradictions ("vegan but add chicken") · impossible constraints
   ("300 g protein, vegan, $20/week") · unknown dishes · vague asks needing clarification ·
   multi-turn pronouns ("do that", "only Tuesday") · typos/slang · users pushing back.
4. **Retrain on GPU.** Then iterate: eval → find the weakness → add targeted data → retrain.

> **Data beats model size.** 452 → 2,000 good examples will improve this more than any bigger
> model or fancier training technique.

### 🔄 Phase 9 — Safety & guardrails *(deferred — but the red flags could not wait, see Phase 5)*
- Red-flag symptoms (chest pain, fainting, blood, pregnancy, meds e.g. warfarin×vitamin K) →
  **escalate to a professional, change nothing.**
- Never diagnose. Hard floors in code: refuse unsafe calorie targets, absurd protein, crash diets.
- Disordered-eating guardrails. Allergy remains inviolable everywhere, including cheat mode.

---

## 3b. Added to the plan mid-build (these weren't in the original phases)

Each of these was discovered by doing the work, and each earned its place.

- **✅ `npm run check:data` — a gate on the training data.** A silent `slice(0, TARGET)` in the
  generator deleted every clarify example the moment the hand-written tail grew past the cap; the
  model would have quietly lost the ability to ask a question instead of guessing. The checker now
  rejects contradictory labels for the same message, null or invented fields, and any tool or the
  clarify category falling below a minimum.
- **✅ Read-only tools, enforced in code.** `weekly_report`, `explain_meal`,
  `substitute_ingredient` and `symptom_check` answer questions; they must never flag the plan as
  changed. `lib/reply.ts` owns that rule and a test fails if a new tool is added without deciding
  which side it falls on.
- **✅ The engine overrides the model on dangerous replies.** The route used to prepend the LLM's
  prose to the engine's notes, so a 1.5B could have written "sounds like low iron!" above a suicide
  hotline. `applyOperations` now returns a `replyOverride` that discards the model's words.
- **✅ A nutrient boost is a guarantee, not a bias.** As a scoring bias, "rebuild my week around
  vitamin D" could hand back *less* vitamin D. Now a monotone upgrade pass, verified after portion
  rebalancing; if no week beats the user's, theirs is kept and the assistant says so.
- **✅ Adversarial audit as a recurring practice, not a one-off.** Independent agents attacking the
  new skills found six real defects in one pass, including a **live allergen exposure**: a user who
  typed `peanuts` — the placeholder in our own onboarding form — was served peanut butter, because
  the matcher only asked whether the ingredient was a plural of the token, never the reverse. Run an
  audit after every batch of new skills. My own 440-combination safety sweep had missed it.
- **✅ PAID: the recipe cards lied.** 46 of 140 recipes disagreed with their own ingredient list
  by more than 20%, one by 63%. Since every micronutrient is derived from the ingredients while
  the calories came from the card, the nutrients were silently wrong in proportion — a Shakshuka
  whose ingredients covered 57% of its calories reported 57% of its real iron. 54 recipes were
  cooked in a pan and listed no fat; five described a smaller meal than the dish is. The
  hand-written macros are now **deleted**: calories, protein, carbs, fat and fiber are computed
  from the ingredients. `npm run check:recipes` fails on an unpriced ingredient, low nutrient
  coverage, an implausible meal, a keto tag over 20g of carbs, or macros that miss Atwater.
- **✅ PAID: the fridge is a guarantee.** "Use up the salmon" was a per-slot bias that the
  protein-diversity cap could defeat, so the test could only assert "usually". The week is now
  built, checked, and the missing ingredient placed: 12/12. Hard rules still win — a vegan asking
  to use up salmon is told, not served — and a pinned meal is never displaced.
- **✅ PAID: the library couldn't feed the diets it offers.** A keto user got Turkey Cobb Salad
  seven days running (3 keto breakfasts, ONE keto lunch, 2 keto dinners). A vegan could not reach
  a protein target — the gap was in the food, not the solver. 28 new recipes: every diet now has
  ≥7 options per slot, vegan protein went 100g -> 131g.
- **⬜ Still owed:** a keto week lands at 42-74g of carbohydrate a day, because the profile's
  carb TARGET is whatever the user's non-keto default was and the solver scales toward it. The
  diet label must set the macro targets.
- **⬜ Still owed:** `protein powder` in the USDA table is whey-based. There is no plant protein
  powder in the table, which caps what a vegan breakfast can do. Add one via `build:nutrients`.

### Testing rules learned the hard way

1. **A test that samples a random week is a coin flip.** The dairy-allergy check passed for weeks
   and only failed once Thai Peanut Chicken Rice Bowl happened to be selected. Scan several weeks,
   or scan the library.
2. **When a test fails, ask whether the test is wrong first.** Four times now the engine was right:
   per-day diet overrides are legitimate; a treat day is *supposed* to be off-target; "unicorn
   tears" contains "corn"; peanut butter is not dairy.
3. **`tsc` will not catch a corrupted regex.** `\b` written through a bash heredoc becomes a
   backspace character. It compiles, and then matches nothing.
4. **Read the summary line, not the tail.** I committed red once because the last three lines of
   the test output were the failure list, not the score.
5. **A green mutation test that never mutated is worse than no test.** Assert the edit landed
   before trusting the result.
6. **Silence is the enemy.** Four bugs this week were silent: a `slice()` that deleted every
   clarify example, an `OP()` allowlist that dropped five fields from every training label, a
   trainer that skipped 1028 of 1030 examples and saved an adapter as though nothing happened, and
   an eval set sharing 24 verbatim strings with the training data. None of them failed anything.
   All four now abort loudly.
7. **Adversarial audit after every batch of skills.** Two audits, eleven real defects, including
   a live allergen exposure and a pin that could break a diet. My own tests missed all of them.
8. **A metric you never audited is a number you made up.** I reported toolAccuracy and
   fieldAccuracy for four model versions before ever checking whether the eval questions appeared
   in the training set. 43% of them did, verbatim. The eval is now a data file behind a gate,
   because the thing that measures the work needs the same scrutiny as the work.
9. **Bad data is a teacher too.** Two nonsense examples — "Friday breakfast is at a work dinner",
   produced by crossing a random meal slot with a venue named "a work dinner" — taught the model
   that the meal word in a sentence is unreliable. It then read "i ate pizza for lunch on monday"
   and answered `breakfast`. Two examples out of 1030 were enough.

---

## 4. Training track (runs in parallel, never blocked by the above)

- **Now:** QLoRA, `Qwen2.5-1.5B-Instruct`, 4-bit, 3 epochs, 452 examples, RTX 2070.
  Checkpoints every 30 steps → **resumable**, survives interruption.
- **Technique:** QLoRA is correct for this task. Full fine-tuning would need ~20–24 GB and buys
  nothing for a fixed-schema tool-calling problem.
- **Hardware note:** the old **Ryzen 1700** was the likely cause of the training bugchecks
  (`0x1E`/`0xC0000096` = illegal instruction — a classic unstable-CPU signature). Since the
  **3700X** swap, sustained full-GPU load has been stable.
- **VRAM is the binding constraint:** training holds ~7.9 GB of 8 GB. Other GPU consumers
  (browser, editor) force a spill to system RAM and collapse throughput (26 s/it → 69 s/it).
- **Scaling later:** more GPUs ≠ bigger models by default (DDP replicates the whole model).
  Pooling VRAM needs **FSDP / DeepSpeed ZeRO-3**, which is slow and fragile over PCIe risers with
  no NVLink. For >7B, **rent one big-VRAM cloud GPU**; keep the multi-GPU rig for **inference
  serving**, which is what it's actually good at.

---

## 5. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Micronutrient data | **USDA FoodData Central (real data)** | Never invent nutrient numbers — that's the exact hallucination the engine exists to prevent |
| Safety phase | **Deferred to Phase 9** | Owner wants coherence demonstrated first; allergy/exclusion invariants remain in force |
| Fine-tune technique | **QLoRA** | ~99% of full-FT quality at ~⅓ the VRAM for a fixed-schema task |
| Base model | Qwen2.5-1.5B (local) | Fits 8 GB; upgrade to 3B/7B once data is expanded |
| Correctness | **Always code, never the model** | The model hallucinated macros when trusted with arithmetic |
| Nutrient boost | **A guarantee, not a bias** | As a scoring bias it could return a week with *less* of the nutrient (vitD 9.5 → 6.5µg). Now a monotone upgrade pass, verified after portion rebalancing; if no week beats the user's, theirs is kept and it says so |
| Read-only tools | `weekly_report`, `explain_meal`, `substitute_ingredient`, `symptom_check` | Advice must never silently rewrite someone's week |
| Dangerous replies | **Engine overrides the model** | The route prepends the model's reply to engine notes — a 1.5B could have written "sounds like low iron!" above a suicide hotline |
| Red flags | **Pulled forward from Phase 9** | A symptom tool without them isn't shippable, whatever the phase order says |
| Training data | **`npm run check:data` gates it** | A silent `slice(0, TARGET)` deleted every clarify example; the model would have lost the ability to ask instead of guess |
| Symptom advice | **Check their food, not their body** | The only claim the data can support |
| Test strategy | Scenarios + invariants + **fuzz** | Fuzzing found 3 real bugs on day one |
