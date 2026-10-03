# The 128 GB question — what a unified-memory box would actually run

Answers the owner's board comment (2026-09-19, relayed by the v1 lane on 2026-10-03): *"what is the
maximum AI agent we can run on cloud (beta, way faster, still intelligent enough), and what about
things like 128 GB?"* The cloud half is `survey.md`. This is the hardware half.

**Sourced, not measured here** (we don't own one). Sources at the bottom.

## What fits, and how fast it generates

| model | size | fits 128 GB? | generation speed (Spark / Ryzen AI Max+ 395) |
|---|---|---|---|
| **gpt-oss-120b** (MXFP4) | 117B MoE, ~5B active, ~63 GB | yes, comfortably | **~35–58 tok/s** |
| Qwen3.5-122B-A10B / GLM-4.x-Air class | ~100–120B MoE | yes | ~25–45 tok/s |
| Qwen3-235B-A22B | 235B MoE | only at **3-bit** | **~11 tok/s** |
| any dense 70B (Q4) | 70B | yes | **~5 tok/s** |
| Nemotron-Ultra-550B, DeepSeek-671B, Kimi K3 | ≥ 550B | **no** | — (need 512 GB+, e.g. Mac Studio M3 Ultra 512 GB, ~$10k) |

## What a user would feel — the agent loop, not the benchmark

A message is 2–4 model calls. Each call re-reads a system prompt of several thousand tokens (the
whole week is in it) and writes ~200–400 tokens. So **prompt-processing speed matters as much as
generation speed**, and that is where the boxes differ:

| box | prompt processing | one call (~4k in / 300 out) | 3-step message |
|---|---|---|---|
| **DGX Spark** (~$3–4k) | ~1,700 tok/s | ~2.5 s + ~6 s ≈ **8–9 s** | **~25 s** (less with prompt-cache reuse between steps) |
| Ryzen AI Max+ 395 (~$2k) | ~340 tok/s | ~12 s + ~6 s ≈ **18 s** | **~55 s** |
| Mac Studio M4 Max 128 GB (~$3.5k) | between the two | faster decode (546 GB/s) | ~30–40 s |

For gpt-oss-120b. A 235B-at-3-bit model roughly triples these.

## The answer

- **The ceiling on 128 GB is the gpt-oss-120b class** at conversational speed. Anything bigger is
  either 3-bit and slow (235B) or does not fit (≥ 550B).
- **That same class is served free in the cloud** — Groq runs gpt-oss-120b at hundreds of tok/s, an
  order of magnitude faster than any of these boxes. So a 128 GB machine buys **privacy and offline
  use, not more intelligence or more speed**.
- **If one is ever bought for this app, the DGX Spark is the one**: our prompts are long, and its
  prompt processing is ~5× the AMD box's.
- **First, measure whether 120B is smart enough** — the free cloud eval answers that before any
  money is spent (needs the free Groq or OpenRouter key in `OWNER-TODO.md`). The desktop's own
  4×2070 experiment (32 GB, a 30B model) is still the free local option (`docs/v1/03-kimi-decision.md` §3).

## Sources

- gpt-oss-120b on DGX Spark, llama.cpp: https://github.com/ggml-org/llama.cpp/discussions/16578
- Spark vs Ryzen AI Max+ 395 (generation 38.6 vs 34.1 tok/s; prompt 1,723 vs 340 tok/s): https://memeburn.com/dgx-spark-vs-ryzen-ai-max-395-is-nvidia-worth-the-premium/
- Strix Halo measured speeds (gpt-oss-120b ~53–56 tok/s): https://github.com/hogeheer499-commits/strix-halo-guide
- Strix Halo dense vs MoE (70B ~5 tok/s, Qwen3-235B Q3 ~11 tok/s): https://datahardware.ai/blog/strix-halo-tokens-per-second-2026 · https://runaihome.com/blog/best-local-llm-128gb-unified-memory-2026/
- Bandwidth comparison (M3 Ultra 819 GB/s vs Spark 273 GB/s): https://localaimaster.com/blog/dgx-spark-vs-strix-halo-vs-mac-studio · https://tech-insider.org/dgx-spark-vs-mac-studio-2026/
