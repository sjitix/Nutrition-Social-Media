# 🛠️ Live status — NutriFlow

**Last updated: 2026-09-02.** Two active threads below: the meal-generation ENGINE (shipping now,
local commits) and the 7B assistant (trained, awaiting eval).

## ▶ Meal-generation engine — 2026-09-02 (local commits, unpushed)

Deterministic TypeScript engine (no model, runs everywhere). Three increments landed, each tested
(engine suite **548 / 0** after the safety/executor work below) and adversarially reviewed:

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

## ▶ Safety & security — 2026-09-02

- **Allergen leak FIXED** (`2fc6d22`) — prepared foods hid allergens their name didn't spell out, so a
  nut / dairy / sesame / fish excluder was served pesto / hummus / Caesar dishes. `CATEGORY_TERMS` now
  blocks them (pesto→nut+dairy, hummus→sesame, caesar dressing→fish); +6 tests. Suite **545 / 0**.

- **⚠️ SECURITY — NEEDS YOUR ATTENTION (not patched): SSRF on `/api/import`.** `isSafePublicUrl`
  (`src/lib/import.ts`) validates only the INITIAL url, but `fetchHtml` follows redirects
  (`redirect:"follow"`), so a public link that 302-redirects to `http://169.254.169.254/` (cloud
  metadata → credentials) or `http://127.0.0.1/` bypasses the guard and the server fetches it. It also
  checks the hostname STRING, not the resolved IP, so a hostname resolving to a private IP (DNS
  rebinding) slips through. The same `fetchHtml` backs `videoImport.ts`. A correct fix needs an
  SSRF-safe fetch (connect-time IP validation / per-redirect re-validation) + integration tests —
  network-behavior + security-sensitive, so I did not patch it autonomously. Minor: `decodeEntities`
  throws an uncaught RangeError (→ 500) on an out-of-range numeric HTML entity. The static guard is
  otherwise sound (http(s) only; blocks localhost/.local/private-IP & IPv6 literals; 3 MB cap; 15 s timeout).

- **Executor hardening** (`08ce8ef`) — an adversarial review of the write-path executor found
  `log_meal` silently DROPPING a logged meal on a slot the day lacks (a snack on a 3-meal plan) and
  then misreporting the day's calories; now absorbed as a new slot (+3 regression tests). Also:
  whole-week `swap_meal` discloses the week's macros honestly instead of a blanket "kept on target";
  `regenerate_day` guarded against a missing day. Reported, not changed (numbers honest / convoluted):
  single-day `swap_meal`'s unconditional "kept on target" label; a `scale_portions` success-note corner.

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
