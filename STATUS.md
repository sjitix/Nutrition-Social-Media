# 🛠️ Live status — assistant v2 (7B rebuild)

**Last updated: 2026-08-16.**

## ▶ Current stage

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
