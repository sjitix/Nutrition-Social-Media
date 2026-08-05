# 🛠️ Live status — assistant v2 (7B rebuild)

**Last updated: 2026-08-05 23:57** · I update this at every stage change and push it, so you can open
it on GitHub from your phone anytime.

## ▶ Current stage
**🔥 TRAINING IS LIVE — 7B QLoRA, epoch 1 of 1.** Kicked off 2026-08-05 23:55 on Qwen2.5-7B-Instruct,
4-bit QLoRA over all **3,272 examples (0 skipped)**, **409 steps**. Runs as a detached process (survives
Cursor closing), checkpoints every ~3.3 h (resumable). `test:engine` **444 / 0**.

**Honest ETA: ~5–6 days (≈ Aug 11).** The RTX 2070 does ~20 min/step — a 7B is just slow on this card.
The full-7B / multi-day path was the deliberate choice. When it finishes I run merge → GGUF → grade
against the 45-case eval automatically and send a full report.

## Keep the run healthy
- Desktop **on & plugged in** (never-sleep is set), **Cursor open**, LM Studio's model **unloaded**.
- Don't open anything GPU-heavy — only ~97 MB VRAM spare.
- If it's interrupted (Windows Update, power): it's resumable —
  `RESUME=1 BASE_MODEL=Qwen/Qwen2.5-7B-Instruct DATA_FILE=finetune-v2.jsonl EPOCHS=1 SAVE_STEPS=10 python scripts/train_lora.py`

## Is it *actually* progressing? — check it yourself
- **`nvidia-smi`** → GPU near 100 % util, ~7.9 GB used.
- **Tail the log:** the newest `train-7b-v2.log` grows a step every ~20 min (loss prints every 10 steps).
- **Commits:** `git log --oneline -20` — every milestone is a commit.

## Progress checklist
- [x] General primitives + executor (`applyPrimitives`) + reason-then-act turn schema + v2 prompt
- [x] generate-then-validate data pipeline (every example run through the real engine)
- [x] **3,272** engine-validated convos with `thinking` traces, 0 rejected, length-clean for the 7B
- [x] hard-case eval grown to **45** across all four honest outcomes
- [x] separate `/api/assistant-v2` endpoint (won't disturb the live assistant)
- [x] `merge_and_gguf.py` — one-command LoRA → GGUF (q8_0, self-clones llama.cpp)
- [x] `eval:hardcases` — offline grader (graceful no-op when no model loaded)
- [x] GPU freed + VRAM-fit confirmed (fits 7.9/8 GB, 0 of 3,272 examples skipped)
- [ ] **🔥 IN PROGRESS: 12 h → multi-day QLoRA train** (7B, epoch 1/1, 409 steps, ETA ≈ Aug 11)
- [ ] merge → GGUF → load in LM Studio (one command, ready)
- [ ] grade vs the 45-case eval → **full report to you**

## What's running in the background
- Nothing heavy — waiting on the GPU. The 7B base (15 G) is cached and ready.

## Honest note on how I work
I don't think 24/7 — I work in bursts (triggered by you, or when a background job finishes). But the
heavy lifting (the download now, the 12 h training later) runs as a **real OS process that keeps going
whether or not I'm mid-thought**, and it's independently verifiable with the commands above. So "is it
working" = *is a background job progressing* + *is this file's timestamp recent*.

**Next surface point:** a one-liner when the 12 h train starts, then a full report when there's a
trained, tested model to try.
