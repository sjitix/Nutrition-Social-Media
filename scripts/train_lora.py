"""QLoRA fine-tune of a small base model for NutriFlow's tool-calling assistant.

Trains on data/finetune.jsonl (chat JSONL: {"messages":[system,user,assistant]}).
Loss is computed ONLY on the assistant turn (the tool-call JSON) — the system
prompt + user message are masked, so the model learns to *produce* the JSON, not
to memorize the prompt.

Runs on an 8 GB GPU (RTX 2070, Turing → fp16, no bf16) via 4-bit QLoRA.
Local, $0. Usage:

    .venv-ft\\Scripts\\python.exe scripts\\train_lora.py

Outputs a LoRA adapter to models/nutriflow-lora. Merge + GGUF conversion is a
separate step (scripts/merge_and_gguf.py) so this stays a clean training run.
"""

import json
import os
from pathlib import Path

import torch
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "finetune.jsonl"
OUT = ROOT / "models" / "nutriflow-lora"

BASE = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
MAX_LEN = int(os.environ.get("MAX_LEN", "2048"))
EPOCHS = float(os.environ.get("EPOCHS", "3"))

print(f"Base model : {BASE}")
print(f"Dataset    : {DATA}")
print(f"Max length : {MAX_LEN}   Epochs: {EPOCHS}")
print(f"CUDA       : {torch.cuda.is_available()} "
      f"{torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''}")

# ---- tokenizer ------------------------------------------------------------
tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token

# ---- build masked examples ------------------------------------------------
# For each record: full = chat_template(all messages); prompt = chat_template(
# messages[:-1], add_generation_prompt=True). Mask the prompt span with -100 so
# loss only covers the assistant JSON + the closing <|im_end|>.
def _ids(messages, add_gen):
    # transformers 5.x returns a BatchEncoding here; pull the flat id list out.
    out = tok.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=add_gen, return_dict=True
    )
    ids = out["input_ids"]
    if ids and isinstance(ids[0], list):
        ids = ids[0]
    return list(ids)


def build(record):
    messages = record["messages"]
    full = _ids(messages, False)
    prompt = _ids(messages[:-1], True)
    full = full[:MAX_LEN]
    plen = min(len(prompt), len(full))
    labels = [-100] * plen + full[plen:]
    labels = labels[:len(full)]
    return {"input_ids": full, "attention_mask": [1] * len(full), "labels": labels}


rows = []
skipped = 0
with open(DATA, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            ex = build(rec)
        except Exception:
            skipped += 1
            continue
        # keep only examples where at least one label is unmasked
        if any(t != -100 for t in ex["labels"]):
            rows.append(ex)
        else:
            skipped += 1

print(f"Training examples: {len(rows)}  (skipped {skipped})")
ds = Dataset.from_list(rows)

# ---- collator: pad input_ids/attention/labels ------------------------------
def collate(batch):
    maxlen = max(len(b["input_ids"]) for b in batch)
    pad_id = tok.pad_token_id
    input_ids, attn, labels = [], [], []
    for b in batch:
        n = maxlen - len(b["input_ids"])
        input_ids.append(b["input_ids"] + [pad_id] * n)
        attn.append(b["attention_mask"] + [0] * n)
        labels.append(b["labels"] + [-100] * n)
    return {
        "input_ids": torch.tensor(input_ids, dtype=torch.long),
        "attention_mask": torch.tensor(attn, dtype=torch.long),
        "labels": torch.tensor(labels, dtype=torch.long),
    }

# ---- 4-bit base + LoRA -----------------------------------------------------
bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
    bnb_4bit_compute_dtype=torch.float16,  # Turing: fp16, not bf16
)
model = AutoModelForCausalLM.from_pretrained(
    BASE, quantization_config=bnb, torch_dtype=torch.float16, device_map={"": 0}
)
model.config.use_cache = False
model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

lora = LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
)
model = get_peft_model(model, lora)
model.print_trainable_parameters()

CKPT = ROOT / "models" / "_ckpt"
args = TrainingArguments(
    output_dir=str(CKPT),
    per_device_train_batch_size=1,
    gradient_accumulation_steps=8,
    num_train_epochs=EPOCHS,
    learning_rate=2e-4,
    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    logging_steps=10,
    save_strategy="steps",       # checkpoint mid-run so it survives interruption
    save_steps=30,
    save_total_limit=2,
    fp16=True,
    optim="adamw_8bit",          # non-paged: faster, tiny optimizer state (18M params)
    gradient_checkpointing=True,  # REQUIRED on 8 GB: without it Windows spills VRAM->RAM (10x slower)
    gradient_checkpointing_kwargs={"use_reentrant": False},
    remove_unused_columns=False,  # custom collator consumes input_ids/labels directly
    report_to=[],
)

trainer = Trainer(model=model, args=args, train_dataset=ds, data_collator=collate)
resume = CKPT.exists() and any(CKPT.glob("checkpoint-*"))
print(f"Resuming from checkpoint: {resume}")
trainer.train(resume_from_checkpoint=resume)

OUT.mkdir(parents=True, exist_ok=True)
model.save_pretrained(str(OUT))
tok.save_pretrained(str(OUT))
print(f"\nSaved LoRA adapter -> {OUT}")
