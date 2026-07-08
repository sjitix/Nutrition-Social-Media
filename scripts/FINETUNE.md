# Fine-tuning the assistant (Step 3 of the assistant roadmap)

Goal: a **small, fast, local LLM fine-tuned specifically for NutriFlow's tool-calling** —
"a general language model, trained for this task, but still an LLM." It replaces the
prompted 7B once it's reliable, staying $0 at inference.

This is set up but **not run yet** — it has two prerequisites (below). Everything here is
ready so we can pull the trigger when they're met.

## The dataset builds itself
Every assistant message is logged to `data/edit-log.jsonl` as a **complete training
example**: the exact system prompt the model saw + the conversation + the tool-call JSON it
should output. `data/` is gitignored (per-machine); aggregate across machines when training.

Bootstrap a diverse synthetic seed (correct, hand-authored labels — not the small
model's guesses) covering compound requests, terse/rambling/vague messages, chit-chat,
typos, multi-turn, and grounded questions:

```bash
node scripts/gen-synthetic.mjs 450   # -> data/synthetic-log.jsonl
```

Then turn everything (real usage log + synthetic seed) into training data:

```bash
node scripts/prep-finetune.mjs
# reads  data/edit-log.jsonl  +  data/synthetic-log.jsonl
# writes data/finetune.jsonl  (chat JSONL: { "messages": [system, ...turns, assistant] })
```

Each example teaches: *given system prompt + conversation → output the tool-call JSON*.

## Where to train (this desktop CANNOT — train in the cloud, free)
**Do NOT run GPU training on this desktop.** Sustained full-GPU load bugchecks it
(`0x1E` / `0xC0000096` — an NVIDIA-driver kernel fault; two Kernel-Power 41 reboots were
logged during a training attempt on 2026-07-08, alongside a months-long history of
`0x9F`/`0xD1`/`0x139` driver/power bugchecks). The mining board + PCIe risers + old RTX 2070
+ HDD-only system is not stable for hours of compute. Local **inference** (LM Studio) is
light and safe — only *training* crashes it.

**Primary path — free Colab T4 ($0):** open `scripts/nutriflow_finetune_colab.ipynb` in
Google Colab, set runtime to **T4 GPU**, Run all, upload `data/finetune.jsonl`, and it
trains + exports a **GGUF** you download and load in LM Studio. Big enough to fine-tune the
**7B** (or switch to 3B in the config cell). Kaggle (free T4 ×2) works the same way.

## Prerequisites before training
1. **Data volume** — aim for **~300–1,000+** examples. `gen-synthetic.mjs` already produces a
   ~450-example seed; grow it with real usage (`data/edit-log.jsonl`) and by expanding the
   generator's phrasings, or by generating more `{message → tool calls}` pairs with a stronger
   model (e.g. Claude) in the same record shape.
2. **A GPU that survives sustained load** — free cloud (above) is the answer here. A local
   **24 GB GPU** (RTX 3090/4090) on a *stable* machine could QLoRA a 7B directly via
   `scripts/train_lora.py`; that script is kept for that case, but it must not run on this desktop.

## Recommended recipe (Unsloth QLoRA — simplest)
```bash
pip install unsloth
```
```python
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments

model, tok = FastLanguageModel.from_pretrained(
    "unsloth/Qwen2.5-7B-Instruct", load_in_4bit=True, max_seq_length=4096)
model = FastLanguageModel.get_peft_model(model, r=16, lora_alpha=16,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])

ds = load_dataset("json", data_files="data/finetune.jsonl", split="train")
ds = ds.map(lambda ex: {"text": tok.apply_chat_template(ex["messages"], tokenize=False)})

SFTTrainer(model=model, tokenizer=tok, train_dataset=ds, dataset_text_field="text",
    args=TrainingArguments(per_device_train_batch_size=2, gradient_accumulation_steps=4,
        warmup_steps=5, num_train_epochs=3, learning_rate=2e-4, logging_steps=10,
        output_dir="out", optim="adamw_8bit")).train()

model.save_pretrained_gguf("nutriflow-assistant", tok, quantization_method="q4_k_m")
```

Axolotl or LLaMA-Factory work too — point them at `data/finetune.jsonl` (chat format) with
the same base model and LoRA settings.

## Plug the result into the app (no code change)
1. Copy the exported `nutriflow-assistant` **GGUF** into LM Studio's models folder.
2. Load it, Start Server on :1234.
3. Set `LOCAL_AI_MODEL=nutriflow-assistant` in `.env.local`.

The app already routes the assistant through `LOCAL_AI_MODEL`, so nothing else changes —
plan generation stays DB-only; only the assistant's language-understanding gets the
fine-tuned model.

## What "good" looks like
The fine-tuned model should emit valid tool-call JSON reliably (no missed exclusions, no
hallucinated meals) and feel natural — matching the prompted big-model behavior, but small,
fast, and local. Keep collecting data and re-train periodically as coverage grows.
