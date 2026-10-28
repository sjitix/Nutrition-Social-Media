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
    "preserveMacros": true,                // default true; false only for a declared treat
    "planMode": "batch",                   // meal-prep mode switch (scope week only) — "fresh" | "batch"
    "cadence": "every3days"                // meal-prep cook cadence: "every3days" (default) | "weekly"
  }
  ```
  - "make it cheaper + vegetarian, no mushrooms" → one `constrain` (scope week, budget, diet, exclude).
  - "vegetarian Mon–Wed" → one `constrain` (scope days [Mon,Tue,Wed], diet).
  - "lighter on weekends" → `constrain` (scope [Sat,Sun], targets.calories lower).
  - "more protein at breakfast" → `constrain` (scope slot breakfast, targets.protein higher).
  - "I'm low on iron but keep me vegetarian" → `constrain` (boostNutrient iron, diet vegetarian).
  - "switch me to meal-prep, cook every 3 days" → `constrain` (planMode "batch", cadence "every3days").
    A mode change rebuilds the week from scratch in the new mode (never keep-paths the old dishes). In
    meal-prep mode a `swap` replaces the WHOLE batch that meal belongs to (every day that batch feeds),
    so the cook stays in sync — a single serving is never swapped in isolation.

### The other verbs (genuinely distinct actions, not menu-padding)
- **`swap`** — put a specific dish in a slot. `{ op, dish, scope:{slot, days?} }` (days omitted = every
  day). "pancakes for breakfast every day" → `swap` dish=pancakes, slot=breakfast, no days.
- **`remember`** — store a durable user fact. `{ op, fact, kind? }` where kind ∈ preference | allergy |
  condition | goal | context. NEW — the memory layer. "I'm lactose intolerant" → remember(allergy).
  Facts feed into every future turn's context and bias/constrain the engine.
- **`log`** — a meal ALREADY eaten. `{ op, day, slot, dish, calories?, protein? }` → re-solve the rest
  of that day. (past tense)
  - The person's own `calories` / `protein` win over a library dish of a similar name, which is scaled to them.
  - The slot's own planned dish, named with no figure, is logged exactly as planned.
  - The meal is marked `record: "logged"` (V1 D7, 2026-10-28): no later re-plan removes or resizes it, and Today
    counts it.
- **`reserve`** — a meal that WILL be eaten out. `{ op, day, slot, calories? }` → lighten the rest of
  the day, say what to order. (future tense) Marked `record: "out"`, and kept through every re-plan the same way.
- **`resize`** — more/less food. `{ op, direction: much_smaller|smaller|bigger|much_bigger, scope? }`.
- **`rate`** — `{ op, rating:1..5, dish? , day?, slot? }`. Loved → planned more; hated → dropped.
- **`pin` / `unpin`** — `{ op, day, slot }`. Keep a meal fixed across rebuilds / release it.
- **`report`** — weekly review (read-only, engine computes averages + gaps).
- **`explain`** — `{ op, day, slot }` why a meal is there (read-only).
- **`substitute`** — `{ op, ingredient, day?, slot? }` out-of-an-ingredient advice (read-only).
- **`symptom`** — `{ op, text }` how they FEEL; engine maps to nutrients + safety (read-only). Model
  NEVER diagnoses.
- **`crisis`** — `{ op }`, no fields (2026-10-22): the model's own flag that someone may not be safe. The
  app answers with the reviewed `CRISIS_REPLY`, applies nothing else from the turn (not even an undo),
  ends the run, and writes no log line. It exists because, with reasoning off, Nemotron sent crisis
  words to `symptom`, where a phrasing the pre-scan misses got a nutrition note. The prompt teaches it
  as the first rule of HOW TO DECIDE, and lands with it: a prompt naming an op the schema lacks would
  make every crisis turn unreadable.
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

---

# The agent loop and the read surface (v3 — specified 2026-08-16, BUILT 2026-08-29)

**This section is no longer a proposal.** The read surface is `src/lib/agentTools.ts` and the loop
is `src/lib/agentLoop.ts`; `/api/assistant-v2` runs it. What is described below is what the code
does — if the two ever disagree, the code is right and this file is stale. `/sage/assistant` is
the client that drives it. What has NOT happened yet is a run against a real model: every turn so
far has exercised demo mode and the failure paths.

Everything above describes ONE model call that emits `{thinking, reply, operations}`. That is the
reason-then-act turn, and it stays. What follows wraps it in a loop and gives the model eyes.

See VISION.md → "Conversational assistant" for the three binding rules this implements.

## Two different things both called "read-only"

`src/lib/reply.ts` already exports `READ_ONLY_TOOLS` — `answer`, `weekly_report`, `explain_meal`,
`symptom_check`, `rate_meal`, `hydration`, `lock_meal`… Those are **user-facing answers**: the
tool's output IS the reply, and the set exists so an answer never falsely reports "I changed your
plan".

The read surface below is **model-facing**: its output goes back into the loop as input to the
next model call, and the user never sees it. A `find_recipes` result is not an answer; it is the
model looking something up before deciding.

**Do not merge the two sets.** They are both "does not change the plan" and nothing else about
them is alike. Conflating them would make lookups leak into replies and answers vanish from them.

## The read surface

Every tool is a pure function of (profile, plan, library). No I/O, no model, no network — so each
one is unit-testable and cannot fail in a way the loop has to reason about.

| tool | arguments | returns | wraps |
|---|---|---|---|
| `find_recipes` | `mealType?, diet?, minProtein?, maxTime?, maxCalories?, query?, limit?` | ≤10 rows: name, type, kcal, protein, carbs, fat, fibre, minutes, dietTags. Never a dish the person's allergies or dislikes block; "seafood" in the query is the fish and shrimp dishes (2026-10-23) | `filterFeed` + `sortFeed`, `wantsSeafood` |
| `inspect_recipe` | `name` | one dish in full: ingredients with quantities, steps, macros, micro coverage | `RECIPES` + `microsForIngredients` |
| `get_plan` | `day?` | the week, or one day: slot, dish, macros, day totals against target | the plan in the request |
| `get_profile` | — | targets, diet, allergies, dislikes, mealsPerDay, maxCookTime, pins, ratings, remembered facts | the profile in the request |
| `get_saved` | — | saved recipe names with their macros | `loadSaved` |
| `report` | `scope: week \| day` | computed averages, shortfalls, micronutrients under reference | the existing `weekly_report` engine |
| `what_if` | `operations[]` | what those ops WOULD do — notes, and the resulting totals — **without committing** | `applyPrimitives` on a copy |

**`what_if` is the one with no equivalent today and the most leverage.** The engine is pure, so a
proposed change can be simulated and inspected before it is made. It is the agent's version of
running the tests before claiming the work is done, and it is what lets the model say "that would
put you 300 kcal over, here is a better option" instead of doing it and apologising.

**Every read tool is bounded.** `find_recipes` caps at ten rows. This is RULE 1: a tool call is a
query, and an unbounded query is context stuffing with extra steps.

## The loop contract

```
turn = model(transcript)                     # {thinking, reply, operations}
while turn asks for tools and steps < MAX:
    results = execute(turn.operations)       # reads answer; writes go through applyPrimitives
    transcript += turn, results              # THE RESULTS GO BACK TO THE MODEL
    turn = model(transcript)
reply = composeReply(turn.reply, engine notes)
```

- **MAX_STEPS = 8.** A cap, not a target. Hitting it is a bug to investigate, and the user is told
  honestly that the assistant gave up rather than being handed a half-finished change.
- **Writes still go through `applyPrimitives`,** unchanged. The two-layer rule is untouched: the
  model never computes anything, and the engine remains the only thing that may claim a change.
- **Engine `notes` go back into the transcript,** not only into the reply. This is the whole of
  "the agent observes its own action" — when the engine refuses a pin or relaxes a cook-time limit,
  the model finds out and can respond to it.
- **One undo snapshot per user turn,** taken before the first write of that turn, not per step —
  otherwise "undo" walks back one loop iteration rather than one thing the user asked for.
- **The transcript is the memory.** Nothing is stored between turns; the server stays stateless.
- **A model that cannot be reached is reported, not swallowed.** The loop catches the model's own
  failure so that work the engine already completed in earlier steps is not thrown away — but it
  sets `modelFailed` on the result, and the caller MUST branch on it. This was learned by
  shipping the bug: because the loop caught the error, the route's offline handling became dead
  code and a stopped LM Studio came back as an ordinary `200` reading "1 of 8 steps". The rule the
  route now follows: **model failed and nothing changed and nothing was said → `503 offline`; model
  failed after the engine had already changed something or answered (`engineSpoke`: an explanation,
  an urgent reply) → `200` with that answer, carrying `modelFailed: true`, so the client can say the
  turn did not finish.** The "nothing was said" half is from 2026-10-22: a failure after an answer used
  to replace it with "offline", an urgent-care reply included (F5's mapping, MF-1).
- **Why the model failed travels with the failure** (2026-10-22). The provider throws a `ModelFailure`
  (`assistant/modelFailure.ts`), whose kind is one of unreachable, timeout, busy, unavailable, config,
  rejected, unreadable or empty. The result carries `modelFailure.kind`, and the route logs it. Nobody
  shows the person the error's text.
- **A crisis reply ends the run; an urgent one does not.** Nothing outranks a crisis, so the run stops
  with it, as the pre-scan's does. After an urgent reply a later step can still bind an allergy or raise
  it to a crisis, so the run goes on, and a later failure no longer replaces it (`engineSpoke`). A crisis
  outranks an urgent reply in whichever order they come. (A first version ended the run on any urgent
  reply; its review found the allergy that cost.)
- **A turn the model sent but nobody could read is not the end of the turn.** That covers JSON that
  fails the schema, and text that is not one JSON object. In text that is not one object, a complete
  turn beside a stray brace is still read, and the op objects of a cut-off answer are still found. One
  malformed op used to throw the whole turn away, a stated allergy with it (MF-2). Now:
  - the turn's `remember` and `symptom` ops are kept, each read on its own and leniently (a label
    such as "Allergy" or null, or a fact sent as a list, still binds), and nothing else, because
    `[undo, an unreadable swap]` must not half run. They run whatever happens next, on the cap step
    and after a second failure too;
  - the model gets ONE more step, told what could not be read and what was saved;
  - if that step fails too, the run stops as a model failure, with what was kept still kept;
  - if nothing at all could be read and the retry brings only words, the run is still the failure:
    "Noted." never stands over an allergy that was never saved.
- **An allergy stated in an earlier message binds even if its own turn failed** (the history allergy,
  2026-10-23). It used to be lost for good when that turn's model failed or never sent the `remember`,
  because nothing read the transcript again. Before the first model call, the loop reads the earlier user
  messages (`earlierAllergyFacts` in `primitives.ts`):
  - **which messages:** one whose turn got no answer (the chat sends no reply for a failed turn, or the
    reply holds the failure or step-cap line) is read for statements. One that WAS answered binds only what
    its reply promised to keep out ("Noted — I'll keep peanuts out of everything", with nothing bound), or
    what the speaker stated as their own in so many words ("i'm allergic to peanuts, can you add more
    chicken and rice?", answered by a run that did only the swap). The rest of an answered message is left
    to the model that answered it;
  - **one clause per cue word**, cut at punctuation, a contrast word or a new request, each through the same
    gate a `remember` goes through. Fed whole, "i'm allergic to peanuts, can you add more chicken and rice?"
    bound chicken and rice;
  - **statements only**: a clause that asks ("is this safe for a coeliac?"), wonders ("what if I was…",
    "we thought…"), is about people in general ("for people with gluten intolerance", "asking for a friend")
    or someone the person does not feed (a coworker, a cousin abroad, a dog: unless the sentence says they
    are coming to eat), is past or dismisses itself ("…but it was a false positive"), or jokes ("allergic to
    vegetables lol") binds nothing, and nor does a whole food group. A laugh alone is no joke ("im alergic to
    shrimp lol"), and a bare "he's allergic" takes the food said just before it;
  - **measured on four sets written blind by other agents** (lesson 71), each used once. The keyword test
    does not generalize far: untuned, it bound something for 8 of 50 messages that state no allergy. On the
    fourth set, for the speaker's own words that state no allergy, it bound 9 of 45 in a turn that failed
    and 4 of 45 in an answered one. For the speaker's own allergies it bound 34 and 32 of 35. That is why
    an answered message binds so little. Whether to bind with a note or ask first is owner decision 15;
  - **a later denial that names the food wins**, the current message's too. One that names nothing ("I
    don't have any allergies") cancels nothing, because it may be about the speaker and the earlier clause
    about their son;
  - **nothing the person removed by hand comes back** (`profile.removedAllergies`, written by the profile
    form; a new statement in chat binds it again and clears it).

  What it binds is the run's starting state, not one of its changes. It takes no undo slot, and no undo
  takes it back, in this run or the next: the same holds for any allergy the conversation states that is
  already bound. Every claim check is judged from the state after it. Its note comes first, opening "Going
  by what you said earlier," (`EARLIER_LEAD`), unless a crisis or urgent reply is the whole answer.
- **An empty answer is the host's failure, not the model's.** The provider retries it, and the loop
  neither nudges the model nor writes a turn for it.
- **A reply may not claim a change the engine did not make** (2026-10-03, the models lane's proposal).
  With reasoning off, a fast model copied the engine's note style and wrote "Wednesday now has 2000
  kcal…" with no operation at all. When the model stops, nothing changed, the engine wrote no notes
  (so the model's prose IS the reply) and that prose `claimsChange` (`reply.ts`), the loop puts
  `FALSE_CLAIM_NUDGE` in the transcript as the result of the write it should have sent and calls the
  model ONCE more. It can send the operation or retract. If it still claims a change, `composeReply`
  replaces the reply with `NOTHING_CHANGED_REPLY`. The result reports `falseClaimRetried` and
  `falseClaimCaught` so the evals can count both. `claimsChange` is the ONE copy of the detector (active
  and passive voice: "I've swapped", "has been swapped", "are now quicker"), and the models lane's evals
  import it. Its blind spot is a claim made when the plan DID change, so the engine closes that from
  its side: a day re-plan always writes "<day> now has …", and an empty constrain changes nothing and
  says so (a week-scoped one, or a day scope whose only field is preserveMacros: false).
- **Every note is true of the week the run ENDS with** (2026-10-27, the second review's #14 and #4). The
  person reads one reply, at the end, but each step's notes described the week as that step left it: a
  swap's "Monday now has 2000 kcal" stood beside a later resize's "Monday now comes to 2192", and a denial's
  "your allergies still include peanuts, so nothing with them is planned" stood after an undo took peanuts
  off. The loop keeps each engine call's notes as sources and settles them at the end (`runNotes.ts`): an
  allergy fact's sentences are rendered from the final week and allergies, and a figures sentence a later
  call made stale is dropped, with one line from the final week if nothing later states it. Action records
  ("I swapped …") stay. The **undo label** names only the writes that changed something: in a step of
  several, each is also tried alone on a seed of its own (the run's random choices are untouched), so a
  refused swap beside a real one is no longer named. The transcript the model sees is unchanged: each
  step's result still carries that step's own notes.
- **The finishing call can be skipped when it cannot change what the person reads** (the fast finish,
  2026-10-22). After a step that changed something and got engine notes, whose turn made no lookups and
  carried a reply of its own, `composeReply` returns the notes and discards whatever a finishing call
  says. So the loop answers that call itself with an empty turn (`fastFinished: true`), exactly as the
  models lane's eval wrapper did when it measured the rule. A refusal, a lookup, a nudge and an empty
  reply still go back to the model.
  - **It also cuts any write the model would have sent next,** including a remembered allergy. So it is
    safe only for a model that finishes in one write turn. Nemotron-3-Ultra 550B with reasoning off does:
    across its recorded runs, the call the skip replaces sent nothing new after a write (0 of 275 write
    messages; 0 of 23 in the fair run's matched messages). gpt-oss-20b does not (7 of 49).
  - **The reply rule is not what keeps it safe.** The 550B writes a reply beside nearly every write, so the
    rule withheld 1 skip in 84.
  - **Off unless the caller passes `fastFinish: true`.** The route passes it when `AI_FAST_FINISH=1`, a
    setting for the model it was measured on. An eval asks for it, or uses the models lane's wrapper, but
    not both.
  - **What it saves on the 550B** (`cd2244b`): 1.2 model calls a message against 1.8, and 5.5 s median
    against 7.1 s.

## Testing it with no model at all (RULE 2)

The loop is ordinary code and is tested with a scripted provider that returns canned turns:

| fake provider | asserts |
|---|---|
| asks for one read, then answers | results are fed back; it terminates |
| writes, then reads the notes, then answers | engine notes reach the model |
| never stops asking | `MAX_STEPS` holds and the user is told honestly |
| emits invalid JSON / an unknown op | the loop degrades to a plain reply rather than throwing |
| emits ops the engine refuses | the refusal reaches the model and it can change course |
| claims a change with no operation | one nudge and one retry; then the honest line, never the claim |
| sends an EMPTY constrain (week scope, or only preserveMacros:false) | nothing changes, and the engine says what it needs; a bare day constrain still re-plans that day and says where it landed |
| writes with a reply, the engine writes notes, `fastFinish` on | no finishing call, and the run leaves exactly what an empty finishing turn would (8 writes compared) |

No GPU, no keys, no fine-tune. This belongs in `npm run test:engine`, and it must exist BEFORE a
real model is wired in — otherwise a harness bug and a model weakness look identical.
