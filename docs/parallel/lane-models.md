# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-03, 22:30 — SHUT DOWN for the night. Nothing is running.** Resume steps are in `CONTEXT.md`
(models block) and `docs/worklog/2026-10-03-models.md`.

On main from this lane (landed by v1): the read-tool fix (`3392461`), the date line (`4f53468`), the
false-claim guard built from this lane's detector (`361b2e1`), `LOCAL_AI_EXTRA_BODY` (`45a0c12`), and
three engine fixes (`98747f6`, `85e684b`).

Next, in order:
1. **The fair re-measurement.** Arms B (reasoning off), C (off + fast finish, reply rule) and conversation
   arms A and C. Same commit, wall clock, one at a time. Arm A is done: reasoning on, 21/26, median 23.3 s.
2. **The held-out wording test** for branch `models-wording` (eb6e7d0). It must fix phrasings the
   wording doesn't quote.
3. **Fair numbers to v1.** v1 holds fast finish (change 2) until then.

Branches: `models` (ships my paths onto main). `models-exp` equals main, so new experiments start there.
`models-wording` holds 2 prompt lines, not ready to land. `models-exp-date` is retired (landed).

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

- **v1:**
  - **Fast finish in `runAgent`, with the reply rule.** Accepted; held for the fair numbers (above).
    The reply rule withheld 0 skips in both evals.
  - **Two product bugs, probed and sent 2026-10-03:**
    - a swap with `days` Wed–Sun replaces all seven days;
    - the false-claim guard misses a claim paired with `remember` (profileChanged true).
  - **One row v1 asked for:** a bare day constrain used for "lighter weekend".
  - **The wording branch.** Offered only after the held-out test.
  - **D5a part 3** (barrels). This lane switches `scripts/models` imports to `@/lib/assistant` etc.
    once it lands, then tells v1 the shims can go.
- **v1, optional:** the v3 ruler (`scripts/models/regrade-hardcases.mjs`). The review found it counts a
  remember-only reply as "changed"; fix that before proposing.

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
| `909c2aa` … `8160291` | date landed; reasoning on vs off; the guard; the "deciding" runs (claim since withdrawn, see survey Round 5) |
| `e082ee0` · `b5416fd` · `df4d619` | fast-finish reply mode; the wording A/B; APPEND_SYSTEM |
| `aa8c83c` · `fe1c5a7` · `ae9aaf9` · `11e4150` | adversarial-review fixes to the harness; held-out paraphrases; the speed claim marked not established |
| (this) | shutdown: worklog, CONTEXT resume steps, lane file, last scorecards |
