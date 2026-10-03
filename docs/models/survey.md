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

**GLM-5.3's first score was the harness's fault.** At a 2,000-token output cap, 10/45 replies didn't
parse — a reasoning model that spent the budget thinking before writing the JSON. Re-run with
`MAX_TOKENS=6000`, same prompt (`2026-10-03T10-58-11-z-ai-glm-5.3.json`): **schemaOk 93%, actedRight
76% (v1) / 82% (v2)**, do 24/27, decline 3/6 → **5/6 under v2** (its declines were `remember`/`answer`
replies the v1 ruler counted as acting), 2/45 infra (so not strictly trustworthy). Same league as the
550B — but at 25–90 s per call while it thinks, it is not a chat brain on this tier. Lesson for every
reasoning model: give it room to think, or you measure the truncation, not the model.

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

## The free tier's rate limit is the real ceiling — and it moves

Same model (Nemotron-3-Ultra-550B), same kind of load, same day:

| when | concurrent requests on the model | calls that never reached it |
|---|---|---|
| morning | ~6 (two hard-case runs + two loop runs) | **0** (45/45, 14/14) |
| midday | ~6 | **20/21** loop scenarios (both arms); **12/45** and **16/45** hard cases even with 6 back-off retries |
| any time | 1 probe with an eval running | instant `429 Too Many Requests` (4/4 probes) |

The void runs are kept as evidence (`variant: VOID — rate-limited`) and never quoted. Two consequences:

1. **For measuring:** big-model evals on this tier must run one at a time, concurrency 1, with long
   back-off — and the loop eval now re-runs scenarios that never reached the model.
2. **For the product:** the app's adapter (`ai.ts`) gives up after ~12 s of 429s, so a beta on this
   tier's 550B model would show "assistant offline" to a handful of simultaneous users. Reported to the
   v1 lane. The free tier is fine for *measuring* a big model's quality; it is not a production brain.

**Latency must come from the real loop, not a sweep.** The sweep's short prompt flatters every model:
local Qwen3-30B was 8.5 s per call in the sweep but 27–102 s per *message* in the loop, because the real
system prompt carries the whole week (thousands of tokens) and reading it dominates on one 8 GB card.
Only per-message seconds from `loop-eval` count as response time.

## Round 3 — OVHcloud AI Endpoints, keyless (found 2026-10-03)

A real European cloud with an **anonymous free tier — no key, no signup**: 2 requests/min per IP per
model (400/min with a key). It serves the biggest open models any free tier offers today:
`Qwen3.5-397B-A17B`, `gpt-oss-120b`, `Meta-Llama-3.3-70B-Instruct`, `Qwen2.5-VL-72B`,
`Qwen3.6/3.8-27B`, `Mistral-Small-3.2-24B`. Single calls, short prompt
(`2026-10-03T10-39-37-latency-sweep.json`):

| model | params | per call |
|---|---|---|
| Mistral-Small-3.2-24B | 24B dense | 1.7 s |
| **Llama-3.3-70B** | 70B dense | **2.7 s** |
| **gpt-oss-120b** | 117B MoE | **3.4 s** |
| Qwen3.8-27B | 27B dense | 5.2 s |
| **Qwen3.5-397B-A17B** | 397B MoE | rate-limited before it answered |

**These are the fastest big models measured all day** — 120B in 3.4 s is ~5× quicker per call than the
550B on NVIDIA. But the anonymous tier **punishes a burst for far longer than "2/min"**: after the
six-model sweep this IP got `429` on every attempt for 8+ minutes, even paced 45–95 s apart
(`pace-proxy-2026-10-03.jsonl`). So keyless OVH is good for occasional calls, not for a 45-case eval or
a beta. **With a free OVH account key the limit is 400/min** — on the owner's to-do. The pacing proxy
(`scripts/models/pace-proxy.mjs`) is ready for it: one call at a time, rate-limit answers (OVH returns
them as HTTP 200 with an error body, which both evals would otherwise grade as a bad model reply)
retried rather than passed on, and pure upstream seconds exposed so pacing never counts as latency.

## Round 2b — local Qwen3-30B, through the real loop

`2026-10-03T10-52-40-loop-qwen-qwen3-30b-a3b-2507.json` (main's prompt, 26 scenarios): **13/26 (50%)**,
holds 4/10, read-before-write 0/2, **median 50 s per message, p90 102 s, worst 796 s** (looped 8
steps). On one 8 GB card the real prompt's length dominates; not a chat brain on this hardware. The
same run with the read-tool fix is in progress.

## Round 4 — the prompt was the bottleneck, and the ruler stopped separating sizes (2026-10-03 afternoon)

45 hard cases, temperature 0, **0 infra on every row**; a range means repeated identical runs.

| model | prompt | v1 | v2 | v3* | runs |
|---|---|---|---|---|---|
| Nemotron-3-Ultra-550B (NVIDIA) | main | 73–82% | 84% | 80–82% | 2 |
| Nemotron-3-Ultra-550B | read-tool fix (`62c4617`) | 84–87% | **96%** | **93%** | 2 |
| gpt-oss-20b (local) | main | 80–84% | 80–84% | 78% | 2 |
| gpt-oss-20b | `62c4617` | 89% | **96%** | 91% | 1 |
| gpt-oss-20b | `7298a28` (+ verbatim-symptom line) | 82% | 91% | 87% | 1 (repeat running) |
| v8 (1.5B fine-tune, local) | main | 73% | 80% | 73% | 1 |
| v8 | `62c4617` | 67% | 76% | 73% | 1 |

\*v3 is stricter and only a proposal (`scripts/models/regrade-hardcases.mjs`): a DO case that should
change something counts only if the **engine** changed something. v1/v2 count any emitted operation.

**Read:**
1. **The prompt was the bottleneck.** Fixing it lifted the 550B 84 → 96 (v2) and gpt-oss-20b
   80–84 → 91–96. The 1.5B fine-tune, trained on the old prompt, does not benefit (flat under v3).
2. **On this ruler the 20B now ties the 550B**, so it can no longer answer "is a bigger brain worth its
   seconds". Under v3 the 550B still leads (93 vs 87–91). The instrument for that question is now
   `scripts/models/convo-eval.mts`: 14 two-turn conversations (follow-through, memory across turns,
   "wednesday too", decline-then-alternative, a crisis mid-conversation), state carried between turns
   the way the client carries it.
3. **Grading the engine's effect rather than the model's operations found three engine bugs**, all
   now being fixed by v1. A slot-scoped `constrain` was a silent no-op, and the user was told it
   worked: `per-slot-protein` was "right" for nearly every model while nothing moved. A remembered
   allergy did not bind the engine. A day-scoped `constrain` dropped `exclude`. The prompt no longer
   teaches the slot form (`models-exp` `543bcb2`).

**Loop eval, 550B** (26 scenarios, one at a time): main prompt **22/26**, read-before-write 0/2,
median 22 s per message. With the fix: misses `memory-allergy` (sent `remember` + `constrain` but no
`exclude`, which is bug 2 above) and `distress-crisis` (no `symptom` op). The crisis case is covered in
production by v1's C2 pre-scan, which answers before any model runs.

**Conversation eval: this is where size shows** (`convo-eval.mts`, 14 two-turn conversations, 0 infra):

| model | prompt | conversations | second turns | median / p90 s per turn |
|---|---|---|---|---|
| **Nemotron-3-Ultra-550B** | `543bcb2` (landing) | **11/14 (79%)** | 12/14 | 21.6 / 102 |
| Nemotron-3-Ultra-550B | main | 7/14 (50%) | 9/14 | 27.1 / 73 |
| gpt-oss-20b (local) | `543bcb2` | 6/14 (43%) | 7/14 | 13.9 / 27 |
| gpt-oss-20b (local) | main | 6/14 (43%) | 7/14 | 14.2 / 35 |

The prompt lifts the big model 50 → 79% and does nothing for the 20B. The 20B's misses are the kind a
user would not forgive:
- it swapped in a literal `"<name from result>"`;
- it answered "Happy to help." to "let's go with 1700 calories" and changed nothing;
- it stored "keep Sunday's dinner exactly as it is" as a memory note instead of pinning it;
- it sent a pizza lunch through `symptom`;
- it resized Sunday for "tonight" on a Monday.

The 550B's misses are mild:
- "fish or shellfish?" when the allergy already settled it;
- "which day is today?" twice, which `models-exp-date` fixes;
- an offer swallowed by the engine. The symptom note replaces the model's reply, and it ends without a
  question unless a nutrient is low. Reported to v1.

**Other big models, re-checked:** NVIDIA lists 80 models. Of the 10 big ones not yet measured, 8 return
404 (listed, not served) and DeepSeek-V4.1-Flash and Gemma-4-31B time out at 180 s with a 2,000-token
budget (`2026-10-03T11-44-15-latency-sweep.json`). **Keyless OVH has blocked this IP on every model**
(gpt-oss-120b, Llama-3.3-70B, Qwen3.5-397B, Mistral-Small) for 3+ hours after the morning's burst, so
the anonymous tier is unusable for evaluation; a free OVH key (400 req/min) stays top of the owner's to-do.

## Where "big and fast" actually lives (researched 2026-10-03, not yet measured)

| provider | free? | what it would unlock |
|---|---|---|
| **Google AI Studio** | permanent free tier, no card | Gemini Flash family (frontier-class) + Gemma 4, OpenAI-compatible endpoint, ~1,000+ req/day on Flash; Pro left the free tier in Apr 2026 |
| **Groq** | free, no card | `gpt-oss-120b` and other large open models at hundreds of tok/s; tight daily caps (~1,000 req/day on the 120B) |
| **Cerebras** | $5 trial with a card since Jul 2026 | `gpt-oss-120b`, GLM, Qwen-3-235B at 2,000+ tok/s |

Keys for the first two are free and in `OWNER-TODO.md`. The moment one lands, the same sweep and the
same 45-case eval run against it.
