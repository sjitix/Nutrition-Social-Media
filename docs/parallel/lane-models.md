# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-03 — the big-model search, and a read-tool fix for v1 to land.**

Owner's mandate: find **the largest model that is free, fast enough, and can do everything the
assistant needs** (decide, use every app function, write like a nutritionist). **`gpt-oss-20b` is only
a control now** — the owner judged 20B too small for the job; every comparison runs on big models.

Branches (both on GitHub): **`models`** (worktree `../NutriFlow-models`) ships my own paths onto main;
**`models-exp`** (worktree `../NutriFlow-models-exp`) holds experiments in v1-owned files — reviewed
by v1, never merged without it.

Done so far:
1. Round-1 survey of NVIDIA free (`docs/models/survey.md`): only 6 of 42 chat models answer; the one big
   one is **Nemotron-3-Ultra-550B** — 82% on the 45 hard cases, `trustworthy` (0 infra), decline 5/6
   (honest) but clarify 4/7 (over-acts on feelings); latency a 7–46 s queue lottery.
2. **Loop-level eval built** (`scripts/models/loop-eval.mts`): drives the production loop, scores
   engine-verified outcomes, steps, read-before-write and seconds per message. gpt-oss-20b control:
   9/14, median 7.3 s/message, **read-before-write 0/2**.
3. **Found: the loop can never use its read tools** — they're in neither the turn schema nor the
   prompt, and the prompt never explains the loop. v1 confirmed and will land the fix. Prototype on
   `models-exp`; before/after on Nemotron-Ultra-550B + the engine gate running now.
4. The 128 GB answer (below, "Answers to other lanes").

5. **v1 reviewed the diff** and caught a BLOCKING safety issue in my draft prompt (it steered models
   away from `symptom`, the only path to the crisis guard until C2) — fixed in `5336ab1`, with two
   safety rows added to the loop eval. v1 also added `actedRightV2` to the hard-case eval on my report
   that the old grading penalised `remember`/`answer` on hold cases.
6. `models-exp` merged with main (`d3d0a18`): the landing diff is exactly `primitives.ts`, `promptV2.ts`,
   `ai.ts` (+79/−10); check-boundaries clean, tsc clean. Final before/after + gate running, then v8 in
   LM Studio (old vs new prompt), then "ready to land" to v1.
7. Local `qwen3-30b-a3b` on the desktop's single 2070: 8.5 s/call — as fast as cloud 20B; loop eval
   running. Lightning-30B ruled out (chain of thought leaks). GLM-5.3 69% with 10/45 unparseable.

Next: the free-key providers (Groq gpt-oss-120b, OpenRouter Qwen3-235B, GitHub Models GPT-4.1/
Llama-4, Gemini Flash) the moment the owner adds any key (`docs/models/OWNER-TODO.md`); until then,
everything big that NVIDIA serves free (GLM-5.3 eval running).

## Files I'm editing right now

*(v1 and accounts agents: all in my worktree / my owned areas — nothing of yours)*

- `docs/models/**` (new — research, benchmarks, decisions) · `scripts/models/**` (new — eval tooling) ·
  `data/eval-runs/**` (scorecards; timestamped, conflict-free) · this lane file.

## What this lane owns

`docs/models/**`, `docs/parallel/lane-models.md`, `docs/worklog/*-models.md`, `scripts/models/**`, and
`data/eval-runs/**` (primary writer; every file timestamped so no two lanes collide).

## Heads-up for the other lanes

- **I RUN `scripts/eval-hardcases.mts` but do not edit it** (it's v1's). If I need a change to the eval
  harness, `promptV2.ts`, `ai.ts`, or `agentLoop.ts` (all v1's) to land a model/prompt improvement on
  `main`, **I ask the v1 agent first** and wait.
- **I touch no accounts files.** The model brain lives entirely behind the provider abstraction
  (`ai.ts`), so a model choice is a one-line `.env`/provider change — no call-site churn, the same way
  accounts sit behind `storage.ts`.
- **Experiments run on branch `models`**; only finished deliverables (scorecards, decision docs,
  reusable tooling) ship onto `main`.

## Answers to other lanes

- **v1 asked (relaying the owner's 2026-09-19 board comment): "what's the maximum agent on cloud, and
  what about 128 GB?"** — Cloud: `docs/models/survey.md`. 128 GB: `docs/models/hardware-128gb.md`.
  Short form: a 128 GB box tops out at the **gpt-oss-120b class** at conversational speed (~35–58 tok/s;
  Qwen3-235B only at 3-bit, ~11 tok/s; dense 70B ~5 tok/s; ≥550B doesn't fit). Groq serves that same
  class free and an order of magnitude faster, so a 128 GB box buys privacy/offline, not intelligence.
  If bought: DGX Spark (~5× the AMD box's prompt processing, which dominates our long prompts).

## Asks of the other lanes

*(none open yet. Likely soon: ask v1 to apply the over-act prompt fix to `promptV2.ts` once proven on
my branch.)*

## Shipped

| sha | what |
|---|---|
| `3565e71` | lane set up: this file, the CONTEXT block, the README lane row, the owner to-do |
| (this) | round 1 survey: `scripts/models/latency-sweep.mjs`, its scorecard, `docs/models/survey.md` — the free NVIDIA tier serves only one big model (Nemotron-Ultra-550B) and its latency is a 7–46 s queue lottery |
