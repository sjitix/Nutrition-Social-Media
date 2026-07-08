"""Merge the trained LoRA adapter into the base model (fp16) for GGUF export.

    .venv-ft\\Scripts\\python.exe scripts\\merge_lora.py

Produces models/nutriflow-merged (a full HF model). Convert to GGUF with
llama.cpp's pure-Python converter (no C++ build needed):

    .venv-ft\\Scripts\\python.exe llama.cpp\\convert_hf_to_gguf.py ^
        models\\nutriflow-merged --outfile models\\nutriflow-assistant-q8_0.gguf ^
        --outtype q8_0
"""

import os
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
ADAPTER = ROOT / "models" / "nutriflow-lora"
OUT = ROOT / "models" / "nutriflow-merged"

print(f"Base    : {BASE}")
print(f"Adapter : {ADAPTER}")

base = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float16)
merged = PeftModel.from_pretrained(base, str(ADAPTER))
merged = merged.merge_and_unload()

OUT.mkdir(parents=True, exist_ok=True)
merged.save_pretrained(str(OUT), safe_serialization=True)
AutoTokenizer.from_pretrained(str(ADAPTER)).save_pretrained(str(OUT))
print(f"Merged model -> {OUT}")
