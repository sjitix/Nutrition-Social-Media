# Models lane — the assistant's brain

Owned by the models agent (see `docs/parallel/lane-models.md`). This folder is the research record:
what was measured, how, and what it decided.

## The bar

The assistant must behave like a **personal nutritionist**: understand loose, emotional, multi-part
requests; decide *whether* to act (act / clarify / decline / refuse); use the app's real functions
(the primitives and the agent loop's read tools) instead of inventing; write warm, precise language;
and never fake a nutrition number (the engine does all arithmetic).

It must also be **fast enough to feel like a conversation**. The agent loop takes 2–4 model calls per
message (8 at worst), so **per-call latency × steps** is the number a user feels.

| axis | how it's measured | bar |
|---|---|---|
| single-turn judgement | `npm run eval:hardcases` (45 cases, engine-verified); also regraded strictly by `scripts/models/regrade-hardcases.mjs` (v3) | beat **84%** (gpt-oss-20b, old prompt) — every big model now clears it; the ruler has saturated, and partly on recall: 11 of its 45 cases are near-quotes of the prompt it sends, six of them holding every content word (`probe-quotes.mjs --hard-cases`, 2026-10-21). Since v1's `4575524` each of those has a held-out twin (54 cases; the probe exits 0). Until a run compares the twins with their originals, it stays a regression check, not a ruler for choosing a model |
| honest declines | the `decline` bucket of the same eval | ≥ 5/6 |
| loop behaviour | `scripts/models/loop-eval.mts` (38 scenarios through the real loop, 11 of them held-out paraphrases; crisis rows graded on what the person reads) — reads before writes, stops cleanly, no `gaveUp` | read-before-write 3/3, gave up 0 |
| **conversation** | `scripts/models/convo-eval.mts` (17 two-turn conversations, three of them held-out paraphrases, state carried like the client) | **the ruler that separates sizes** — 550B 79%, 20B 43% (2026-10-03, on the lenient harness: re-measure) |
| **the harness itself** | `node scripts/models/run-controls.mjs` — 690 scripted controls: every check must pass its correct answers and fail its wrong ones, under several engine seeds | all hold under 2 seeds, every must-fail control for its own reason (2026-10-23, with the diagnosis's seven corrections) |
| **what the prompt quotes** | `node scripts/models/probe-quotes.mjs` — the eval messages the rendered prompt quotes (a near-quote measures recall of its example, not judgement) | every near-quote held out: exit 0; `--self-test` 10/10 (2026-10-21) |
| latency | median + p90 seconds **per message** from the loop/convo evals, quoted for the app from arms N and convoN (the loop's own fast finish, as the app runs it) | message-level ≤ ~10 s |
| cost | $/message at beta volume | free now; priced before launch |

## Ground rules for measurements

1. **A scorecard with `infraFailures > 0` is not evidence about the model** (WORKPLAN lesson 44). Infra
   misses are reported, never averaged in.
2. **Every run writes a file** to `data/eval-runs/`. A number that only printed to a terminal didn't
   happen.
3. **Latency is measured, never quoted from a provider page.** Free tiers queue; the same model can be
   2 s or 250 s depending on where it is hosted. And only per-MESSAGE seconds from the real loop count:
   short-prompt sweeps flatter every model 3–10×. **A message the machine slept through is not latency**:
   the laptop idle-sleeps after 5 minutes on AC (3 on battery), and on 2026-10-22 messages that spanned a sleep
   were timed at 1,854 and 4,314 s. The evals now leave such a message out of the seconds and say so (it stays
   in the pass rate). `fair-arms.mjs` also asks Windows to keep the machine awake for the whole run; check each
   manifest's `slept` count, because a closed lid still sleeps the machine and the run then pauses.
4. Single-turn scores are a proxy. The loop and conversation evals are the real test.
5. **Repeat before you claim.** Identical runs swing up to 9 points on the hard cases; quote ranges.
6. **Grade what the engine did, not what the model sent.** Counting emitted operations hid three
   engine bugs on 2026-10-03 (a slot-scoped constrain that did nothing while the reply said it had).
7. **Every new check scores 0 against a fake model, and passes the answer it rewards.** Put both in
   `scripts/models/controls/<eval>/<id>/` (`pass-*.json`, `fail-*.json`) and run `run-controls.mjs`. A check
   change ships only with its controls holding. **A must-fail control has to fail for its own reason**:
   `--verbose` prints why each one failed. Ten claim controls once failed only as "said nothing": the loop
   calls the model again after a claim it retries, their scripts had run out, and the claim never reached
   the guard (2026-10-20). Over HTTP:
   `node scripts/models/stub-model.mjs --mode nothing|hollow|garbage`, then the eval with
   `LOCAL_AI_URL=http://127.0.0.1:4011/v1`: every mode must score 0. On 2026-10-18 the `hollow` mode
   (claims a change, makes none) passed 8/10 holds until that was fixed. Then `--mode script --script
   <file.json>` sends the correct operations for a phrase of the message, and the check must pass them. A
   check nothing can pass is as useless as one a do-nothing model passes.
8. **A comparison runs every arm from ONE bundle.** An arm measured on an older bundle is history, not
   an arm. The withdrawn speed claim compared arms across code; on 2026-10-18 the old arm A was found to
   have a different scenario set (26 vs 29 then; 34 now) and to predate a loop change.
   `node scripts/models/fair-arms.mjs` is the only way this lane runs one. Speed for the app is quoted from
   arms N and convoN, which its default arms include: they pass `AI_FAST_FINISH=1` to the loop, the switch the
   route reads, so they run the code that ships. Arm C measured the same rule through the eval's wrapper before
   it landed, and is history for speed. The shadow arms (S, convoS) still run through the wrapper, whose reply
   rule is the native skip's, so they cannot be combined with `AI_FAST_FINISH=1`.
9. **A scenario the prompt quotes needs a held-out paraphrase, graded by the same code.** `probe-quotes.mjs`
   exits non-zero for a quote with no held-out, or a held-out the prompt has come to quote itself. Run it
   on every prompt change (`--code <branch>`, `--prompt-file <draft>`) and read each held-out beside its
   original: the evals print `held out x/y, their originals x/y` and name any scenario that passed only
   in the prompt's words.

## Decisions on record

- **2026-10-22 — NVIDIA's free endpoint is for testing only; launch needs a paid host of the same model.**
  Its trial terms (`nemotron-diagnosis.md`, owner question 2) allow internal testing and evaluation, not
  production, and forbid uploading health or personal information. The evals send made-up messages, so this
  lane keeps measuring there. OpenRouter sells the same model through DeepInfra, BaseTen and Venice at FP4 or
  FP8, so the chosen host is re-measured before launch. Which host is the owner's call (decision 2).
- **2026-10-22 — Nemotron's setting: reasoning off plus the fast finish.** The fair arms (`cd2244b`) show
  it is about 2.8 times faster than reasoning on at the median (5.5 s against 15.3) with the same pass rate
  (26-28 of 34 over four runs, against 27). The fast finish cuts calls from 1.9 to 1.2 per message. v1 shipped
  it as `AI_FAST_FINISH=1` (`b2b4285`), an environment switch to set only for this model; the code does not check
  which model runs. The skipped call never wrote anything on the 550B, and did on gpt-oss-20b. The repeats'
  latencies are not quoted, because the laptop slept mid-run.
- **2026-10-22 — the owner's preference: make Nemotron-3-Ultra 550B work.** In the owner's words, "i like
  nemotron, id be happy if we could make it work". So the lane's main line is no longer choosing a model. It is
  making `nvidia/nemotron-3-ultra-550b-a55b` fast and correct enough to run the assistant, through:
  - its settings (the fair arms: reasoning on or off, the fast finish);
  - the prompt's wording for its known misses (the wording test);
  - fewer model calls per message.
  Other models (OWNER-TODO keys) are fallbacks to measure against, not the plan.
- **2026-10-03 — the owner's direction: a BIG hosted model first.** Find the biggest free model with an
  optimal response time (100B+); stop investing in training or tuning 20–30B models. 20B models are run
  only as a regression check for the model production serves today.
- **2026-10-03 — the prompt is not gated for v8.** The read-tool prompt costs the 1.5B fine-tune (v8)
  2–3 cases under the v1/v2 grades (73/80 → 67/76) and leaves it flat under v3 (73 → 73). Production
  does not serve v8, so the prompt lands for everyone. **If v8, or any fine-tune, ever serves again, it
  is retrained on the new prompt** rather than the prompt being forked to suit it. (Agreed with the v1
  lane, which landed the prompt.)
- **2026-10-03 — the conversation eval is the deciding ruler.** On single-turn cases the fixed prompt
  lifted gpt-oss-20b to tie the 550B (91–96%). Across conversations the 550B passes 11/14 and the 20B 6/14
  with either prompt: the 20B swapped in a placeholder dish name, stored "keep Sunday's dinner" as a note
  instead of pinning it, and resized the wrong day.

## Files

- `nemotron-diagnosis.md` — why Nemotron-3-Ultra 550B fails at its chosen setting, and the plan that makes it
  fit to serve: three safety guards for v1, prompt lines and harness corrections for this lane, eight questions
  for the owner (2026-10-22). The full diagnoses are in `nemotron-diagnosis-2026-10-22.json`.
- `OWNER-TODO.md` — things only the owner can do; this lane never waits on them.
- `survey.md` — the model survey: what's reachable, parameter counts, measured latency, scores.
- `free-providers-2026-10.md` — the verified search of every free provider: what is big, fast and free, and what isn't.
- `read-tool-fix.md` — the read-tool fix (the loop could never use its own look-ups) and its evidence.
- `eval-variance.md` — how much identical runs swing, and why every score is a range.
- `hardware-128gb.md` — what a 128 GB machine would and would not buy.
