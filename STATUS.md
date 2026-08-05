# 🛠️ Live status — assistant v2 (7B rebuild)

**Last updated: 2026-08-05 13:02** · I update this at every stage change and push it, so you can open
it on GitHub from your phone anytime.

## ▶ Current stage
**Phase 0 — de-risking the environment.** The 7B base model is downloading; I'm about to start wiring
the engine to the new primitive schema.

## Is it *actually* progressing right now? — check it yourself
You don't have to take my word for it. Run any of these on the desktop:
- **Download (now):** `du -sh ~/.cache/huggingface/hub/models--Qwen--Qwen2.5-7B-Instruct` → should be
  climbing toward ~15 G. (At 13:02 it was 9.7 G.)
- **Training (later):** `nvidia-smi` → during training the GPU sits near 100 % util and ~7–8 GB used;
  and the newest `train-*.log` in the repo keeps growing with loss numbers.
- **My checkpoints:** `git log --oneline -15` → every milestone is a commit. If commits + this file's
  timestamp are recent, I've been working.

## Progress checklist
- [x] Root-cause fixes (whole-week swap, reply de-dup, mealsPerDay) — shipped
- [x] Design: coverage blueprint + general-primitive schema + hard-case eval — shipped
- [x] Env verified (CUDA, 104 G free) + 7B download started
- [ ] **← next:** wire engine to primitives (`constrain`/`swap`/`remember`/…) + memory + per-slot
- [ ] generate-then-validate data pipeline
- [ ] generate thousands of realistic convos with `thinking` traces
- [ ] dry-run 7B end-to-end
- [ ] **12 h train** (I'll flag you the moment this starts — keep the desktop awake & off the GPU)
- [ ] test hard vs the eval → **report to you**

## What's running in the background
- 7B download (`Qwen/Qwen2.5-7B-Instruct`) → HF cache. Log: `scratchpad/dl7b.log`.

## Honest note on how I work
I don't think 24/7 — I work in bursts (triggered by you, or when a background job finishes). But the
heavy lifting (the download now, the 12 h training later) runs as a **real OS process that keeps going
whether or not I'm mid-thought**, and it's independently verifiable with the commands above. So "is it
working" = *is a background job progressing* + *is this file's timestamp recent*.

**Next surface point:** a one-liner when the 12 h train starts, then a full report when there's a
trained, tested model to try.
