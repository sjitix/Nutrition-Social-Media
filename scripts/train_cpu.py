"""CPU LoRA fine-tune for NutriFlow's tool-calling assistant.

GPU training bugchecks this desktop (see FINETUNE.md), so this trains on the CPU
instead — zero GPU load, so it cannot trigger the driver fault. Slower, so it uses a
small base (Qwen2.5-0.5B-Instruct by default), which is plenty for this narrow,
fixed-schema tool-calling task. Local, $0.

    BASE_MODEL=Qwen/Qwen2.5-0.5B-Instruct \\
    .venv-ft\\Scripts\\python.exe scripts\\train_cpu.py

Env knobs: BASE_MODEL, MAX_LEN (2048), EPOCHS (3), GRAD_ACCUM (8), MAX_STEPS (-1 =
use epochs; set small for a timing dry-run). Writes models/nutriflow-lora-cpu.
Checkpoints every 20 steps and auto-resumes, so it survives interruption.
"""

import json
import os
from pathlib import Path

import torch
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments
from peft import LoraConfig, get_peft_model

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "finetune.jsonl"
OUT = ROOT / "models" / "nutriflow-lora-cpu"
CKPT = ROOT / "models" / "_ckpt_cpu"

BASE = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
MAX_LEN = int(os.environ.get("MAX_LEN", "2048"))
EPOCHS = float(os.environ.get("EPOCHS", "3"))
GRAD_ACCUM = int(os.environ.get("GRAD_ACCUM", "8"))
MAX_STEPS = int(os.environ.get("MAX_STEPS", "-1"))

# Leave 2 cores free so the machine stays responsive and load stays off the ceiling
# during the long run (this desktop is crash-prone under sustained full load).
torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2))
print(f"Base {BASE} | threads {torch.get_num_threads()} | max_len {MAX_LEN} | epochs {EPOCHS} | accum {GRAD_ACCUM} | max_steps {MAX_STEPS}")

tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token


def ids(msgs, add_gen):
    out = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=add_gen, return_dict=True)
    x = out["input_ids"]
    if x and isinstance(x[0], list):
        x = x[0]
    return list(x)


rows = []
for line in open(DATA, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    rec = json.loads(line)
    full = ids(rec["messages"], False)[:MAX_LEN]
    prompt = ids(rec["messages"][:-1], True)
    plen = min(len(prompt), len(full))
    labels = ([-100] * plen + full[plen:])[: len(full)]
    if any(t != -100 for t in labels):
        rows.append({"input_ids": full, "attention_mask": [1] * len(full), "labels": labels})
print(f"Training examples: {len(rows)}")
ds = Dataset.from_list(rows)


def collate(batch):
    m = max(len(b["input_ids"]) for b in batch)
    pad = tok.pad_token_id
    pack = lambda k, p: [b[k] + [p] * (m - len(b["input_ids"])) for b in batch]
    return {
        "input_ids": torch.tensor(pack("input_ids", pad), dtype=torch.long),
        "attention_mask": torch.tensor(pack("attention_mask", 0), dtype=torch.long),
        "labels": torch.tensor(pack("labels", -100), dtype=torch.long),
    }


model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float32)
model.config.use_cache = False
model = get_peft_model(
    model,
    LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    ),
)
model.print_trainable_parameters()

args = TrainingArguments(
    output_dir=str(CKPT),
    per_device_train_batch_size=1,
    gradient_accumulation_steps=GRAD_ACCUM,
    num_train_epochs=EPOCHS,
    max_steps=MAX_STEPS,
    learning_rate=2e-4,
    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    logging_steps=5,
    save_strategy="steps",
    save_steps=20,
    save_total_limit=1,
    use_cpu=True,
    optim="adamw_torch",
    remove_unused_columns=False,
    report_to=[],
)
trainer = Trainer(model=model, args=args, train_dataset=ds, data_collator=collate)
resume = MAX_STEPS < 0 and CKPT.exists() and any(CKPT.glob("checkpoint-*"))
print(f"Resuming: {resume}")
trainer.train(resume_from_checkpoint=resume)

OUT.mkdir(parents=True, exist_ok=True)
model.save_pretrained(str(OUT))
tok.save_pretrained(str(OUT))
print(f"Saved LoRA adapter -> {OUT}")
