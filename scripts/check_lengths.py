"""GPU-free de-risk for the 7B run: does every training example fit under MAX_LEN?

The trainer masks the prompt and computes loss only on the assistant turn; if the chat-templated
example is longer than MAX_LEN, the answer gets truncated, its labels become all-masked, and the
example is silently dropped (train_lora.py aborts if >5% drop — but we'd rather know BEFORE loading a
7B into VRAM). This loads only the tokenizer (CPU, seconds) and measures every line of the dataset.

    .venv-ft\\Scripts\\python.exe scripts\\check_lengths.py
"""
import json
import os
from pathlib import Path

from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / os.environ.get("DATA_FILE", "finetune-v2.jsonl")
BASE = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-7B-Instruct")
MAX_LEN = int(os.environ.get("MAX_LEN", "2560"))

print(f"Tokenizer : {BASE}")
print(f"Dataset   : {DATA}")
print(f"MAX_LEN   : {MAX_LEN}")

tok = AutoTokenizer.from_pretrained(BASE)


# Mirror train_lora.py exactly: transformers 5.x returns a BatchEncoding here, so ask for the dict
# and pull the (possibly nested) flat id list out. len() on the raw return counts dict keys, not
# tokens — the bug this check exists to not have.
def ids(messages, add_gen):
    out = tok.apply_chat_template(messages, tokenize=True, add_generation_prompt=add_gen, return_dict=True)
    x = out["input_ids"]
    if x and isinstance(x[0], list):
        x = x[0]
    return list(x)


lengths = []
answer_lens = []
over = []
with open(DATA, "r", encoding="utf-8") as f:
    for i, line in enumerate(f):
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        msgs = rec["messages"]
        full = ids(msgs, False)
        prompt = ids(msgs[:-1], True)
        n = len(full)
        lengths.append(n)
        answer_lens.append(max(0, n - len(prompt)))
        if n > MAX_LEN:
            last_user = next((m["content"] for m in reversed(msgs) if m["role"] == "user"), "")
            over.append((i, n, last_user[:60]))

lengths.sort()
N = len(lengths)
p = lambda q: lengths[min(N - 1, int(q * N))]
print(f"\nexamples      : {N}")
print(f"tokens min/mean/max : {lengths[0]} / {sum(lengths)//N} / {lengths[-1]}")
print(f"p50/p95/p99   : {p(0.50)} / {p(0.95)} / {p(0.99)}")
print(f"answer tokens min/mean/max : {min(answer_lens)} / {sum(answer_lens)//N} / {max(answer_lens)}")
print(f"over MAX_LEN ({MAX_LEN}) : {len(over)}  ({100*len(over)/N:.1f}%)")
for i, n, txt in over[:20]:
    print(f"  line {i}: {n} tokens  <- \"{txt}\"")
if len(over) > 0.05 * N:
    print("\nWARNING: >5% over MAX_LEN — the trainer would abort. Raise MAX_LEN or trim the prompt.")
else:
    print("\nOK: under the 5% drop threshold — safe to train at this MAX_LEN.")
