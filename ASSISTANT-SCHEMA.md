# Assistant schema v2 — general primitives + reason-then-act (DRAFT)

The antidote to the "if-else tree" fear: instead of ~20 narrow tools, a **few general, composable
primitives** — most adjustments flow through ONE of them (`constrain`) with a rich body. The model
reasons freely, then emits these. The engine still does all the math. This is the file every training
label is written against, so we lock it before generating data.

## The per-turn output shape (reason-then-act, one model call)

```jsonc
{
  "thinking": "free-form reasoning: what does the user actually want? any constraints to hold or
               remember? is this doable, ambiguous, unsupported, or contradictory? what ops achieve it?",
  "reply":    "natural, warm message shown to the user (empathy, coaching, honesty live here)",
  "operations": [ /* zero or more primitive ops, run in order by the deterministic engine */ ]
}
```

`thinking` is the flexible understanding/decision layer, folded into training so we teach it HOW to
reason. `operations` is the exact executor layer. A pure conversation / clarify / decline / refuse =
a good `reply` with `operations: []`.

## The primitives (the executor's whole vocabulary)

### The workhorse — covers ~70% of edits
- **`constrain`** — apply constraints and re-solve. This one op replaces update_profile,
  regenerate_week, regenerate_day, and all their fields, plus day-ranges and per-slot targeting.
  ```jsonc
  {
    "op": "constrain",
    "scope": "week"                        // whole week (persists to the profile), OR
             | { "days": ["Mon","Tue"] }   // only these days (a temporary per-day override), OR
             | { "slot": "breakfast", "days": ["Mon"] },  // a specific slot (days optional = every day)
    // any subset of these — omit what you don't mean:
    "diet": "vegan", "budget": "low", "cuisine": "italian", "mealsPerDay": 4,
    "exclude": ["mushrooms","oven"], "use": ["salmon","broccoli"],
    "targets": { "calories": 1800, "protein": 200, "carbs": 150, "fat": 60, "fiber": 30 },
    "boostNutrient": "iron",
    "maxCookTime": 20,
    "preserveMacros": true                 // default true; false only for a declared treat
  }
  ```
  - "make it cheaper + vegetarian, no mushrooms" → one `constrain` (scope week, budget, diet, exclude).
  - "vegetarian Mon–Wed" → one `constrain` (scope days [Mon,Tue,Wed], diet).
  - "lighter on weekends" → `constrain` (scope [Sat,Sun], targets.calories lower).
  - "more protein at breakfast" → `constrain` (scope slot breakfast, targets.protein higher).
  - "I'm low on iron but keep me vegetarian" → `constrain` (boostNutrient iron, diet vegetarian).

### The other verbs (genuinely distinct actions, not menu-padding)
- **`swap`** — put a specific dish in a slot. `{ op, dish, scope:{slot, days?} }` (days omitted = every
  day). "pancakes for breakfast every day" → `swap` dish=pancakes, slot=breakfast, no days.
- **`remember`** — store a durable user fact. `{ op, fact, kind? }` where kind ∈ preference | allergy |
  condition | goal | context. NEW — the memory layer. "I'm lactose intolerant" → remember(allergy).
  Facts feed into every future turn's context and bias/constrain the engine.
- **`log`** — a meal ALREADY eaten. `{ op, day, slot, dish, calories?, protein? }` → re-solve the rest
  of that day. (past tense)
- **`reserve`** — a meal that WILL be eaten out. `{ op, day, slot, calories? }` → lighten the rest of
  the day, say what to order. (future tense)
- **`resize`** — more/less food. `{ op, direction: much_smaller|smaller|bigger|much_bigger, scope? }`.
- **`rate`** — `{ op, rating:1..5, dish? , day?, slot? }`. Loved → planned more; hated → dropped.
- **`pin` / `unpin`** — `{ op, day, slot }`. Keep a meal fixed across rebuilds / release it.
- **`report`** — weekly review (read-only, engine computes averages + gaps).
- **`explain`** — `{ op, day, slot }` why a meal is there (read-only).
- **`substitute`** — `{ op, ingredient, day?, slot? }` out-of-an-ingredient advice (read-only).
- **`symptom`** — `{ op, text }` how they FEEL; engine maps to nutrients + safety (read-only). Model
  NEVER diagnoses.
- **`hydration`** — `{ op, weightKg?, activity? }` water target (read-only).
- **`undo`** — reverse the last change (alone).

## The four outcomes (every message resolves to one; NEVER fake a fifth)
- **DO** → one or more ops above. **CLARIFY** → `reply` asks one question, `operations: []`.
- **DECLINE** (unsupported, e.g. skip-a-meal-to-2/day, household servings, fasting windows, meal
  timing) → honest `reply` naming the nearest supported thing, `operations: []`.
- **REFUSE** (contradiction / impossible / unsafe) → `reply` explains, `operations: []` (or a safe
  partial). Engine keeps its allergy/diet guards + crisis override.

## Memory model (makes it a "personal nutritionist")
`remember` writes free-form facts into a growing user store. Every turn's context includes them, so the
assistant applies "lactose intolerant", "hates cilantro", "training for a marathon", "IBS + onions",
"on period since Tuesday" without being re-told. This store is also what the health/cycle phases read.

## Migration
The engine already has handlers for almost all of this; v2 is mostly a **thin adapter** mapping the new
primitives onto existing engine functions (`constrain`→update_profile/regenerate_*; `swap`→swap_meal
incl. the new whole-week path; etc.) + the new `remember`/memory store + per-slot targeting. Deterministic
core, invariants, and macro math are unchanged — so `test:engine` keeps guarding correctness.

## Open questions (I'll decide as I build unless you weigh in)
1. Keep the old flat schema as a compatibility layer during transition, or cut over cleanly? (Lean: cut
   over — the fine-tune is new anyway.)
2. Per-slot targets in the engine — build now, or approximate via `swap` to a high-protein dish? (Lean:
   build a light per-slot bias — it's a common ask.)
3. How rich the memory store gets in round one (just facts + apply, vs. structured conditions). (Lean:
   free-form facts + a few typed kinds now; structure later for the health phase.)
