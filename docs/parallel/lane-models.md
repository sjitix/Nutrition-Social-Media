# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-03 (late afternoon) — the read-tool fix (`3392461`) and the date line (`4f53468`) are ON MAIN;
now making the 550B faster and finding a big free host.**

Owner's direction (twice today): big models first; find the biggest free model with an optimal response
time; no more effort on 20–30B. Memory: `big-hosted-model-first`.

1. **Landed:** the read-tool fix and prompt work (`3392461`, applied by v1 from `models-exp` 543bcb2).
   v1's engine fixes for the three bugs this lane found (`98747f6`).
2. **Landed:** the date line (`4f53468`, from `models-exp-date` 3c30e90, now retired). 550B logs "today"
   3/3 with it, 0/4 without. v1 follows up with the browser's local date instead of UTC.
   `models-exp` equals main; new prompt experiments branch from there.
3. **The conversation eval decides model size.** 550B 12/14 (corrected), 20B 6/14 with either prompt.
4. **Free-provider search (25 agents, verified):** no free tier gives big + fast + volume at once.
   Report: `docs/models/free-providers-2026-10.md`. The owner's to-do is rewritten and ranked: Vercel AI
   Gateway's $0 Ling 3.1 Flash (560B) first. GitHub Models is retired; an OVH key is not free by itself.
5. **Speed, in progress:** the 550B's time is writing, not reading. Hidden reasoning means ~5× the tokens,
   on a host that writes at 4–62 tok/s. Running now on the 550B: conversation and loop evals with reasoning
   on vs off, then off plus "fast finish" (skip the loop's last call when the engine's notes are the reply).
   Both are eval-side only: a proxy injection and a ModelFn wrapper. Any app change would be v1's, after
   D5a moves `ai.ts` / `promptV2.ts` / `agentLoop.ts` into folders.

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

- **v1, when the numbers are in:** reasoning off for hosts that accept it (one request field in the
  adapter), and an early stop in `runAgent` when the engine's notes are the reply. Proposals with
  numbers, not branches.
- **v1, optional: the v3 ruler** (`scripts/models/regrade-hardcases.mjs`). v1 called it the right ruler;
  I still owe the proposal with a per-case flag.

## Shipped

| sha | what |
|---|---|
| `3565e71` | lane set up: this file, the CONTEXT block, the README lane row, the owner to-do |
| `cc1aadb` | round 1 survey — the free NVIDIA tier can't do "big and fast" at once |
| `189057a` · `2e14433` · `8cd1428` | the loop-level eval, the 550B score, the 128 GB answer, the read-tool fix and its evidence |
| `b7e8296` · `578019c` | the free tier's rate limit is the real ceiling; the hard-case eval swings 9 points with no change, so every score is a range |
| `9649c7d` · `b181d3c` · `7a70eb2` | GLM-5.3 re-measured with room to think; keyless OVH; local Qwen3-30B; Lightning ruled out |
| `b197cec` | the read-tool fix lifts the 550B 84% -> 96%, beyond the noise |
| `e600722` | crisis-phrasing test set for v1's C2 pre-scan |
| `fe21518` · `3a248db` | v8 and gpt-oss-20b old-vs-new prompt; `convo-eval.mts` |
| `3a5d0dc` | Round 4 in the survey; the v3 regrade proposal; eval rows record operation arguments |
| `cf0aff1` · `3ae2b07` | the conversation eval separates sizes (550B 11/14 → 12/14 corrected, 20B 6/14); decisions on record; CONTEXT block |
| `26ef88a` · `6e6f38f` · `48b1cd4` · `f61d653` | speed: latency anatomy (writing, not reading, is the cost), proxy `INJECT`, fast-finish, pacing never counted as latency |
| `d383143` | the date line measured: "today" logged 3/3 with it, 0/4 without |
| `271d03c` | the verified free-provider search; OWNER-TODO rewritten and ranked |
| (this) | lane file brought up to date |
