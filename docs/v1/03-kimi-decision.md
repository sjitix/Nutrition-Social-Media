# Kimi K3, and the hardware question

*Deliverable 3 of the planning conversation briefed in `docs/v1-modularization-kickoff.md`.
Written 2026-09-19.*

**The standing instruction, respected:** do not argue "we don't need the params." This document does
not. It takes as given that frontier-scale quality is worth having, and asks only **where it should
run and what it should cost.**

---

## 1. First, the bad news about the number

**The clean K3 re-run is gone.** `CONTEXT.md` records it as in flight at the last handoff; it is not
on disk, not in `data/`, not in git, and not in any temp directory. The grader only ever printed to
stdout, and the terminal it printed to is gone with the session.

That has been **fixed at the root** (commit `d0fc57e`): `npm run eval:hardcases` now writes
`data/eval-runs/<timestamp>-<model>.json` on every run, that path is deliberately un-gitignored, and
infra failures (timeout, 429) are counted apart from model misses so a rate-limit storm can never
again be read as a model weakness — the run carries `trustworthy: false` when any case never reached
the model. Verified against a scripted provider.

So the deciding number has to be re-measured. **§5 pre-commits the decision rule before the number
exists**, which is the only honest order to do it in.

---

## 2. The fact that reframes the question

The brief asks: *is Kimi-scale quality worth buying hardware for?*

**No hardware purchase at any plausible budget runs Kimi K3 locally.** The repo records K3 at
**2.8 trillion parameters**. At 4-bit that is roughly **1.4 TB** of weights that must be resident;
mixture-of-experts reduces the compute per token, **not** the memory needed to hold the experts.
Against that:

| Hardware | Memory for weights | Gap to K3 @ 4-bit |
|---|---|---|
| The desktop today (1× RTX 2070) | 8 GB | ~175× short |
| All four 2070s pooled | 32 GB | ~44× short |
| A used RTX 3090 | 24 GB | ~58× short |
| Two 3090s | 48 GB | ~29× short |
| A 512 GB unified-memory workstation (~$10k) | 512 GB | still ~3× short |

So the honest form of the question is not "is K3 worth hardware" — **hardware cannot sell you K3.**
It is two separate questions, and they have different answers:

- **"Is frontier-scale quality worth paying for?"** → Possibly yes. It is bought from an API, by the
  token, and at this product's scale that is cheap (§4).
- **"Is 30B–70B-scale local quality worth buying hardware for?"** → Maybe, and there is a **$0
  experiment that must be run first** (§3).

---

## 3. The $0 experiment nobody has run

**The desktop has up to four RTX 2070s and a 1200 W PSU that can drive all of them** (CLAUDE.md), and
the assistant is running on **one** of them.

`WORKPLAN.md` correctly rejects multi-GPU for **training** — pooling VRAM needs FSDP/ZeRO-3, which is
slow and fragile over PCIe risers with no NVLink. **That reasoning does not carry over to
inference.** llama.cpp and LM Studio split a model *by layer* across GPUs, and only the activations
cross the bus between layers — kilobytes, not gradients. A riser is fine for that.

**Four cards is 32 GB of VRAM — enough to hold a 30B-class model at 4-bit fully on GPU**, including
`Qwen3-30B-A3B`, which CLAUDE.md already names as the 4-card target. Today's gpt-oss-20b runs partly
in system RAM.

So before any money is spent: **put the other cards in, load a 30B, and run the 45 hard cases.** It
costs an afternoon and it directly answers whether local inference can clear the bar. If it can, the
hardware question is closed for free. If it cannot, a 3090 is unlikely to close a gap that 32 GB did
not.

---

## 4. What the money actually looks like

Two things dominate, and neither is the sticker price.

**(a) The agent loop multiplies everything.** `MAX_STEPS = 8`, and every step is a full model call.
Latency and cost are both per-step, so a per-call figure must be multiplied by the steps a real
answer takes (2–4 typically, 8 worst case). This is the single most important number in the whole
decision and it is why free K3 is unusable live: **~200–250 s per call × 3 steps is 10–12 minutes for
one message.** The route asks for `maxDuration = 300` seconds; it does not matter what Vercel's
ceiling actually is, because nothing survives that.

**(b) At this scale, inference is cheap.** Current published rates, and an estimate of one assistant
message at ~3k input / ~300 output tokens per step across 3 steps (**≈9k in, ≈0.9k out**):

| Model | $/MTok in | $/MTok out | ≈ per message | 250 messages/day |
|---|---|---|---|---|
| Claude Haiku 4.5 | $1 | $5 | ~$0.014 | ~$100/mo |
| Claude Sonnet 5 | $2 | $10 | ~$0.027 | ~$200/mo |
| Claude Opus 5 | $5 | $25 | ~$0.068 | ~$500/mo |

**Prompt caching cuts this hard and is the first thing to turn on.** The system prompt and the week's
plan are identical across every step of a loop, and cache reads are ~10% of input price — for a
3-step loop that is most of the input bill. Expect the figures above to fall by roughly half to
three-quarters once caching is placed properly.

> **Treat those numbers as an estimate, not a measurement.** They assume a token profile nobody has
> measured. Before committing, run `messages.count_tokens` on a real transcript — the repo already
> logs complete agent runs to `data/edit-log-v2.jsonl`, so the input exists.

**Break-even against a $700 used 3090**, ignoring electricity: ~10k messages at Opus rates, ~26k at
Sonnet, ~52k at Haiku. At 250 messages/day that is roughly 1.5, 3.5, or 7 months. Add electricity
(a 3090 under load is ~350 W) and the low-volume end never pays back at all.

**The conclusion cost points to:** at beta scale the bill is small either way, so **cost should not
decide this.** Quality and latency should.

---

## 5. The decision rule — pre-committed, before the number exists

Written down now so the re-run *decides* something instead of being interpreted afterwards. The
scorecard's own `trustworthy` flag gates all of it.

**Precondition: `infraFailures == 0`.** Otherwise the run is void and is re-run at lower
concurrency. A run that graded the infrastructure is not evidence about a model (lesson 44).

| K3 result vs the 84% gpt-oss-20b baseline | What it means | What we do |
|---|---|---|
| **≥ 92% actedRight AND decline ≥ 5/6** | Scale genuinely buys judgement on exactly the cases the small model fakes | Ship a **hosted frontier model** for the live assistant. Local stays the free/offline tier. Do **not** buy hardware to chase it — you cannot host K3 anyway. |
| **84–91%** | The gap is prompt-shaped, not scale-shaped | Fix the prompt first (the emotional over-act is already diagnosed as a prompt fix). Stay local for dev; re-measure after the prompt work. |
| **< 84%** | These hard cases do not reward scale | **Close the hardware conversation.** Spend the effort on the read surface and the prompt instead. |

**Whatever the result: run §3's free 4-GPU experiment**, because it is the only thing that tells us
what local can do, and it costs nothing.

---

## 6. The methodological caveat that matters more than the score

**The eval measures one turn. The product runs a loop.** `runCase` makes a single call per case, so
the 84% baseline — and any K3 number — grades single-turn judgement. What the product actually
depends on is the agent loop: does the model call `find_recipes` *before* deciding, does it read the
engine's refusal and change course, does it stop or burn all 8 steps?

Nothing measures that yet. A model can score well here and still be bad at the job, or vice versa.
**A loop-level eval — scored on steps taken, whether reads preceded writes, and whether `gaveUp`
fired — is the highest-value measurement work after V1**, and it is exactly what `agentLoop.ts`'s
injected `ModelFn` was built to make possible.

---

## 7. The recommendation

**Three lanes, and only one of them costs anything.**

1. **The live app (V1 beta): a fast hosted model, not K3.** The requirement is p95 well under ~5 s
   per call so a 3-step loop stays under ~15 s. The same NVIDIA NIM key already in hand serves fast
   free models; Claude Haiku 4.5 is the paid option if free latency disappoints. **Turn on prompt
   caching before measuring cost.**
2. **Offline evaluation: free K3, exactly as it is.** ~4 minutes a reply is fine for a 45-case batch
   run and free. It is a batch service; use it as one.
3. **Hardware: buy nothing yet.** Run the 4-GPU experiment first (§3). Revisit only if local
   inference becomes a product requirement (privacy, offline) or volume makes API cost material —
   and note that neither of those is true today.

**And fix the prompt regardless of the model.** The over-acting on `health-period` and
`eating-problem` is a prompt problem, and the structural guard for that whole class — the
**crisis pre-scan** — is a V1 blocker that is independent of which brain is behind it (milestone C2
in `01-dimensions-and-milestones.md`). Verified today: the crisis guard fires only when the model
routes to `symptom_check`, so a crisis message the model chooses to simply *answer* reaches the user
in the model's own words.

---

## 8. What the owner is being asked to decide

1. **Re-run the K3 eval** (the key is theirs; it never touches disk). One command, in the kickoff
   brief. It now leaves a scorecard behind.
2. **Are the other 2070s available to install?** That is the free experiment and it gates everything
   about local.
3. **Is a paid hosted model acceptable for the public beta**, at roughly the numbers in §4? VISION
   already resolved this in principle — "$0 is a floor the product must always run at, not a ceiling
   it may never exceed" — so this is a budget question, not an architecture one.
