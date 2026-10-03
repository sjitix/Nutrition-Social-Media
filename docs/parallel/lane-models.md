# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-03 (afternoon) — the big-model search, and the read-tool fix ready for v1 to land.**

Owner's mandate: find **the largest model that is free, fast enough, and can do everything the
assistant needs**. Owner, 2026-10-03: "work with the bigger models first, like the 550B". So the
**Nemotron-3-Ultra-550B gets the NVIDIA tier first**, one run at a time (the free tier's rate limit
voids parallel runs). gpt-oss-20b runs only on the local GPU, as the regression check v1 asked for.

Branches: **`models`** (worktree `../NutriFlow-models`) ships my own paths onto main; **`models-exp`**
(worktree `../NutriFlow-models-exp`) holds the prompt/schema change in v1-owned files, reviewed by v1;
**`models-exp-date`** adds "today is Monday (2026-10-05)" to the prompt (not yet measured, offered after).

Where it stands (details and every number: `docs/models/survey.md`, Round 4):
1. **Read-tool fix**: `models-exp` `543bcb2`, 3 files vs main (`primitives.ts`, `promptV2.ts`, `ai.ts`).
   550B hard cases 84 -> 96% (v2). gpt-oss-20b 80–84 -> 91–96%. Engine gate 680/0 on `7298a28`; the
   gate on `543bcb2` is running. "Ready to land" goes to v1 once `543bcb2` is measured.
2. **The single-turn ruler no longer separates a 20B from a 550B.** New instrument:
   `scripts/models/convo-eval.mts` (14 two-turn conversations). It runs on the 550B next, then
   gpt-oss-20b locally.
3. **Three engine bugs found by grading what the engine did, not what the model sent**: slot-scoped
   constrain is a silent no-op (and the reply claims success), a remembered allergy is not enforced,
   and a day-scoped constrain drops `exclude`. Reported; v1 is fixing all three. The prompt stopped
   teaching the slot form.
4. Proposal for v1's ruler: `scripts/models/regrade-hardcases.mjs` (v3 = DO counts only if the engine
   changed something).
5. Big models reachable for free today: the 550B (best; 17–22 s median per message), GLM-5.3 (25–90 s
   per call), Kimi K3 (slow queue). Everything else big is 404, times out, or is keyless-OVH blocked.
   The fast big options (Groq/OVH gpt-oss-120b, Gemini Flash) need a free key: `docs/models/OWNER-TODO.md`.

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

- **v1: land the read-tool fix** (`models-exp`, 3 files). The "ready to land" message, with ranges,
  follows once `543bcb2` is measured. Agreed by v1 in principle.
- **v1: the three engine fixes** (remembered allergy enforced, slot-scoped constrain says "nothing
  changed", day scope passes `exclude`/`use`). Accepted by v1 2026-10-03, in progress. I merge the shas
  into `models-exp` when they land.
- **v1, optional: the v3 ruler** (`scripts/models/regrade-hardcases.mjs`), for v1 to decide.

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
| (this) | Round 4 in the survey; the v3 regrade proposal; eval rows record operation arguments |
