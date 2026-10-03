# The agent couldn't look anything up — the read-tool fix

Models lane, 2026-10-03. Prototype on branch **`models-exp`**; landing on `main` is the v1 lane's call
(the files are v1's). This is the evidence that goes with the diff.

## The bug

`agentLoop.ts` routes every operation through `isReadTool` and runs the seven read tools
(`find_recipes`, `inspect_recipe`, `get_plan`, `get_profile`, `get_saved`, `report`, `what_if`),
feeding results back to the model. But **no model could ever emit one**:

1. `PrimitiveOpSchema` / `AssistantTurnV2Schema` (`primitives.ts`) have no entry for them (only `report`
   overlaps), so a `find_recipes` op fails validation;
2. `promptV2.ts` never mentions them;
3. the prompt never explains the loop at all — the model is called again after every action with
   `[tool result: apply]` and nothing tells it that, if the change applied, it is done.

So in production the "agent" was a single-shot writer that guessed dish names and sometimes kept
going after it had finished. VISION's core idea — read everything, decide from what it read — was not
happening.

## Seen in one trace (Nemotron-Ultra-550B, main's prompt)

"swap just wednesday's dinner for something with salmon" → `swap {dish: <a guessed name>}` → the
engine's fuzzy matcher placed **Baked Falafel Bowl with Roasted Veg & Tahini** → then `answer`,
`answer`, `answer`… seven times until the 8-step cap → **106 s** for one message, wrong dish,
`gaveUp: true`. Reproduced again in round 3.

## The fix (additive; nothing existing changes shape)

- `primitives.ts`: **new** `AgentTurnSchema` = primitives + the six read ops (`report` already exists).
  `PrimitiveOpSchema` and `AssistantTurnV2Schema` are untouched, so `/api/assistant`, training data and
  the hard-case eval parse exactly as before.
- `promptV2.ts`: `assistantV2SystemPrompt(profile, plan, opts?: { agent?: boolean })`. Two-arg callers
  get the old prompt **plus** a short "HOW TO DECIDE" block. `agent: true` adds the LOOK-UPS + LOOP RULES
  section (look up before placing a dish; look up to answer questions about a meal; after `apply`,
  finish; fewest turns).
- `ai.ts`: `agentModelFn()` uses `AgentTurnSchema` and `{ agent: true }`. **`ModelFn`'s shape is
  unchanged** (v1's constraint).
- No new imports; layer rules hold (checked with `check-boundaries.mjs` after rebasing).

The HOW TO DECIDE block (over-act + honesty guidance): feelings → empathy and an *offer*, never an
unasked change (only `remember` allowed); a request with a clear direction → act with the relative
tools; clarify only when *what* to change is unknown or the number has health stakes; unsupported →
honest decline, never an approximation dressed as the real thing; contradictions → refuse with the
choices; questions → `answer`/`explain`; facts stated earlier bind later actions (allergies →
`exclude`); replies in plain words, no emoji.

## Measured — same model (Nemotron-3-Ultra-550B), same endpoint, before vs after

**Loop level** (`scripts/models/loop-eval.mts`, 14 scenarios, engine-verified):

| | before (main) | after (prototype v1) |
|---|---|---|
| read-before-write | **0/2** | **2/2** |
| gave up at 8 steps | 1 | 0 |
| per message — median / p90 / max | 21.4 / 44.8 / **106 s** | 17.6 / 31.7 / 47 s |
| pass (graded, infra excluded) | 10/13 | 11/14 |

**Single turn** (45 hard cases, `actedRight` v1 grading):

| | before | after |
|---|---|---|
| actedRight | 82% | **84%** |
| decline | 5/6 | **6/6** |
| refuse | 5/5 | 5/5 |
| do | 23/27 | 24/27 |
| clarify | 4/7 | 3/7 — mostly `remember`-only replies the v1 grading counts as acting; v1 has since added `actedRightV2` |

**Gate:** the full engine suite against `models-exp` (bundled to a private path, not the shared `node_modules/.cache`): **660 passed, 0 failed**; `tsc` clean. The diff is commit `af89fb7` on `models-exp`. Re-run after rebasing onto v1's Day-2 refactor.

## Final round — the final prompt, both rulers, sequential (no rate-limit contamination)

**Single turn, Nemotron-3-Ultra-550B, 45 hard cases, 0 infra on both arms**
(`2026-10-03T11-06-51-…` before, `2026-10-03T11-21-37-…` after):

| | before (main) | after (`models-exp` 62c4617) |
|---|---|---|
| actedRightV2 | 84% (38/45) | **96% (43/45)** |
| actedRight (v1 ruler) | 73% — range **73–82%** across today's runs | **87%** — range **84–87%** |
| do | 21/27 | **25/27** |
| decline | 5/6 | **6/6** |
| clarify (v2) · refuse | 7/7 · 5/5 | 7/7 · 5/5 |

The ranges do not overlap, so this is beyond the ~9-point run-to-run spread
(`eval-variance.md`). The gain is in DO: questions now get `answer`/`explain`, the remembered lactose
intolerance reaches the pasta, the egg substitution is given. **Both remaining misses are under-acts —
and `log-and-adapt` is the date gap** (it still asks "which day is today?").

**Loop level, local Qwen3-30B, 26 scenarios** (`…T10-52-40-loop-qwen…` before, `…T11-21-02-loop-qwen…`
after): read-before-write **0/2 → 2/2**, give-ups **1 → 0**, worst message **796 s → 216 s**, pass
13/26 → 13/26. The mechanics land on a weaker model too; judgement does not improve at 30B.

**Safety finding (raised with v1, now its C2 work):** on main's prompt the 30B model DID route a
crisis message through `symptom` — with its own paraphrase, so no crisis phrase matched and the engine
answered "I don't have a nutritional angle on that". The guard depended on a model quoting verbatim.
The prompt now says "VERBATIM — copy, never paraphrase" (`d033c3a`), and v1 is adding a pre-scan of
the raw message in both routes so no model can miss it.

## Known issues found on the way (not in this diff)

- **The model is never told today's date** — "I already ate a burger for lunch today" makes even a
  550B model ask "which day is today?". Fix candidate: `agentModelFn({ today })` from the route, keeping
  `ModelFn`'s shape. Separate change, after this one.
- **A change scoped to one slot also swaps a different dish elsewhere that day** (the rebalancer
  upgrade-swaps to hit macros). v1 agreed the user's scope outranks macro fit; the loop eval carries an
  engine assertion for it (`single-slot`, reported apart from the model score).
