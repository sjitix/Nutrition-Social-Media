# Lane: models — live status

**Written only by the models agent.** The v1 and accounts agents read it; they do not edit it.
Protocol: [`README.md`](README.md). Worktree: `../NutriFlow-models/`, branch `models`, ships `--onto main`.

---

## Now doing

**2026-10-23 — the review of `0327c45` fixed, and all seven of the diagnosis's harness corrections in; 690
controls hold.**
- **Corrections in:** full replies stored; first-attempt transport failures counted (each re-run's error and the
  whole wait); pin-only and rate-plus-pin controls for `rate` and `rate-heldout`; an offer to choose the
  person's number now fails the weight-goal checks; crisis rows graded on what the person reads, with two held-out
  phrasings the pre-scan misses; an implied reserve (`eat-out-implied`) and a negative (`occasion-cooked-at-home`);
  twins for `pin-then-shake` and `allergy-carry`. Loop 38 scenarios (11 held out), convo 17 (3 held out).
- **Failures are classified by v1's `modelFailure.kind`** where the code has it (F5a-1), with the message as the
  fallback; `unreadableRetried` is recorded.
- **fair-arms:** arms N and convoN are the default; the lock polls every 5 s, checks the run's start time, and a
  failed spawn only loses the lock. Tested: gone 2.1 s after `taskkill /F`.
- **v1's F6 (the crisis operation) measured before it landed:** crisis rows 12 of 12 on a crisis line against 6 of 12
  on main, where both held-outs the pre-scan misses failed every run (the symptom op's note); guards unchanged, 0
  crisis ops on 15 guard turns. v1 ships it.
- **Next:** the prompt candidate against main, full evals ×3, once F6 is merged into `models-wording`.

**2026-10-22, evening — the evals can run the app's own fast finish, and a sleep can no longer inflate the
latency figures; 633 controls hold on v1's `b2b4285`** (and again on the shipped harness, `ed76c97`).
- **The production path.** `AI_FAST_FINISH=1`, the switch the route reads, now reaches `runAgent` from both
  evals, as arms N and convoN in fair-arms; the app's speed is quoted from them. No model run has used them yet.
  On every control (engine seed 1), the native skip and the eval's wrapper give identical rows in verdict, reason,
  reply, writes, steps, model calls and the skip. The evals refuse both switches at once.
- **Sleep.** A message the machine slept through is left out of the seconds and named (it stays in the pass
  rate). fair-arms asks Windows to keep the machine awake; a closed lid still sleeps it, and the run then pauses.
- **The diagnosis** (`docs/models/nemotron-diagnosis.md`): eight of nine clusters diagnosed, each checked by a
  skeptic. Three safety habits need code, and v1 took them: a crisis operation, history allergies, and numbers
  only from the user's words. The rest are prompt lines for this lane, after the harness corrections.

**2026-10-21 — every eval message the prompt quotes has a held-out paraphrase, reviewed and fixed; 633
controls hold on v1's `da023da`.** `node scripts/models/probe-quotes.mjs` reads the prompt the model is sent and
lists the eval messages it quotes: 8 of 55 on main, all held out, so it exits 0. Its `--self-test` passes 10/10.
- Held-outs: `vague-goal-heldout`, `emotional-heldout`, `every-day-swap-heldout`, `find-then-place-heldout` and
  convo `vegetarian-then-steak` are new; four were reworded after an adversarial review, so that each asks for
  exactly what its original asks.
- The review also fixed checks that passed wrong answers, among them offering to do both halves of a clash.
  The details are in the day record.
- On `da023da`: the three probes pass. Five controls flipped because v1's D works, and they are must-pass now.
- On `4bc9e47` (v1's follow-ups: undo as its own step, stated cook times met, "zero energy" as tiredness): 633/633
  hold and the probes pass. Nothing flipped. find-then-place's day-constrain controls now fail as re-plans, not
  as over-limit dishes. Next: v1's claim-guard batch (a "?" had excused every claim).
- **The owner's preference (2026-10-22): make Nemotron-3-Ultra 550B work.** The goal is now making that model
  fast and correct enough, not choosing one; other models are fallbacks (`docs/models/README.md`, decisions).
- **The key is in (2026-10-22, the owner's `.env.local`, `NVIDIA_API_KEY`).** A smoke call worked (9.1 s, one
  message, no infra errors). **The fair arms are done** (`cd2244b`).
  - C (reasoning off plus fast finish) is the setting: 28/34 at 5.5 s median, p90 12.5.
  - A (reasoning on): 27/34 at 15.3 s; B: 26/34 at 7.1 s.
  - Convo: 12/15 both ways, 6.0 s per turn against 11.3.
  The repeats held (26-28 of 34, `e8322f5`), though the laptop slept mid-run, so their latencies are not
  quoted. The fast finish is cleared (v1, `AI_FAST_FINISH=1`), and decision 2 is written. Shadow mode is
  `6344c77`. **In flight:** the no-model diagnosis of every failure.
Day records: `docs/worklog/2026-10-20-models.md`, `2026-10-21-models.md`.

**2026-10-20 — every check in both evals is fixed and proven: 524 controls hold across all 44 scenarios**
under 2 engine seeds (`node scripts/models/run-controls.mjs`).
- Loop shipped in `b43873f`, `cfa710f`, `e92229c` and `d7e3d20`; convo in `86e00de`, `4a223e0` and `bdd3184`.
- The do-nothing and hollow-claim fakes score 0 on both evals.
- The false-claim guard went from 1/15 to 15/15 on this lane's probe with v1's `c8ccfb0`.
- Still no `.env.local`, so no model runs. With the key, the fair arms run first.
- Since then: `contradiction-heldout`. Ten claim controls that failed only because their script ran out now
  reach the guard (`run-controls --verbose` shows why each must-fail control fails).
The 2026-10-18 notes below are history.

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

**Shipped since:** `d1d35ee` (the engine's dice are seeded in the evals; `run-controls.mjs`, the harness's
own test suite) and `1c35df0` (shared check guards; a hold that says only pleasantries fails). First
audit results: all 43 correct answers pass, but 153 of 337 plausible wrong answers pass too. The check
fixes come next, scenario by scenario, each with its controls.

**RUNNING NOW (2026-10-18, evening): an audit of every check in both evals** (workflow
`wf_373d28af-e1b`). It covers 29 loop scenarios and 14 conversations through `MODEL_SCRIPT` (`b16f0a4`):
for each, a correct answer must pass and 3–4 plausible wrong ones must fail. Each finding gets two
skeptics, then a completeness critic and a second round. It is key-free and touches no repo file. The
check fixes it yields land here as this lane's files. **Done:** v1's `test:engine` on the patched
`models-exp` tree (`49385e5`) is **943/0**, the same count as main; sent to v1, whose adversarial review
of the patch is running.

**Ready for the key: `scripts/models/fair-arms.mjs`**, one command for the fair arms. It bundles each
eval once from one commit and refuses a dirty tree. It runs one arm at a time, round-robin across
repeats, with a cool-down, and clears every inherited knob. It writes a manifest after each arm. It reads
the key from the main `.env.local` itself (exit 3 without it), so the key never reaches a command line.
Tested end to end against the stub: 10 runs, every arm exactly its definition, no key text in any output.

**The held-out wording test is ready too.** `models-wording` is now main plus exactly its three prompt
lines (`3591188`, main merged in 2026-10-21), with a worktree at `../NutriFlow-models-wording`. The third line ("lighter on <days>"
= resize) had no held-out paraphrase, so `days-lighter-heldout` was added ("go easy on the portions
thursday and friday"). The stub's new `script` mode is the positive control: all 6 scenarios of the
test pass the answer they reward, and fail do-nothing. The bare day constrain fails both lighter checks.

Next once a key exists:
1. The fair arms, ALL on one bundle: loop A, B, C, convo A, C. **Arm A is re-run.** The 10-03 one
   (21/26, median 23.3 s) ran 26 scenarios on an older bundle (34 today), before `5c12c4c` changed the
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
  - **DONE: v1 landed it as `09f325f`, with a denial check and a carrier filter** that its adversarial
    review proved the patch needed. Re-checked here with `probe-allergy-labels.mts`, now 18 cases (the
    review's four regression rows plus two must-still-bind rows): **18/18 on `09f325f`**. The original
    patch fails the four regression rows: dairy + gluten blocked 299/501 recipes, "oil" 234/501.
    **B1 (`ba23884`: plurals, misspellings, every cue sentence) re-checked 28/28**; its parent passes
    20/28, failing exactly the eight new must-bind rows. B2 (an honesty note on every allergy-cue
    remember, the LC-13 prompt line) and C (imported dishes) come next; I re-run the probe on each sha.
    History below:
  - *2026-10-18, a safety fix for `primitives.ts` (yours): a remembered allergy is enforced only when
    the model labels it `kind:"allergy"`.* `kind` is optional and the prompt never says it matters.
    - Replaying gpt-oss-20b's recorded `{op:"remember", fact:"allergic to shellfish"}` (no kind) through
      the conversation eval on today's main leaves Shrimp & Tomato Rice in the week.
    - `probe-allergy-labels.mts`, model-free, 7/12 on main. "has coeliac disease" as `condition` leaves
      9/9 gluten meals; "lactose intolerant" as `condition` leaves 7/7 lactose meals.
    - **The patch is `49385e5` on `models-exp`:** a fact with an explicit allergy, intolerance or coeliac
      cue binds the engine whatever its label. Unlabelled, only food words count; with no cue the fact is
      never parsed (the parser alone reads "a high-protein snack" as a "protein" allergy).
    - Patched: 12/12, and the replay passes 2/2. It errs toward excluding ("my son is allergic to eggs").
  - ~~**Fast finish in `runAgent`, with the reply rule.**~~ **Landed as `b2b4285`** (2026-10-22), set per model
    with `AI_FAST_FINISH=1`; the evals run it as arms N and convoN since `0327c45`.
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
| `3591188` (branch `models-wording`) | the wording branch merged with main again (2026-10-21; first `e078efd`): main + exactly its 3 prompt lines; probe-quotes exits 0 on it |
| `0fdfba1` | `days-lighter-heldout` (the third line's held-out paraphrase); the stub's `script` mode, the positive control: all 6 held-out-test checks pass the answer they reward |
| `49385e5` (branch `models-exp`) | the allergy-label patch for v1: a fact that says allergy binds the engine whatever its label (probe 7/12 → 12/12) |
| `d1d35ee` · `1c35df0` · `b43873f` … `bdd3184` · `f3e1f04` | the harness's own test suite (`run-controls.mjs`, seeded engine dice) and every check in both evals fixed and proven by controls (512, then 524) |
| `9327a01` · `6d1b978` · `7b42059` · `97e0f11` | every quoted eval message gets a held-out (`probe-quotes.mjs`), reviewed adversarially; the probe also scans v1's hard cases |
| `cd2244b` · `e8322f5` · `6344c77` · `41d2af2` | the fair arms on Nemotron-3-Ultra 550B (reasoning off plus the fast finish, 2.8 times faster at no loss), the repeats, shadow mode, decision 2 |
| `0327c45` | the evals run the app's own fast finish (arms N, convoN), the sleep watch and the keep-awake, the Nemotron diagnosis, NVIDIA's trial terms in OWNER-TODO |
| `efcf9c2` (branch `models-wording`) | the diagnosis's prompt candidate: 8 edits, byte-identical to the planned candidate, probe-quotes 0 on the evals and hard cases; unmeasured |
