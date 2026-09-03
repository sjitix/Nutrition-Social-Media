# 🛠️ Live status — NutriFlow

**Last updated: 2026-09-02.** Two active threads below: the meal-generation ENGINE (shipping now,
local commits) and the 7B assistant (trained, awaiting eval).

## ▶ Meal-generation engine — 2026-09-02 (local commits, unpushed)

Deterministic TypeScript engine (no model, runs everywhere). Three increments landed, each tested
(engine suite **559 / 0** after the safety/hardening work below) and adversarially reviewed:

- **Macro accuracy** (`2b2f6b6`) — `chooseRecipe` ranks by macro-density fit FIRST (not a tiebreak),
  so fat/carbs land near target instead of ~15–25% over; per-user fiber target; `achievementNote`
  discloses carb/fat/fiber misses honestly (plant-diet fat floors ~78g and is disclosed, not hidden).
- **Condition detection** (`4f9a75b`) — `src/lib/conditions.ts`: a condition→nutrient table
  (period→iron+magnesium, pregnancy→folate+iron+calcium, anaemia, menopause, osteoporosis…) plus
  `conditionBoosts()` with fact-aging and adjacency-based deficiency parsing.
- **Condition-aware build** (`4c0ce27`) — `selectConditionAwareWeek`: biases a fresh week toward a
  condition's nutrients via the existing boost machinery, macros held, disclosed. TESTED but **NOT
  wired to live generation** — see decisions below.

**Your calls to unblock the condition feature** (full spec: `CONDITION-AWARE-GEN.md`):
1. Ask-vs-auto-apply on a fresh plan — VISION says *ask*; safest is the assistant CLARIFY→`constrain`
   path. Auto-apply needs the notes channel + accepts a free-text false-positive risk.
2. Surface `WeekPlan.notes` in the UI, or keep condition bias in the assistant path only.

**Diagnosed + parked** (data/product-gated, not bugs — see memory `recipe-db-constraints`): vegan/veg
protein monotony (`MainProtein` enum has only 2 vegan / 4 veg sources — needs more recipes); budget
`high` == `medium` (no recipe costs > 3).

## ▶ Agent layer — 2026-09-02 (local commit `fab49fd`)

The pulled-in agent loop (`agentLoop.ts` / `agentTools.ts`) was built but never model-driven. Hardened
its DETERMINISTIC contracts (VISION rule 2 — tested with scripted providers, no model):

- **+5 loop tests**: undo through the loop restores the pre-write plan and clears the one-level undo
  slot; a read + a write in one turn both run; a `remember` op marks the profile changed.
- **`agentTools` read-surface bugs fixed** (adversarial review): `inspect_recipe("")` no longer
  returns an arbitrary dish; `find_recipes` coerces bad `limit`/`query` args (no NaN, no throw).
- **De-flaked** a swap/pin test that had assumed which slot a dish lands in.

**Decision needed:** `what_if` previews are **non-deterministic** — `chooseRecipe`'s `Math.random`
variety tiebreak means a preview may not exactly match the eventual commit. Fixing it (a seedable
engine) trades against deliberate regenerate-variety, so it's an architecture call. It is safe on the
key property: `what_if` clones state and never mutates the real plan.

## ▶ Safety & security — 2026-09-02, updated 2026-09-03 (SSRF + 8 more fixes, all pushed; 589/0)

- **Allergen leak FIXED** (`2fc6d22`) — prepared foods hid allergens their name didn't spell out, so a
  nut / dairy / sesame / fish excluder was served pesto / hummus / Caesar dishes. `CATEGORY_TERMS` now
  blocks them (pesto→nut+dairy, hummus→sesame, caesar dressing→fish); +6 tests. Suite **545 / 0**.

- **Allergen under-block review #2 FIXED** (`11ccb9f`, 2026-09-03) — a second adversarial pass hunting
  the DANGEROUS direction (an allergen reaching an allergic user). Found: hyphenated soy sauces
  (soy-ginger / ginger-soy / sesame-soy) evaded gluten/wheat because they don't contain the phrase
  "soy sauce" — one dish, `d-chicken-veg-stirfry`, was consequently mislabeled `gluten_free` (fixed);
  Caesar dressing was under `fish` only, not `eggs`/`dairy` (it's raw yolk + parmesan); the egg
  category was keyed `eggs` only, so a SINGULAR `egg` allergy didn't expand. All fixed (+ `teriyaki`
  added to `GLUTEN_INGREDIENTS`, + singular `prawn` in the veg checkers); 5 tests; dietTag integrity
  clean. **Flagged, NOT changed (data-modeling calls for the owner):** kimchi tagged vegan/GF though
  real kimchi has fish sauce/shrimp; tikka masala sauce modeled as plain tomato so `Tikka Masala Tofu`
  reads vegan (and "creamy" in the chicken version — internal inconsistency); buffalo sauce modeled as
  sriracha (real has butter).

- **Executor review FIXED** (`fbf4cc9`, 2026-09-03) — an adversarial pass over `applyOperations` (the
  write path, the ONLY code allowed to claim a plan change). HIGH: `swap_meal` to a slot the day/week
  lacks (a snack on a 3-meal plan) matched a real snack recipe but placed nothing, then the note
  claimed the day / "every day" was updated — a dish never placed + a false claim (the exact two-layer
  violation the design forbids). It was the missing sibling of the guard `log_meal` (adds the slot)
  and `eating_out` (warns) already had — **lesson 14 a THIRD time**. Both swap paths now warn honestly
  and the whole-week path only claims what it placed. MEDIUM: `log_meal`/`eating_out` accepted a
  negative/non-finite calorie number and locked it into the day (the rebalancer then inflated the
  others to cover a phantom deficit); now guarded `> 0 && finite` like the other numeric ops. 7 tests.
  **Reviewed SOLID:** undo (restores exactly, spends the snapshot once), the `planChanged` deep-compare,
  aliasing (no in-place mutation of caller/undo state), lock/pin handling. **Reported, NOT changed
  (LOW):** `profileChanged` set true on no-op profile writes (redundant undo point; nothing real
  dropped); whole-week swap drops pins with only implicit disclosure (marked deliberate); silent
  no-op breaks on malformed ops.

- **SECURITY — SSRF on `/api/import` FIXED** (`88df7ae`, 2026-09-03). `isSafePublicUrl`
  (`src/lib/import.ts`) validated only the INITIAL url while `fetchHtml` followed redirects
  (`redirect:"follow"`), so a public link that 302-redirected to `http://169.254.169.254/` (cloud
  metadata → credentials) or `http://127.0.0.1/` bypassed the guard and the server fetched it.
  `fetchHtml` now RE-VALIDATES the final url after redirects and refuses the body if it resolved
  somewhere private; the string guard now also rejects bare no-dot hosts (`metadata`, `intranet`),
  the `.internal` TLD, `0.0.0.0/8` and CGNAT `100.64/10`, via WHATWG IPv4 normalisation
  decimal/octal/hex-encoded literals (`http://2130706433` → `127.0.0.1`), and a TRAILING DOT on any
  named host (`localhost.` / `metadata.google.internal.` resolve to the same internal host but slipped
  every rule) — that last bypass was caught by an adversarial self-review AFTER the initial fix and
  closed in `3fbca56`. Regression tests throughout; suite **577 / 0**. The same `fetchHtml` backs
  `videoImport.ts`, so both import paths are covered.
  **Residual (documented in-code, NOT yet closed):** a hostname that RESOLVES to a private IP (DNS
  rebinding) still slips the string check, and the request fires once before the final-url re-check —
  the complete fix is connect-time IP validation via a custom undici dispatcher. (The related
  `decodeEntities` RangeError→500 on an out-of-range numeric HTML entity is now FIXED, `b83d917`:
  valid code points decode, out-of-range ones stay literal; +2 tests.)

- **Executor hardening** (`08ce8ef`) — an adversarial review of the write-path executor found
  `log_meal` silently DROPPING a logged meal on a slot the day lacks (a snack on a 3-meal plan) and
  then misreporting the day's calories; now absorbed as a new slot (+3 regression tests). Also:
  whole-week `swap_meal` discloses the week's macros honestly instead of a blanket "kept on target";
  `regenerate_day` guarded against a missing day. Since FIXED: single-day `swap_meal` now uses the
  honest `achievementNote` too (`b7fadc1`), matching the whole-week path. `scale_portions` was
  reviewed and left as-is — its note already states the day's actual kcal vs target and discloses
  every skipped meal, so it never claims false success.

- **Reply/feed hardening** (`f1d1e9e`) — `composeReply` now de-duplicates notes (the user was shown
  the same sentence twice when an op repeated / notes accumulated across agent-loop steps) and can't
  return a blank; feed search matches at WORD STARTS (`"oat"` no longer hits "goat", `"chick"` still
  finds chicken) — the substring over-match the allergen path abandoned; `filterFeed` now treats
  vegan as satisfying a vegetarian filter. Since FIXED: `composeReply`'s crisis guard now keys off
  PRESENCE not truthiness (`c5994f6`), so a future empty override still silences the model (a bare
  `/egg/` in a diet test that matched "Eggplant" was word-bounded in the same commit). `planWasChanged`
  is left in place — unused in the flow, but it documents, by being the rejected alternative, why the
  engine reports COMPARED change rather than which tools were named.

> **Review sweep COMPLETE (2026-09-02) — EVERY module adversarially reviewed:** macro path,
> conditions, `agentTools`, `agentLoop`, `exclusions`, `import`, the write-path executor,
> `targets`/`nutrients`, `reply`/`feed`, `streak`/`grocery`/`substitutions`. ~9 real bugs fixed, each
> with a test (suite **575 / 0**). `grocery` clean; `substitutions` safe (one flagged `miso→gluten`
> policy call). **All work PUSHED** (origin/main, 2026-09-03). Since the sweep: `what_if` seedable
> determinism (`b19c27d`), `gramsFor` units cup/oz/kg/lb/l (`5b72286`), WORKPLAN de-dupe + lesson-35
> repair (`9d67e83`), decodeEntities/single-day-swap/composeReply hardening (`b83d917`/`b7fadc1`/`c5994f6`).
> Remaining leftovers (all owner-gated): condition-aware generation WIRING (the ask-vs-auto-apply UX
> call); the `soy sauce → miso` gluten policy call; the 7B eval.

---

## ▶ 7B assistant — trained, awaiting eval (unchanged since 2026-08-16)

**✅ TRAINING FINISHED · ✅ MERGED TO GGUF ON THE DESKTOP · ⚠️ NO BACKUP YET.**

The 7B QLoRA (Qwen2.5-7B-Instruct, 4-bit, 3,272 engine-validated examples, 409 steps at ~20 min a
step) started 2026-08-05 and **ran to completion on the desktop**. Nothing was lost when that machine
was shut down: VRAM is volatile and always was, and the run checkpointed to disk every 10 steps.

**Where the results are (desktop, all gitignored so never pushed — no second copy):**
- `models/nutriflow-lora` — the LoRA adapter (154 MB). *The irreplaceable one.*
- `models/nutriflow-assistant-q8_0.gguf` — merged + converted, **7.54 GB**, built 2026-08-12. Ready
  to load in LM Studio.
- `models/nutriflow-merged` — 14.5 GB fp16 intermediate; deletable (regenerates from the adapter).

> ### ⚠️ FIRST ACTION: copy `models/nutriflow-lora` somewhere else.
> One copy, one drive, in a machine whose previous SSD already died. The adapter is small (the
> merged ~8 GB GGUF is regenerated *from* it) and the base model is re-downloadable from
> HuggingFace. It is the only artefact here that six days of GPU time cannot replace.

**Merge/convert is done; it has NOT been backed up, loaded, or graded.** The remaining work is to
protect the adapter, serve the GGUF locally, and measure it against v9.

## The whole remaining sequence

```bash
# 0. BACK IT UP FIRST — another drive, a cloud folder, a USB stick. Anywhere but that one disk.

# 1. merge LoRA -> fp16 -> GGUF q8_0 — ALREADY DONE (models/nutriflow-assistant-q8_0.gguf, 7.54 GB).
#    Only re-run scripts/merge_and_gguf.py if that file is lost.

# 2. load the .gguf in LM Studio: GPU offload max, context >= 8192, serve on :1234

# 3. grade it against the hard cases
npm run eval:hardcases

# 4. compare with v9 before flipping anything over
```

**What "better" has to mean.** v9 scores 94 / 94 on the 125-case set. A 7B that does not clearly
beat that is not worth shipping just because it cost six days — WORKPLAN records two models (v10,
v11) that lost to v9 and were correctly discarded. Measure across **three runs**; temperature-0
non-determinism is ~1–2 points, so a single run cannot separate close models.

## Progress checklist

- [x] General primitives + executor (`applyPrimitives`) + reason-then-act turn schema + v2 prompt
- [x] generate-then-validate data pipeline (every example run through the real engine)
- [x] **3,272** engine-validated conversations with `thinking` traces, 0 rejected
- [x] hard-case eval grown to **45** across all four honest outcomes
- [x] separate `/api/assistant-v2` endpoint (does not disturb the live assistant)
- [x] `merge_and_gguf.py` — one-command LoRA → GGUF (q8_0, self-clones llama.cpp)
- [x] `eval:hardcases` — offline grader (graceful no-op when no model is loaded)
- [x] **QLoRA train — DONE.** 409 steps, adapter at `models/nutriflow-lora`
- [x] **merge → GGUF — DONE.** `models/nutriflow-assistant-q8_0.gguf` (7.54 GB)
- [ ] **⚠️ BACK THE ADAPTER UP** — one copy, one drive, no backup
- [ ] load the GGUF in LM Studio
- [ ] grade against the hard cases, and compare with v9 over three runs
- [ ] only then: flip the client from `/api/assistant` to `/api/assistant-v2`

## ⚠️ The training data is not in this repo either

`data/finetune-v2.jsonl` (3,272 examples) is gitignored like the models. Unlike the adapter it is
**reproducible** — the generator (`src/lib/genV2.ts`, `src/lib/dataValidate.ts`, validated against
the real engine) is committed — so losing it costs a script run rather than six days. Worth
regenerating once and checking it still yields 3,272 before trusting that number again.

## What the model gates, and what it does not

The engine is pure TypeScript and never calls a model, so **no number anywhere in the app depends
on any of this** — the planner, macros, allergen filtering and the whole `/sage` design work
without it. What the model gates is the **assistant**: the conversational half, which is the
product's core role rather than a side feature.

**And the bar for it has moved.** See `VISION.md` → "Conversational assistant": the assistant is to
be an *agent* — understand everything, read everything, decide from what it read, change everything
— not a classifier that maps a phrase to a tool. That section also records, honestly, that a 7B
will not feel like a frontier coding agent however good the data; the architecture is what carries
over, and swapping the brain is `AI_PROVIDER` plus a key. **The next assistant work (the agent loop,
specified in `ASSISTANT-SCHEMA.md` v3) needs no GPU, no keys and no trained model at all.**

---

## Superseded, kept for the record

The sections below described the run while it was live. They are wrong now and are left only so the
history reads straight.

## Honest note on how I work
I don't think 24/7 — I work in bursts (triggered by you, or when a background job finishes). But the
heavy lifting (the download now, the 12 h training later) runs as a **real OS process that keeps going
whether or not I'm mid-thought**, and it's independently verifiable with the commands above. So "is it
working" = *is a background job progressing* + *is this file's timestamp recent*.
