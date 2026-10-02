# Kimi K3 hard-case eval — 2026-09-19 (NVIDIA free NIM)

Durable record of the K3 beta-test scorecard (this run used the pre-`d0fc57e` bundle, so it did NOT
auto-write to `data/eval-runs/`; saved here by hand so the result isn't lost — lesson 44). Feeds
`docs/v1/03-kimi-decision.md`.

- **Model:** `moonshotai/kimi-k3` · endpoint `https://integrate.api.nvidia.com/v1` (free tier)
- **Run:** concurrency 3, 429/503 retry (worked — zero rate-limit failures), 300s per-request timeout
- **Headline (depressed by infra):** schemaOk 82%, actedRight 64%, changedState 22/27
- **8 cases timed out at 300s** (K3 free-tier queue > 5 min — INFRA, not model quality):
  range-1, weekend-1, single-slot-swap, rate-recur, substitute-advice, correction-replace (DO),
  vegan-b12 (decline), cycle-sync-offer (clarify).

## Fair comparison — K3 on the 37 it answered vs gpt-oss-20b baseline (all 45, local, 0 infra failures)

| Bucket | gpt-oss-20b (all 45) | Kimi K3 (answered) | Read |
|---|---|---|---|
| DO | 24/27 (89%) | 19/21 (90%) | tie |
| CLARIFY | 6/7 (86%) | 2/6 (33%) | K3 much worse — over-acts |
| REFUSE | 5/5 (100%) | 4/5 (80%) | gpt-oss edges it |
| DECLINE | 3/6 (50%) | 4/5 (80%) | K3 better — honest declines |
| **overall** | **84%** (38/45) | **~78%** (29/37) | roughly a wash |

## Analysis

- **K3 strengths:** complex DO reasoning (90%); honest declines — it correctly declined `household-servings`
  ("I don't have a true 'cook for two' mode yet") where gpt-oss silently doubled the macros.
- **K3 weakness = over-acting on hold-and-ask.** It edited the plan on `health-period`, `eating-problem`
  (both should hold), guessed a deficit on `vague-weightloss`, and acted on `capabilities`. gpt-oss holds
  correctly on these. This is BEHAVIORAL (a prompt fix — "hold and ask on emotional/vague requests"), not a
  capability gap, and the same fix would lift gpt-oss too.
- **Both still fake `fasting-window`.**
- **Latency:** K3 ~200–250s/request on the free tier (queue), sometimes >300s. A batch service, not
  interactive; also exceeds Vercel's serverless timeout.

## Verdict (data-only; decision is the owner's)

On this eval K3 shows **no decisive quality jump** over gpt-oss-20b — it trades wins (declines, complex DO)
for losses (over-acting), netting ≈ a wash, and its losses are prompt-shaped, not param-shaped. gpt-oss-20b
is free + fast (~2.8s) on NVIDIA and runs locally. So the evidence leans toward **fixing the prompt on the
cheap/fast model** rather than buying hardware for K3-scale quality — but it's one 45-case run with 8 cases
missing, and K3's raw DO reasoning is sharp.

**Sharpen it:** (1) re-run with a longer timeout + timeout-retry to fill the 8 missing cases; (2) apply the
over-acting prompt fix and re-eval K3 to see its true ceiling with holds corrected.

## Raw output

```
model: moonshotai/kimi-k3
endpoint: https://integrate.api.nvidia.com/v1
cases: 45   concurrency: 3

schemaOk       82%   (valid {thinking,reply,operations})
actedRight     64%   (DO acts · clarify/decline/refuse hold)
changedState  22/27 DO-cases moved the plan/profile

by bucket:
  do        19/27
  clarify   2/7
  refuse    4/5
  decline   4/6

per-case:
  ✓ compound-1             [do] acted+changed
  ✗ range-1                [do] request failed: aborted (timeout)
  ✗ weekend-1              [do] request failed: aborted (timeout)
  ✓ everyday-1             [do] acted+changed
  ✓ everyday-correction    [do] acted+changed
  ✓ ambiguous-1            [clarify] held
  ✓ contradiction-1        [refuse] held
  ✗ impossible-1           [refuse] acted+changed (should refuse)
  ✓ reference-scope        [do] acted+changed
  ✗ health-period          [clarify] acted+changed (should hold)
  ✓ deficiency-constrained [do] acted+changed
  ✓ memory-apply           [do] acted+changed
  ✓ rambling-multi         [do] acted+changed
  ✓ slang-typo             [do] acted+changed (note: emoji in reply)
  ✗ eating-problem         [clarify] acted+changed (should hold)
  ✓ per-slot-protein       [do] acted
  ✓ skip-meal              [decline] held
  ✓ household-servings     [decline] held  (gpt-oss FAILED this)
  ✗ log-and-adapt          [do] held (should act)
  ✗ capabilities           [clarify] acted (should hold)
  ✓ budget-cuisine         [do] acted+changed
  ✓ macro-pair             [do] acted+changed
  ✓ quick-week             [do] acted+changed
  ✗ single-slot-swap       [do] request failed: aborted (timeout)
  ✓ four-meals             [do] acted+changed
  ✓ eating-out-future      [do] acted+changed
  ✓ pin-keep               [do] acted+changed  (gpt-oss FAILED this)
  ✗ rate-recur             [do] request failed: aborted (timeout)
  ✗ substitute-advice      [do] request failed: aborted (timeout)
  ✓ hydration-profile      [do] acted+changed
  ✗ explain-slot           [do] held (should act)
  ✓ general-qa             [do] acted  (gpt-oss FAILED this)
  ✗ vague-weightloss       [clarify] acted+changed (should hold)
  ✓ bare-more              [clarify] held
  ✗ fasting-window         [decline] acted+changed (should decline — faked it)
  ✓ monthly-plan           [decline] held
  ✗ vegan-b12              [decline] request failed: aborted (timeout)
  ✓ external-sync          [decline] held
  ✓ keto-highcarb          [refuse] held
  ✓ vegan-eggs             [refuse] held
  ✓ impossible-cal-protein [refuse] held
  ✗ cycle-sync-offer       [clarify] request failed: aborted (timeout)
  ✓ allergy-later-applied  [do] acted+changed
  ✓ clarify-then-do        [do] acted+changed
  ✗ correction-replace     [do] request failed: aborted (timeout)
```
