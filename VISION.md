# NutriFlow — product vision & the road ahead

This file captures the *behavioral* north star for the meal planner — what a "good"
result actually means and the capabilities we're building toward. CLAUDE.md holds the
phased build order; this file holds the **quality bar and the constraint model** that
every phase must satisfy. Read it before judging whether a feature or model is "good
enough" — the answer depends on these goals.

## Hard constraint: $0 running cost, local-only AI

Non-negotiable: the app must cost **nothing** to run. **No paid AI APIs** (no Claude
API credits, no hosted keyed routes) — all inference runs on the owner's **local
hardware** via LM Studio. Do not propose paid-API solutions, even for the hard
reasoning parts. The way to get reliable results from a small local model is **not** to
buy a bigger brain — it's to **enforce correctness in code**: generate → validate the
output against the active constraints/macros with deterministic checks → re-prompt to
repair any violation. Correctness lives in code that can't be wrong, not in the model.
A bigger/smarter model only improves *variety and fluency*, and the owner gets that for
free over time by adding the RTX 2070s they already own (8 GB → 16 GB → 24–32 GB VRAM).

## The ambition: go viral, scale to millions — in a month

The goal is not a hobby app. This is meant to **go viral and serve millions of users
concurrently, seamlessly.** Working target: a **~1-month sprint** of hard, focused work
to a viral-ready product. Build every piece as if that traffic is already coming —
reliability, speed, and UX held to that bar.

### Reconciling "$0 cost" with "millions of users"

These look contradictory; they are **phased**, not in conflict:

- **Now (build + beta):** $0, local single-GPU AI. Correct for development and early
  users, and how we validate the product for free.
- **At viral scale:** millions of AI generations **cannot** run off one home GPU —
  inference must move to scalable infrastructure, and that tier costs money. That's fine
  because **revenue at that scale funds the inference** (same logic as "buy GPUs when
  profitable," and the provider ladder in CLAUDE.md: local → cheap open-model API →
  self-host). The $0 rule governs the *build phase*; scale is paid for by the users it
  serves.
- **The provider abstraction is what makes this a config change, not a rewrite.** Build
  the whole product free on local now; swap the inference backend the day traffic spikes.

### What "seamless for millions" actually requires (build for it now)

So we don't paint ourselves into a corner, the architecture must be scale-ready even
while running free locally:

- **Persistence:** a real database for users, plans, and their constraint sets — not
  in-memory state. (Currently there is none.)
- **Stateless, horizontally-scalable API** behind autoscaling deploy (e.g. Vercel for
  the Next.js app; a separate scalable inference tier behind it).
- **Generation as async jobs + queue + streaming** — plan-building takes seconds; at
  scale you queue and stream, never block a request for minutes.
- **Caching / reuse** — identical constraint sets should not regenerate from scratch;
  cache and template aggressively (also keeps cost-per-plan low).
- **CDN, rate limiting, observability, cost-per-generation discipline.**

Framing for "is X doable in a month?": judge it against a small, hard-working effort —
**prioritize ruthlessly toward a viral-ready MVP**, and make sure every choice keeps the
data + inference layers able to scale horizontally when the spike comes.

### Virality is a design goal, not luck

The product has built-in viral DNA — lean into it deliberately, don't leave it to
chance:

- **Shareable by nature:** the "share a reel → it becomes your plan" hook and a
  screenshot-worthy meal/workout feed are inherently spreadable. Make outputs
  beautiful and easy to share back out (image cards, links).
- **Low-friction spread:** one-tap "add to plan," easy invites, no hard signup wall
  before the user feels the magic. Time-to-first-wow should be seconds.
- **Every core feature should ask:** "does this make someone want to show a friend?"

## Recipe data strategy — the engine (decided direction)

The long-term architecture: **the AI selects and personalizes plans from a curated
recipe database — it does not invent every recipe from scratch.** Inventing recipes is
where the model hallucinates macros and collapses to the same few dishes (the "80%
chicken" problem). Selecting from structured data fixes all of it.

**Why this is the right direction (it serves every goal at once):**
- **Accuracy:** macros come from data, not a guess. Compute them from a real nutrition
  source (**USDA FoodData Central** — free, public-domain) by summing ingredients.
- **Diversity is structural:** select proteins/dishes *without replacement*; balance by
  query. Repetition disappears.
- **Every user control becomes a filter, not a hope:** cuisine-per-day, cook-time limit,
  max-ingredient count, budget/low-cost, and "what's in my fridge" are all just queries
  over tagged fields — guaranteed, not prompt-and-pray.
- **It's the only way to hit "millions of users at $0":** a DB lookup is ~instant and
  free; 7 LLM calls per plan per user is not. The database is the scaling answer, not
  just a quality upgrade. (See the scale ambition above.)

**Two hard corrections to the original "millions of recipes" instinct:**
1. **Curated thousands, not scraped millions.** A million messy scraped recipes
   (unhealthy, 30-ingredient, inconsistent macros) is the trap we already hit. A few
   thousand clean, healthy, well-tagged recipes generate near-infinite varied weeks
   (only 21 are needed per week). Grow the pool over time; quality over quantity.
2. **The AI's job shifts to assemble + personalize.** Its runtime role becomes: pick
   recipes that satisfy all constraints, and handle chat edits as *swaps within the DB*
   ("make Tuesday Asian", "cheaper", "no onions") — not regenerate from nothing.

**How to build the database (efficiently):**
- **Generate it offline with the local model** — repurpose the existing generation +
  validation pipeline as a one-time, background DB-builder. Do the LLM work once,
  offline, instead of on every user click.
- **Compute macros deterministically from USDA FoodData Central**, not the LLM.
- **Use messy open datasets as raw material with the LLM as curator** — clean, simplify,
  health-score, and tag them offline; drop anything over an ingredient/health threshold.

**Recipe object (target schema):** name, cuisine, macros (from USDA), timeMinutes,
ingredients[], ingredientCount, approxCost, dietTags, mainProtein, healthScore, steps.

**Interim (until the DB exists):** enforce quality, protein diversity, cook-time, and
ingredient limits directly on the generate path via the validate→retry gate — so the
current app already respects these constraints while the DB is built.

## Conversational assistant — architecture & roadmap (decided direction)

**Vision:** a real LLM you talk to that changes the plan and settings the way Claude
Code changes files — general, adaptive to *anything* you say, not an if-else/decision-tree
chatbot. It should feel like talking to Claude/ChatGPT, and it effectively edits the app.

**How that actually works (the key insight):** LLMs "change things" via **tool /
function calling**. The model stays general; it interprets your message and emits
**structured tool calls**; plain code (the tools) executes them against the database.
The model doesn't contain the plan — it calls `swap_meal(...)`, `exclude(...)`,
`set_target(...)`, etc., and the app does the doing. The distinction that matters:
- ✅ **General, reusable tools** the LLM composes freely (good — generalizes to any request).
- ❌ **Phrase-specific if-else rules** ("if the message says 'oven'…") — brittle crutch, avoid.
Note: "no decision trees" does NOT mean "no code" — the tools ARE code; the *LLM* decides
which to call. And all **facts/math** (calories, fiber, averages) are computed in code and
fed to the model, never guessed by it.

**Current state (built):** real tool-calling is live — the LLM emits `reply` + a list of
`operations` and the DB executor (`applyOperations`) runs them; all facts/math are computed
in code and fed to the model. Tools today: `update_profile`, `regenerate_week`,
`regenerate_day`, `swap_meal`, `answer`. The old `EditIntent` and the hardcoded "no oven"
phrase crutch are **removed.** Every turn is logged as a complete training example
(`data/edit-log.jsonl`), and a synthetic generator (`scripts/gen-synthetic.mjs`) produces a
~450-example seed → `data/finetune.jsonl`.

**Roadmap status:**
1. ✅ **Real tool-calling** — done (general tools, no phrase rules).
2. ✅ **Automatic data collection** — done (usage logs + synthetic seed).
3. **Fine-tune the small model** — pipeline built (`scripts/train_lora.py`,
   `scripts/nutriflow_finetune_colab.ipynb`). **Trains in a free Colab T4 ($0)**, not
   locally: sustained GPU training **bugchecks this desktop** (see hardware reality below).
   The result is a GGUF that runs locally in LM Studio for inference (light and stable).

**Hardware reality — training is cloud-only for this machine.** The mining-board + PCIe-riser
+ RTX 2070 + HDD rig cannot sustain full-GPU training without kernel-panicking (NVIDIA-driver
fault `0x1E`/`0xC0000096`, repeated Kernel-Power 41 reboots, plus a months-long history of
driver/power bugchecks). **Local inference is fine; local training is ruled out.** Fine-tune
on free cloud (Colab/Kaggle T4, $0); train locally only on a future *stable* 24 GB machine.
Bigger models later → **rent a cloud GPU on demand** (a few $ per run), never this rig. More
GPUs add VRAM/capacity, not stability — they would make the crashes worse, not fix them.

## The app replaces a nutritionist — the macro-preservation engine (core role, decided direction)

A **core role of this app is to replace a human nutritionist.** The test that defines it:
if you told a good nutritionist *"I want pancakes for breakfast this week,"* they wouldn't
say no — they'd **find a way to fit the pancakes in while keeping every one of your goals
intact** (calories, protein, carbs, fat, fiber; later vitamins and other micros), adjusting
portions or the other meals so nothing about your targets slips. The assistant must do
exactly this, automatically, for **any** change the user asks for.

**The rule: every edit re-solves the plan so the full set of goals still holds.** A change
is never a naive find-and-replace. When the user swaps, excludes, or regenerates anything,
the system **re-balances whatever else it must** so the day's/week's macro targets are still
met. "Make a change" always implies "…and keep me on track."

**Two layers, and which one owns what (this is the whole design):**
- **Intent — the LLM.** Understands the request and **infers implied constraints from the
  user's settings.** On a high-protein diet, "swap breakfast for pancakes" means "find a
  protein-forward pancake, as high-protein as the meal it replaces" — the user should never
  have to say "protein." The model emits a tool call with the right parameters/intent. It
  does **no math.**
- **Correctness — a deterministic macro engine in code.** Guarantees the numbers. This is
  the non-negotiable substrate: the nutrition equivalent of a compiler + test suite.

**The nutritionist loop (all deterministic once intent is known):**
1. **Slot target.** Each meal slot has a target macro profile derived from the daily goals
   (breakfast = its share of calories/protein/carbs/fat/fiber).
2. **Macro-aware candidate selection.** Pick the recipe that best fits the slot's macro
   profile *and* the diet setting — so "pancakes" resolves to the protein-forward pancake on
   a high-protein plan, automatically.
3. **Scale to fit.** Adjust the new dish's portion toward the slot target.
4. **Rebalance the rest.** Distribute any remaining macro gap across the day's other meals by
   nudging their quantities within realistic bounds, so the day's totals re-hit every target.
5. **Report honestly.** Tell the user what was adjusted ("bumped your lunch chicken 20g to
   hold protein at 150g").

**Rebalancing strategy (default):** a blend — scale the new dish within realistic portion
limits first, then spread whatever remains across the day's other meals so no single portion
looks absurd. **Never sacrifice a hard condition** (diet, allergy, exclusion) to hit a macro;
if a target is genuinely unreachable within the constraints, **say so** rather than break a
rule or fake the numbers.

**The macro vector is first-class and extensible.** Everything carries
`{calories, protein, carbs, fat, fiber}` today; **micros (vitamins, minerals, …) are added
later as more axes on the same vector** — the solver generalizes, it just needs richer
per-ingredient data (**USDA FoodData Central**). Adding micros is a **data** problem, not a
model problem.

**Why this settles "would a bigger model be better?" — permanently:**
- Claude Code is reliable at coding because of its **deterministic substrate** (files,
  compiler, tests), not because the model is huge. This is identical: reliability comes from
  the **macro engine**, not the parameter count.
- Model size helps only **language understanding** — a narrow fine-tune already covers that;
  if it ever falls short, the fix is **more training examples, not more parameters.**
- Model size is **irrelevant to numeric correctness, forever.** We already saw the failure
  mode: when the model did macro math it hallucinated (fiber 64g→9g). **Code owns the math;
  the model never touches it.** A bigger brain would just hallucinate more fluently.

**Build milestones:**
1. **Macro-aware `swap_meal`** — select the candidate by macro-distance + diet fit, then
   rebalance the day so all macros still hold.
2. **Generalize the rebalancer to every operation** (swap, regenerate-day, exclusions) and
   make the `{cal,protein,carb,fat,fiber}` macro vector first-class end to end.
3. **Micros later** — extend the vector + ingredient data (USDA); no architecture change.

## The north star

A meal plan is only successful if it is:

1. **Doable / realistic** — meals a real person can actually shop for and cook. No
   exotic-ingredient soup, no 2-hour weeknight recipes unless asked for.
2. **Adjustable anytime** — the plan is never "final." The user can change any part at
   any moment and the plan re-flows to stay coherent.
3. **Constraint-respecting (hard, not advisory)** — the plan must **fully respect the
   conditions the user set**. Constraints are rules, not suggestions. If the user says
   "no pork" or "vegetarian," a violation is a bug, not a stylistic miss.

Speed matters too, but correctness against constraints comes first: a fast plan that
breaks a rule is worse than a slower plan that honors every rule.

## The constraint hierarchy (the core design problem)

Everything we build is really one problem: **generate/edit a plan that satisfies a
growing set of simultaneous constraints.** Planned layers, in order of when we add them:

1. **Conditions / preferences (now → next):** diet type, allergies, dislikes,
   exclusions ("no onions"), cuisine preferences, cooking effort/time. These are hard
   filters — the plan must never violate them.
2. **Macros (now the core role):** the user sets targets (calories, protein, carbs, fat,
   fiber; micros later). The plan must **respect the macro targets while still honoring every
   condition above**, and **every edit must re-solve so the targets still hold** — rebalancing
   portions/other meals as needed. Numeric and cumulative across the day/week, so it is owned
   by the deterministic macro engine, not the model (see "The app replaces a nutritionist —
   the macro-preservation engine").
3. **Conversational adaptation (later — the big one):** an AI assistant the user talks
   to. The user says something in plain language — e.g. *"I don't want onions this
   week"* — and the assistant **adapts the whole plan** to that instruction **while
   still respecting all previously-set constraints and macros.** The new instruction is
   layered on top; it must not silently break an existing rule. This is a
   re-solve-under-constraints problem, not a find-and-replace.

The mental model: each user statement adds or changes a constraint, and the system
re-derives a plan that satisfies the *full current set* at once. "Make Tuesday
vegetarian," "no onions this week," and "hit 150g protein" all have to hold together.

## What this means for technical decisions

- **Model choice** is judged against this: can it (a) interpret the request and infer
  implied intent, and (b) emit the right tool call? That's a *language* job a fine-tuned
  small model handles well. **Numeric macro-balancing is NOT a model job at all** — it is
  owned by the deterministic macro engine (see "The app replaces a nutritionist"). A bigger
  model never improves correctness; it only improves language fluency, and even that is
  better bought with more training data than more parameters.
- **Validation is a feature, not a safety net.** Because constraints are hard rules, the
  system should *verify* a generated plan against the active constraints (and later,
  macro sums) and reject/repair violations — not trust the model to self-police. The
  existing schema-validation + retry + JSON-repair scaffolding is the seed of this.
- **State of constraints must be explicit.** To adapt a plan to a new instruction while
  keeping old rules, the app needs to persist the current constraint set (conditions +
  macros + conversational deltas) and feed it into every generation/edit.

## When the user asks "is this doable?"

Answer in light of the above: it's doable if the constraint can be (a) expressed
explicitly, (b) enforced by generation-plus-validation, and (c) re-checked whenever the
plan changes. The hard cases are always the numeric (macros) and the compositional
("this new rule, without breaking the old ones") ones — flag those honestly.
