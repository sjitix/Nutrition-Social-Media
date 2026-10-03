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

`data/eval-runs/latency-diary-2026-10-03.jsonl`: 87 probes from morning to late afternoon (short prompt,
2,000-token cap; the cap was raised from 400 after reasoning models returned empty content).

| model | answered | median | p90 | note |
|---|---|---|---|---|
| gpt-oss-20b | 25/25 | 7.3 s | 13.7 s | the only model that answered every time |
| Nemotron-3-Ultra-550B | 4/12 | 7.6 s | 14.0 s | 8 of 12 hit the rate limit while evals ran; pulled from the diary at midday to protect the evals |
| Kimi K3 (2.8T) | 11/25 | 67 s | 96 s | better than September's ~250 s, still not a chat brain |
| GLM-5.3 | 17/25 | 89 s | 141 s | a reasoning model; slow all day |

The diary was stopped at 16:40 so that every free-tier request went to the 550B runs.

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
- `offer-accept` was a false miss, so read its score as **12/14**. The engine's symptom note made the
  offer ("I can rebuild your week around vitamin D if you'd like"), and the 550B's "yes please" →
  boost vitamin D was right; my check only looked for a "?". The check is fixed. v1 also gave the
  note's other branch (all nutrients adequate) an offer of its own.

**The date line (`models-exp-date`, "Today is Monday (2026-10-05)…").** The plan is keyed by weekday
names, and the prompt never said which one is today, so even the 550B asked "which day is today?".
550B, same scenarios, one run at a time:
- `log-today` ("i already smashed a big burger and fries for lunch today"): logged it **3/3 with the
  line**, **0/4 without**.
- `log-then-tonight` (convo): both turns right with it (logged the pizza, lightened Monday's dinner);
  asked "which day?" twice without it.
- `eat-out-future` flips between `reserve` and `resize` in both arms (1/3 with the line, 2/4 without),
  so that is the model's own variance and a prompt-wording item, not the date line.

**Other big models, re-checked:** NVIDIA lists 80 models. Of the 10 big ones not yet measured, 8 return
404 (listed, not served) and DeepSeek-V4.1-Flash and Gemma-4-31B time out at 180 s with a 2,000-token
budget (`2026-10-03T11-44-15-latency-sweep.json`). **Keyless OVH has blocked this IP on every model**
(gpt-oss-120b, Llama-3.3-70B, Qwen3.5-397B, Mistral-Small) for 3+ hours after the morning's burst, so
the anonymous tier is unusable for evaluation; a free OVH key (400 req/min) stays top of the owner's to-do.

## Where "big and fast" actually lives: the verified search (2026-10-03)

A 25-agent search read every free provider's own pricing and rate-limit pages. Full report:
`free-providers-2026-10.md`. **No provider today gives a big model, ~5 s calls, a free tier AND hundreds
of calls a day all at once.** The shortlist, as the owner's to-do ranks it:

| option | model | why it's on the list | the catch |
|---|---|---|---|
| Vercel AI Gateway, $0 model | Ling 3.1 Flash, 560B / 25B active | biggest free model with no token cap; reasoning can be set to "none"; ~8 s est. | rate limit unpublished; possible card check |
| Mistral free plan | Mistral Large 3, 675B / 41B active | strongest; schema-enforced JSON; ~6 s | ~90 calls a day: evals, not a beta |
| Groq free | gpt-oss-120b | fastest (~1.5–3 s), strict JSON schema | ~25–40 of our calls a day |
| OpenRouter + one-time $10 | dots-3-note-preview 280B, Inkling 975B | 1,000 requests a day | preview models can vanish; speed unknown |
| OVH Public Cloud ($200 new-project credit) | gpt-oss-120b, Qwen3.5-397B | measured 3.4 s, 400 req/min | needs a card |

Corrected beliefs: GitHub Models was retired on 2026-07-30; an OVH key is not free by itself; Groq's free
tier is token-capped, not "~1,000 requests a day"; Nemotron-3-Super-120B reached end of life on NVIDIA
this morning (410 Gone).

Until a key lands, the 550B on NVIDIA stays the quality baseline. The speed work runs against it:
reasoning off and skipping the loop's wasted last call (Round 5, below).

## Round 5 — making the big model faster (2026-10-03, in progress)

The owner asked how developers make a big model faster. `scripts/models/latency-anatomy.mts` streamed 16
real calls (the agent prompt, ~3,000 tokens) to the 550B and split each into its parts
(`2026-10-03T13-07-25-anatomy-…ultra-550b.json`):

| request variant | valid calls | seconds per call | output tokens (median) |
|---|---|---|---|
| as the app sends it (reasoning on) | 4/4 | 8.1 – 36.3 | 740 |
| "keep thinking to one sentence" | 4/4 | 9.6 – 53.2 | 277 |
| reasoning off (`chat_template_kwargs: {enable_thinking: false}`) | 2/4 | 4.3, 31.2 | 139 |

- **Reading the prompt is not the cost.** First token arrives in ~0.7 s (median).
- **Writing is.** Hidden reasoning makes the 550B write ~5× more tokens than its answer needs.
- **The free host writes them at 4–62 tok/s**, call to call, which no request setting can fix.

Expected per call at a typical ~30 tok/s: ~25 s with reasoning, ~5 s without.

Two eval-side experiments test whether the speed costs quality. Neither changes app code:
- **reasoning off**, injected by `pace-proxy.mjs` (`INJECT`);
- **fast finish**, a ModelFn wrapper (`fast-finish.ts`) that skips the loop's last call when the engine's
  notes will be the reply anyway. Local smoke test: 2 → 1.33 model calls per message.

**Reasoning on vs off, same code (date-line prompt), 550B:**

| eval | reasoning on | reasoning off |
|---|---|---|
| loop (26 scenarios) | **23/25** (1 infra) · median **24.8 s** per message · p90 58 · max 90 | 21/26 · median **14.5 s** · p90 28 · max 56 |
| conversation (14 × 2 turns) | 11/14 · 0 false claims · median 22.7 s per turn | 11/14 · **2 false claims** · ~4.7 s per call (its per-turn seconds include proxy pacing and are not quoted) |

Reasoning off answers ~40% sooner and halves the worst case, but it is not free. The loop loses 2–3
scenarios:
- a scripted allergy it never excluded;
- "lighter weekend", where the engine re-rolled the days silently (being fixed by v1);
- the crisis reply written without the `symptom` op (covered by C2).

In conversation it twice claimed changes it never made. v1's guard (`361b2e1`, built from this lane's
detector) now nudges and then replaces such replies.

**The deciding run: reasoning off + v1's guard + fast finish** (`2026-10-03T15-49-58-convo-…`), seconds
measured as pure upstream time:

| 550B, 14 conversations | passed | false claims | model calls per turn | median / p90 s per turn |
|---|---|---|---|---|
| reasoning on (today's default) | 11/14 | 0 | ~2 | 22.7 / 73 |
| **reasoning off + guard + fast finish** | **12/14** | **0** | **1.39** | **5.2 / 22** |

The loop eval agrees (`2026-10-03T16-16-14-loop-…`, 26 scenarios):

| 550B | passed | model calls per message | median / p90 / max s per message |
|---|---|---|---|
| reasoning on | 23/25 (1 infra) | ~1.9 | 24.8 / 58 / 90 |
| **reasoning off + guard + fast finish** | **23/26** | **1.31** | **8.4 / 19.9 / 25.1** |

Same quality, ~3× faster at the median, p90 and worst case. The three misses are the long-standing ones:
- a scripted allergy the model never excluded;
- `eat-out-future`, reserve vs resize;
- `rate`, which asks "which days?".
The last two are being tested as a prompt-wording change. **Proposed to v1:** reasoning off as an env-level
request setting (`LOCAL_AI_EXTRA_BODY`), and fast finish inside `runAgent`.

**Wording A/B for the two habitual misses** (pace-proxy `APPEND_SYSTEM`, 550B, reasoning on, 3 runs per
arm). The appended note: "have it more often / loved it / make that a regular" is a RATING (rate 5, don't
swap it into every day, don't ask which days); a reservation / eating out / "save some room" is a
RESERVATION (reserve, not resize).

| | eat-out → `reserve` | "more often" → `rate` |
|---|---|---|
| today's prompt | 1/3 | 0/3 |
| **with the note** | **3/3** | **3/3** |

Next: put the wording inline on the `rate` and `reserve` lines (a branch from main), then run the full
loop and conversation evals to check it moves nothing else, before it goes to v1.

About 4× faster per turn with no loss of quality.
- **The guard earned its place.** On "wednesday too" the model again claimed "Wednesday now has 2000
  kcal…" without acting. The guard nudged it, and it then sent the vegetarian constrain for Wednesday.
- **The two misses were empty constrains** ("shake up the week" and "make my meals bigger" sent with
  nothing to change). v1's `85e684b` now answers those honestly instead of re-solving silently.
- **Free-tier outliers remain.** 25 of 28 turns took 1.5–11 s, and three spiked to 22–43 s.
