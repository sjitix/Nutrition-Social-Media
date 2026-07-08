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

**Current state:** `EditIntent` (a single-shot, baby version of tool-calling) + a DB
executor (`applyEdit`) + code-computed facts. A hardcoded "no oven" phrase catch exists
as a TEMPORARY crutch — to be removed when tool-calling lands.

**Roadmap (all consistent with the vision):**
1. **Refactor to real tool-calling** — the LLM outputs a list of operations (tool calls);
   the app executes them in order. Remove hardcoded phrase rules. General tools like
   `regenerate(scope, constraints)`, `swap_meal(day, mealType, description)`,
   `set_target(field, value)`, `exclude(foods)`, `set_diet(...)`, `answer(question)`.
2. **Automatic data collection** — every message + the tool calls it should produce is
   appended to `data/edit-log.jsonl`; the training set builds itself from real usage.
3. **Fine-tune a small local model** (LoRA/QLoRA) on that data → a fast, local, $0-at-
   inference LLM that is reliable at THIS task's tool-use without hardcoded phrases. This
   is the "general language model, trained specifically for this task, but still an LLM."

**Constraints / reality:** keep $0 + local for inference. Fine-tuning needs more VRAM
(~a 3090) or a cheap one-off cloud run — do it once data + hardware are ready. Interim:
prompt-engineered tool-calling on the local 7B (more general, less reliable until fine-
tuned); a stronger model can be used temporarily during development. Why not just use a
big model? It breaks $0 (hosted) or is slow (30B offloaded on 8 GB). Fine-tuning a small
model is the fit for the constraints.

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
2. **Macros (later):** the user sets targets (calories, protein, carbs, fat). The plan
   must **respect the macro targets while still honoring every condition above.** This
   is the harder constraint because it's numeric and cumulative across the day/week, not
   just a yes/no filter. Expect this to need per-meal macro estimates that sum to target.
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

- **Model choice** is judged against this: can it (a) produce realistic, varied meals,
  (b) never violate hard filters, and (c) later, hit numeric macro targets? Simple
  exclusions a small model handles well. Numeric macro-balancing and multi-constraint
  chat edits are the parts that may need a stronger model — or code-side validation that
  checks constraints and re-prompts on violation.
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
