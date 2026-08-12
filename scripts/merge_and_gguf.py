"""One command: LoRA adapter -> merged fp16 model -> GGUF, ready to load in LM Studio.

This is the post-training step train_lora.py's docstring promises. It replaces the old two-step
(merge_lora.py, then a hand-typed llama.cpp command) with a single self-healing script:

    # after a 7B run finishes:
    set BASE_MODEL=Qwen/Qwen2.5-7B-Instruct
    .venv-ft\\Scripts\\python.exe scripts\\merge_and_gguf.py

What it does, in order:
  1. Merge  — fold models/nutriflow-lora into the base (fp16) -> models/nutriflow-merged (HF).
  2. Ensure — locate llama.cpp's pure-Python converter (convert_hf_to_gguf.py); if it isn't here,
              shallow-clone it into ./llama.cpp. No C++ build is needed for the q8_0 path.
  3. Convert — run the converter with llama.cpp's OWN gguf-py on sys.path (so the converter and the
              gguf library always match, sidestepping version skew) -> models/nutriflow-assistant-<t>.gguf.
  4. Print  — the final .gguf path + how to load it in LM Studio.

Knobs (env):
  BASE_MODEL  base to merge onto + the tokenizer source (MUST match what you trained). Default 7B.
  ADAPTER     LoRA adapter dir. Default models/nutriflow-lora (what train_lora.py writes).
  OUTTYPE     GGUF quant. Default q8_0 — pure-Python, no build, ~8 GB for a 7B, runs on 8 GB GPU +
              64 GB RAM via partial offload. Smaller quants (q4_K_M, ~4.4 GB, faster on the 2070)
              need the COMPILED llama-quantize binary; this script tells you how if you ask for one.
  LLAMA_CPP   path to an existing llama.cpp checkout (skips the clone).
  SKIP_MERGE  =1 to reuse an existing models/nutriflow-merged (re-convert only).
"""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE = "Qwen/Qwen2.5-7B-Instruct"
ENV_BASE = os.environ.get("BASE_MODEL")  # explicit override, if the user set it
ADAPTER = Path(os.environ.get("ADAPTER", ROOT / "models" / "nutriflow-lora"))
MERGED = ROOT / "models" / "nutriflow-merged"
OUTTYPE = os.environ.get("OUTTYPE", "q8_0")
GGUF_OUT = ROOT / "models" / f"nutriflow-assistant-{OUTTYPE}.gguf"
LLAMA_CPP = Path(os.environ.get("LLAMA_CPP", ROOT / "llama.cpp"))

# Quants that the pure-Python converter can emit directly (no compiled llama-quantize needed).
NATIVE_OUTTYPES = {"f32", "f16", "bf16", "q8_0", "tq1_0", "tq2_0", "auto"}


def die(msg: str) -> "None":
    print(f"\nERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def resolve_base() -> str:
    """The base MUST match what the adapter was trained on. PEFT records it in adapter_config.json,
    so prefer that — it makes a train/merge base mismatch impossible. An explicit BASE_MODEL env
    still wins (e.g. to point at a local copy); the 7B default is the last resort."""
    if ENV_BASE:
        return ENV_BASE
    cfg = ADAPTER / "adapter_config.json"
    if cfg.exists():
        try:
            recorded = json.loads(cfg.read_text(encoding="utf-8")).get("base_model_name_or_path")
            if recorded:
                return recorded
        except (ValueError, OSError):
            pass
    return DEFAULT_BASE


# ---- 1. merge -------------------------------------------------------------------------------------
def merge() -> None:
    if os.environ.get("SKIP_MERGE") == "1" and MERGED.exists():
        print(f"SKIP_MERGE=1 and {MERGED} exists — reusing it.")
        return
    if not ADAPTER.exists():
        die(f"no LoRA adapter at {ADAPTER}. Train first (scripts/train_lora.py) — it writes that dir.")
    base_model = resolve_base()
    import torch  # imported lazily so --help / early errors don't pay the load cost
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    print(f"Base    : {base_model}")
    print(f"Adapter : {ADAPTER}")
    print("Merging (fp16)…")
    base = AutoModelForCausalLM.from_pretrained(base_model, torch_dtype=torch.float16)
    merged = PeftModel.from_pretrained(base, str(ADAPTER)).merge_and_unload()
    MERGED.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(MERGED), safe_serialization=True)
    # The adapter dir carries the trained tokenizer; fall back to the base if it doesn't.
    tok_src = str(ADAPTER) if (ADAPTER / "tokenizer_config.json").exists() else base_model
    AutoTokenizer.from_pretrained(tok_src).save_pretrained(str(MERGED))
    print(f"Merged model -> {MERGED}")


# ---- 2. ensure the converter ----------------------------------------------------------------------
def ensure_llama_cpp() -> Path:
    conv = LLAMA_CPP / "convert_hf_to_gguf.py"
    if conv.exists():
        print(f"llama.cpp converter: {conv}")
        return conv
    print(f"llama.cpp not found at {LLAMA_CPP} — shallow-cloning it (pure-Python converter, no build)…")
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", "https://github.com/ggerganov/llama.cpp", str(LLAMA_CPP)],
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        die(
            "couldn't clone llama.cpp automatically "
            f"({e}). Do it by hand, then re-run:\n"
            f"    git clone --depth 1 https://github.com/ggerganov/llama.cpp {LLAMA_CPP}\n"
            "  (or point LLAMA_CPP at an existing checkout)."
        )
    if not conv.exists():
        die(f"cloned llama.cpp but {conv} is missing — the repo layout may have changed.")
    return conv


# ---- 3. convert -----------------------------------------------------------------------------------
def convert(conv: Path) -> None:
    if OUTTYPE not in NATIVE_OUTTYPES:
        die(
            f"OUTTYPE={OUTTYPE} needs the COMPILED llama-quantize binary (a C++ build). Either:\n"
            f"  • use a native type instead (OUTTYPE=q8_0), or\n"
            f"  • build llama.cpp (cmake -B build && cmake --build build --config Release) and run:\n"
            f"      llama.cpp/build/bin/llama-quantize {GGUF_OUT.with_name('nutriflow-assistant-f16.gguf')} "
            f"{GGUF_OUT} {OUTTYPE}\n"
            f"    after first converting with OUTTYPE=f16."
        )
    GGUF_OUT.parent.mkdir(parents=True, exist_ok=True)
    # Put llama.cpp's OWN gguf-py first on PYTHONPATH so the converter uses the gguf library it ships
    # with — never the (possibly different) pip-installed one. This is the usual source of converter
    # crashes, and it's free to avoid.
    env = dict(os.environ)
    gguf_py = LLAMA_CPP / "gguf-py"
    env["PYTHONPATH"] = str(gguf_py) + os.pathsep + env.get("PYTHONPATH", "")
    cmd = [sys.executable, str(conv), str(MERGED), "--outfile", str(GGUF_OUT), "--outtype", OUTTYPE]
    print("Converting -> GGUF:\n  " + " ".join(cmd))
    subprocess.run(cmd, check=True, env=env)


def main() -> None:
    merge()
    conv = ensure_llama_cpp()
    convert(conv)
    print(f"\nDone: {GGUF_OUT}")
    print("Load it in LM Studio: My Models -> Import, pick that .gguf, push GPU offload to max, ")
    print("context >= 8192, Start Server on :1234. The app's .env.local already points there.")


if __name__ == "__main__":
    main()
