# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-18 — resumed on the LAPTOP.** The worktrees `../NutriFlow-models/` and
`../NutriFlow-models-exp/` now exist here (created today from `origin/models` / `origin/models-exp`, both
brought up to `origin/main`), with `node_modules` junctioned to the main folder's. **Every esbuild bundle
from this lane goes to an outfile named `models-*`** (the `.cache` is shared through the junction).

**Blocked: there is no `.env.local` on the laptop** (checked in all five folders, and no key in the
environment; LM Studio is not running either). So every model run waits for the owner to recreate the
file in the main folder. v1 keeps holding the fast finish until the fair numbers exist.

Done today, key-free (`be98c57`):
- **`scripts/models` imports only the folder barrels.** The old-path shims can go from this lane's side.
  Behaviour-neutral: the bundles hold the same lines, and the stub runs wrote identical rows.
- **`stub-model.mjs`, a fake model server** (`--mode nothing|hollow|garbage`). It found two free passes
  in this lane's evals, both closed (see the heads-up). Every mode now scores 0 on both evals.
- **v1's `5c12c4c` re-checked model-free** (`probe-fixes.mts`): 1/4 against the code before the fix
  (both bugs reproduce), 4/4 after.

**Ready for the key: `scripts/models/fair-arms.mjs`**, one command for the fair arms. It bundles each
eval once from one commit and refuses a dirty tree. It runs one arm at a time, round-robin across
repeats, with a cool-down, and clears every inherited knob. It writes a manifest after each arm. It reads
the key from the main `.env.local` itself (exit 3 without it), so the key never reaches a command line.
Tested end to end against the stub: 10 runs, every arm exactly its definition, no key text in any output.

**The held-out wording test is ready too.** `models-wording` is now main plus exactly its three prompt
lines (`e078efd`), with a worktree at `../NutriFlow-models-wording`. The third line ("lighter on <days>"
= resize) had no held-out paraphrase, so `days-lighter-heldout` was added ("go easy on the portions
thursday and friday"). The stub's new `script` mode is the positive control: all 6 scenarios of the
test pass the answer they reward, and fail do-nothing. The bare day constrain fails both lighter checks.

Next once a key exists:
1. The fair arms, ALL on one bundle: loop A, B, C, convo A, C. **Arm A is re-run.** The 10-03 one
   (21/26, median 23.3 s) ran 26 scenarios on an older bundle (29 today), before `5c12c4c` changed the
   loop.
2. The held-out wording test: main vs `models-wording` (re-merge main first if it has moved).
3. The fair numbers to v1.

On main from this lane (via v1): the read-tool fix (`3392461`), the date line (`4f53468`), the
false-claim guard (`361b2e1`), `LOCAL_AI_EXTRA_BODY` (`45a0c12`), three engine fixes (`98747f6`,
`85e684b`), and the fixes for this lane's two product bugs (`5c12c4c`, 2026-10-18).

Branches: `models` (ships my paths onto main). `models-exp` = main + merges, for experiments.
`models-wording` holds 3 prompt lines, not ready to land. `models-exp-date` is retired (landed).

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
- **Experiments run on branch `models-exp`**; only finished deliverables (scorecards, decision docs,
  reusable tooling) ship onto `main`, from branch `models`.
- **v1: my hold checks key on `AgentRunResult.falseClaimCaught`** (since `be98c57`). A hold whose reply
  the guard rewrote is a fail, because the user read a canned line, not an answer. If how that flag is
  computed changes, tell me first (agreed 2026-10-18).
- **v1: this lane imports only the folder barrels** (since `be98c57`). A name I need is in a barrel's
  `index.ts`, never a deep path; if a barrel narrows, `tsconfig.scripts.json` will show it in my files.

## Answers to other lanes

- **v1 asked (relaying the owner's 2026-09-19 board comment): "what's the maximum agent on cloud, and
  what about 128 GB?"** — Cloud: `docs/models/survey.md`. 128 GB: `docs/models/hardware-128gb.md`.
  Short form: a 128 GB box tops out at the **gpt-oss-120b class** at conversational speed (~35–58 tok/s;
  Qwen3-235B only at 3-bit, ~11 tok/s; dense 70B ~5 tok/s; ≥550B doesn't fit). Groq serves that same
  class free and an order of magnitude faster, so a 128 GB box buys privacy/offline, not intelligence.
  If bought: DGX Spark (~5× the AMD box's prompt processing, which dominates our long prompts).

## Asks of the other lanes

- **v1:**
  - **NEW 2026-10-18, a safety fix for `primitives.ts` (yours): a remembered allergy is enforced only
    when the model labels it `kind:"allergy"`.** `kind` is optional and the prompt never says it matters.
    - Replaying gpt-oss-20b's recorded `{op:"remember", fact:"allergic to shellfish"}` (no kind) through
      the conversation eval on today's main leaves Shrimp & Tomato Rice in the week.
    - `probe-allergy-labels.mts`, model-free, 7/12 on main. "has coeliac disease" as `condition` leaves
      9/9 gluten meals; "lactose intolerant" as `condition` leaves 7/7 lactose meals.
    - **The patch is `49385e5` on `models-exp`:** a fact with an explicit allergy, intolerance or coeliac
      cue binds the engine whatever its label. Unlabelled, only food words count; with no cue the fact is
      never parsed (the parser alone reads "a high-protein snack" as a "protein" allergy).
    - Patched: 12/12, and the replay passes 2/2. It errs toward excluding ("my son is allergic to eggs").
  - **Fast finish in `runAgent`, with the reply rule.** Accepted; held for the fair numbers (above).
    The reply rule withheld 0 skips in both evals.
  - ~~Two product bugs~~ (a Wed–Sun swap replaced all seven days; a claim paired with `remember` got
    through). **Fixed by v1 in `5c12c4c`**, re-checked here model-free (1/4 before, 4/4 after).
  - **One row v1 asked for:** a bare day constrain used for "lighter weekend".
  - **The wording branch.** Offered only after the held-out test.
  - ~~D5a part 3 (barrels)~~. **Done on this side, `be98c57`**: `scripts/models` uses only the
    barrels. v1 removes the shims after the accounts lane's files and v1's own scripts move.
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
| `6cae798` · `961315a` | shutdown 2026-10-03: worklog, CONTEXT resume steps, lane file, last scorecards |
| `627fe56` | 2026-10-18: resumed on the laptop; worktrees created; the NVIDIA runs blocked on a missing `.env.local` |
| `be98c57` | barrels only; `stub-model.mjs` (two free passes found and closed, no past score changed); `probe-fixes.mts` (v1's `5c12c4c`: 1/4 before, 4/4 after) |
| `07fad2b` · `77c9dc7` | the fair re-measurement re-runs arm A (old arm A is a different bundle); `fair-arms.mjs`, the fair comparison as one command |
| `e078efd` (branch `models-wording`) | the wording branch merged with main: main + exactly its 3 prompt lines |
| `0fdfba1` | `days-lighter-heldout` (the third line's held-out paraphrase); the stub's `script` mode, the positive control: all 6 held-out-test checks pass the answer they reward |
| `49385e5` (branch `models-exp`) | the allergy-label patch for v1: a fact that says allergy binds the engine whatever its label (probe 7/12 → 12/12) |
