# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-03 — lane set up; starting the model survey + latency/quality sweep.**

Owner's mandate: find the best LLM brain for the assistant — a **high-parameter** model (cloud is fine
for beta) that behaves like a real personal nutritionist: strong language generation, general
intelligence, uses all the app's functions, decides well — and has a **reliable response time**.
Measure quality AND latency, on a parallel branch, continuously. Starting point is the Kimi K3 verdict
(`docs/v1/03-kimi-decision.md`): K3 is too slow on the free tier and over-acts; `gpt-oss-20b` is the
84% baseline and fast (~2.8s). So the question is open — which model clears the bar on BOTH axes.

In order:
1. Survey high-parameter models reachable for free/cheap (NVIDIA NIM first — I have the owner's key);
   measure per-call latency for each.
2. Run the hard-case eval against the viable ones; compare quality to the 84% gpt-oss baseline.
3. Build the **loop-level eval** (`03-kimi-decision.md §6`) — single-turn scores miss whether the model
   reads before it writes / stops vs burns 8 steps, which is what the product actually depends on.
4. The over-act prompt fix (`promptV2.ts` is v1's — prototype on my branch, then ask v1 to land it).

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

## Asks of the other lanes

*(none open yet. Likely soon: ask v1 to apply the over-act prompt fix to `promptV2.ts` once proven on
my branch.)*

## Shipped

| sha | what |
|---|---|
| `3565e71` | lane set up: this file, the CONTEXT block, the README lane row, the owner to-do |
| (this) | round 1 survey: `scripts/models/latency-sweep.mjs`, its scorecard, `docs/models/survey.md` — the free NVIDIA tier serves only one big model (Nemotron-Ultra-550B) and its latency is a 7–46 s queue lottery |
