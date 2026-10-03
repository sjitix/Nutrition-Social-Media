# Model survey — what is reachable, how big, how fast, how good

Living record, models lane. Every latency here was **measured** against the live endpoint, never
quoted from a provider page. Raw data: `data/eval-runs/*-latency-sweep.json` and the per-model
hard-case scorecards beside it.

## Round 1 — NVIDIA NIM free tier (2026-10-03)

`scripts/models/latency-sweep.mjs`: every chat model in the catalog, 2 probes each, a realistic
nutritionist request (system prompt + "tired, want more vegetarian, keep protein"), 400-token cap,
90 s timeout. Scorecard: `data/eval-runs/2026-10-03T09-39-51-latency-sweep.json`.

**The free catalog has shrunk.** 80 models listed, 42 chat candidates, **6 answer** for this account.
Almost every large model the tier used to serve now returns 404 for a free account: Nemotron-4-340B,
Llama-3.1-Nemotron-Ultra-253B, Nemotron-70B/51B, Mistral-Large-2, Mixtral-8x22B, Yi-Large, Jamba-1.5,
DBRX, Kimi-K2.6. Kimi K3, DeepSeek-v4.1-flash and Gemma-4-31B are *listed* and accepted but did not
answer within 90 s.

| model | params | median / best per call | reply quality (one probe) |
|---|---|---|---|
| `openai/gpt-oss-20b` | 20B MoE (~3.6B active) | **6.7 s** / 5.6 s | good, concise — the 84% baseline |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 30B MoE (3B active) | 9.6 s / 8.8 s | **leaks its chain of thought into the reply** ("Here's a thinking process: 1. Analyze…") and ran out of tokens doing it — unusable as-is |
| `z-ai/glm-5.3` | very large MoE | 26.5 s / 23.4 s | warm, specific, on-tone — high quality |
| `nvidia/nemotron-3-ultra-550b-a55b` | **550B MoE (55B active)** | 46.4 s / **7.2 s** | excellent — concrete swaps with protein per serving, concise |
| `z-ai/glm-5.3-flash` | — | 87 s / 81 s | good, but the "flash" is not fast here |
| `moonshotai/kimi-k3` | 2.8T MoE | timeout | (known from the K3 decision: ~200–250 s queue) |

Excluded after probing: `nvidia/ising-calibration-1.5-31b` (a quantum-calibration model, not an
assistant), `meta/muse-glimmer-30b` (200 with empty content).

**Read:** the only high-parameter model this tier serves is **Nemotron-3-Ultra-550B**, and its latency
is a queue lottery (7 s to 46 s for the same request). At the agent loop's 2–4 calls per message that
is 15 s on a good draw and over 2 minutes on a bad one. **The free NVIDIA tier cannot deliver "big and
fast" at the same time.** It is still the right place to measure *quality* of big models for free —
the hard-case evals for Ultra-550B, GLM-5.3 and Lightning are running.

### Hard-case scores (45 cases, engine-verified, single turn)

| model | actedRight | do | clarify | refuse | decline | trustworthy | scorecard |
|---|---|---|---|---|---|---|---|
| gpt-oss-20b *(control; Sept, LM Studio)* | 84% | 24/27 | 6/7 | 5/5 | 3/6 | yes | — |
| **Nemotron-3-Ultra-550B** | **82%** | 23/27 | 4/7 | 5/5 | **5/6** | **yes (0 infra)** | `2026-10-03T09-48-24-…ultra-550b….json` |
| Kimi K3 *(2026-10-02)* | ≤78% best case | — | 1/6 | — | ≤4/6 | no (8 infra) | `2026-10-02T22-13-09-moonshotai-kimi-k3.json` |
| GLM-5.3 | 69% | 22/27 | 2/7 | 4/5 | 3/6 | yes (0 infra) — but **schemaOk 35/45** | `2026-10-03T10-00-28-z-ai-glm-5.3.json` |

| Nemotron-3.5-Lightning-30B | 36% | — | — | — | — | yes — but **schemaOk 44%** | `2026-10-03T10-13-20-nvidia-nemotron-3.5-lightning-30b-a3b.json` |

**Nemotron-3.5-Lightning is ruled out:** its chain of thought leaks into the reply (the sweep showed
"Here's a thinking process: 1. Analyze…"), so most replies never parse.

**GLM-5.3 is not yet fairly measured:** 10 of 45 replies didn't parse (a reasoning model that sometimes
spent the budget before writing the JSON, or leaked its `{"thinking"…}` into the text). Where it did
answer, its tone was among the warmest. Needs a format fix (larger output budget / JSON mode) before its
judgement can be compared — on the to-do, behind the models that format cleanly.

**Read:** 27× the parameters does not buy a higher score on this eval. The 550B model is clearly more
*honest* (it declined 5 of 6 unsupported requests instead of faking them — the small model's worst
habit), but it over-acts on feelings (`health-period`, `eating-problem`, `cycle-sync-offer`) the way K3
did. Several of its misses are **the prompt's fault, not the model's**: it answered the quinoa question
and "why oatmeal on Monday" correctly but without the `answer`/`explain` op the contract expects, and
it asked "which day is today?" before logging a meal because **the prompt never tells the model the
date**. The prompt fix being prototyped on `models-exp` targets exactly these.

## Round 2 — local, on the desktop (LM Studio, 1× RTX 2070 8 GB + RAM offload)

| model | params | median / best per call | notes |
|---|---|---|---|
| `qwen/qwen3-30b-a3b-2507` | 30B MoE (3B active) | **8.5 s / 6.5 s** (3/3) | on ONE card with RAM offload — the CLAUDE.md 4-GPU target; free, no queue, no rate limit |
| `meta/llama-3.3-70b` | 70B dense | ~0.58 tok/s (memory `local-70b-inference-speed`) | unusable for chat on this hardware |

Scorecard: `2026-10-03T10-13-11-latency-sweep.json`. **The local 30B is as fast per call as the cloud
20B** and has no queue lottery — a real candidate; its loop eval (before/after the read-tool fix) is
running.

## Latency diary (all day, one probe per model per 10 min)

`data/eval-runs/latency-diary-<date>.jsonl`. First readings: Ultra-550B 7.6 s but also a **429** (my
own concurrent evals pushed the account's rate limit — free-tier headroom is thin); **K3 63 s**, far
better than the ~250 s measured in September, so its free queue has improved. The diary's output cap
was raised 400 → 2000 after reasoning models (GLM, K3) returned empty content at 400.

## Where "big and fast" actually lives (researched 2026-10-03, not yet measured)

| provider | free? | what it would unlock |
|---|---|---|
| **Google AI Studio** | permanent free tier, no card | Gemini Flash family (frontier-class) + Gemma 4, OpenAI-compatible endpoint, ~1,000+ req/day on Flash; Pro left the free tier in Apr 2026 |
| **Groq** | free, no card | `gpt-oss-120b` and other large open models at hundreds of tok/s; tight daily caps (~1,000 req/day on the 120B) |
| **Cerebras** | $5 trial with a card since Jul 2026 | `gpt-oss-120b`, GLM, Qwen-3-235B at 2,000+ tok/s |

Keys for the first two are free and in `OWNER-TODO.md`. The moment one lands, the same sweep and the
same 45-case eval run against it.
