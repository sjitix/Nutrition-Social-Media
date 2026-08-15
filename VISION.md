# NutriFlow — product vision & the road ahead

This file captures the *behavioral* north star for the meal planner — what a "good"
result actually means and the capabilities we're building toward. CLAUDE.md holds the
phased build order; this file holds the **quality bar and the constraint model** that
every phase must satisfy. Read it before judging whether a feature or model is "good
enough" — the answer depends on these goals.

## Hard constraint: $0 running cost, local-only AI

> **⚠️ SCOPED 2026-08-16 — read this before quoting the rule below.** This section used to forbid
> paid AI APIs outright, "even for the hard reasoning parts". That is now in direct conflict with
> the agent goal decided later in this document, and the conflict is resolved as follows:
>
> - **The engine stays $0 and always will.** It is pure TypeScript, calls no model, and every
>   number in the app comes from it. Nothing about correctness costs money — that is settled.
> - **The FREE/OFFLINE TIER stays local**: the fine-tuned model in LM Studio, and demo mode with
>   no configuration at all. The app must keep working with no keys, forever.
> - **A keyed frontier model is the accepted path to agent-grade behaviour.** See "Conversational
>   assistant": planning across steps, recovering from a failed action and answering the case
>   nobody wrote an example for is capability, and capability tracks scale. A 7B will not do it.
>
> So: **$0 is a floor the product must always run at, not a ceiling it may never exceed.** The
> provider abstraction already makes this a one-line change (`AI_PROVIDER`), which is exactly why
> it was built that way.

The original rule, kept because most of it still holds: the app must cost **nothing** to run in
its free tier — all inference runs on the owner's **local hardware** via LM Studio. The way to get
reliable results from a small local model is **not** to buy a bigger brain — it's to **enforce
correctness in code**: generate → validate the output against the active constraints/macros with
deterministic checks → re-prompt to repair any violation. **Correctness lives in code that can't be
wrong, not in the model** — that half is permanent and applies at every model size.

*(Struck: the claim that a bigger model "only improves variety and fluency", and the plan to add
more RTX 2070s. The first is corrected at length further down; the second is rejected in the
hardware block — extra cards pool VRAM only under FSDP/ZeRO-3, which is slow and fragile over PCIe
risers, so the answer for bigger models is renting a cloud GPU on demand.)*

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

**STATUS — the database exists.** `src/lib/recipeDb.ts` holds **501 curated recipes**, and the
selection engine is live: `selectWeekFromDb` picks against the constraint set, `rebalanceDay`
holds the day on target, and macros are computed from the ingredient list against USDA rather
than written on the card. This section is now a record of *why* it was built this way, not a plan.

What the prediction got right and wrong, worth keeping:

- **Right: selecting beats inventing.** Macros come from data, diversity is structural, and every
  user control became a filter rather than a hope.
- **Right: curated thousands, not scraped millions.** 501 hand-curated recipes generate varied
  weeks with no repeats. The gate that proves it is `npm run export:recipes`, whose Gaps sheet
  reports how many recipes survive each filter per slot; under seven means a week must repeat.
- **Wrong in one respect: the ingredient table is the real constraint, not the recipe count.**
  New recipes can only use ingredients already curated to an FDC id, because auto-matching to USDA
  is unsafe — it produced `salmon fillet → Salmonberries`. So library growth is gated on
  hand-curating ingredients, and cuisines whose staples are missing (Indian: no paneer, ghee,
  garam masala or coconut milk) stay shallow until that work is done. That is the next real
  constraint on variety, and it was not foreseen here.

## Conversational assistant — architecture & roadmap (decided direction)

**Vision:** a real LLM you talk to that changes the plan and settings the way Claude
Code changes files — general, adaptive to *anything* you say, not an if-else/decision-tree
chatbot. It should feel like talking to Claude/ChatGPT, and it effectively edits the app.

### What "an agent, not a classifier" means — the owner's own framing (2026-08-15)

**The owner's words, exactly as written** — quoted rather than paraphrased, because the rest of
this section has repeatedly been read as something narrower than it says, and a summary is what
let that happen:

> It should still do more than that , more tahn just identify words and do something when you
> see word. The goal of this project is to make an agent/ an assistent as your personal
> nutritionist. Exactly like you are a coding agent and can advise me ab anything , you are a
> general llm , who can execute requests and do what i say no matter the phrasing i use, and you
> can edit things in my code, my ide, my laptop, use my bash and my powershell command and
> modify things based on what i say. Thats how this agent hsoul dbe too , it should have general
> understanding, it should be able to decide based on the information i give it , it should be
> able to act and make verything more conveninet for me as the user, so that anyone can use it
> like i use claude code, with maximum eficciency.

The bar is therefore **not** "recognise the request and fire the matching tool." It is:
understand anything, decide what to do about it, do it, check what happened, and keep going
until the person's actual problem is solved.

**Three things separate what exists from that, and only one is the model:**

1. **There is no loop.** `src/app/api/assistant-v2/route.ts` is single-shot: message in, one
   turn out, apply, respond. A coding agent acts, reads what came back, notices it failed or
   surprised it, and re-plans — often many times before answering. Ours gets one move.
2. **It never observes its own action.** `applyPrimitives` returns `notes`, `planChanged` and
   `profileChanged` — the engine says what it really did, including when it refused or relaxed
   something. All of that reaches the USER and none of it reaches the MODEL.
3. **Its hands are small.** It can emit primitives against one week's plan. It cannot read the
   saved recipes, the import history, the streak, or the profile's own memory. General
   understanding with a narrow action surface still feels narrow to the person using it.

**Build order (1 and 2 need no GPU, no keys, and no trained model):** the loop first, because it
is the largest change in how the thing *feels* and it is independent of which model is behind
it; then widen what it can see and touch; then swap the brain and measure.

### The goal, stated plainly

> **The agent must be able to UNDERSTAND everything, READ everything, DECIDE from what it read,
> and CHANGE everything — the way a coding agent does.**

Not "parse the sentence and fire the matching tool." It should take any phrasing, look up whatever
it needs to answer properly, judge what to do, do it, check what actually happened, and keep going
until the person's real problem is solved — and it should be usable that way by anyone, not only
by someone who knows the magic words.

### Three rules that follow from it — these are binding

**RULE 1 — A TOOL CALL IS A QUERY. QUERIES BEAT CONTEXT STUFFING.**
The library is 501 recipes with ingredients and steps; it cannot go in a prompt, and putting a
slice of it there is worse — the model then reasons over an arbitrary, stale subset and cannot
tell that it is doing so. **Give it read tools and let it ask.** `find_recipes(filter)` returns
up to ten rows it chose (the cap the schema sets); that is a query, and it is the same reason a coding agent greps a repository
instead of reading all of it. This turns read tools from a nice extra into **the only thing that
makes the library usable at all**, and it is why the read surface comes before the write surface.

**RULE 2 — THE LOOP IS DETERMINISTIC INFRASTRUCTURE, AND MUST BE TESTED WITH NO MODEL AT ALL.**
The harness — call, execute, feed the result back, call again, stop — is ordinary code. Test it
with a scripted fake provider returning canned turns: one that asks for a read, one that acts, one
that stops, one that never stops, one that emits garbage. Assert that it terminates, that it caps
its steps, that engine `notes` are fed back, and that it recovers from a rejected operation. This
needs **no GPU, no keys and no trained model**, it belongs in `npm run test:engine`, and it means
that the day a real model is plugged in, the harness is already known-good. **Build and test the
loop BEFORE the model, not after** — otherwise a harness bug and a model weakness are
indistinguishable.

**RULE 3 — THE AGENT ACTS UNPROMPTED. "CONVENIENT" MEANS IT SPEAKS FIRST.**
Everything built so far is reactive: the user types, it answers. A real nutritionist says
*"Thursday is 40 g short on protein"* **before** being asked. The engine already computes that —
`weekly_report`, and the shortfall rendered on Home. So the agent should be able to open with it,
and offer a fix that is accepted in one tap. This is a **standing check that produces a
suggestion**, not a chat turn, and it changes the shape of the interface rather than only the
model. Treat it as in scope: an assistant that only ever responds is a command line with manners.

### ⚠️ BUILD STATUS: all of the above is DESIGN. None of it is implemented.

As of 2026-08-16, `src/app/api/assistant-v2/route.ts` is still single-shot — one model call, apply,
respond. There is no loop, no read surface and no `what_if`.

- **The specification lives in `ASSISTANT-SCHEMA.md`**, in the v3 section at the bottom: seven read
  tools with their arguments and return shapes, the loop contract (MAX_STEPS 8, engine notes fed
  back, one undo snapshot per user turn), and the five fake-provider cases that test it.
- **It needs no GPU, no keys and no trained model.** Rule 2 is the reason: build and test the
  harness against a scripted provider first.
- **Do not confuse it with `READ_ONLY_TOOLS` in `src/lib/reply.ts`.** Those are user-facing answers
  whose output *is* the reply. The read surface is model-facing: its output goes back into the loop
  and the user never sees it. Both are "does not change the plan" and nothing else about them is
  alike.

### Accounts: decided, and blocked

**Real accounts with a hosted database (Supabase) were chosen** over a browser-local profile, so
saves and plans follow a person across devices. **Nothing is built.** It waits on a Supabase
project being created and its Project URL + anon key supplied; the `service_role` key must never
come near this public repo. `src/lib/savedStore.ts` is already the seam. Two constraints hold:
the app must keep working with **no keys configured** (the GitHub Pages preview is a static export
with no server), and RLS policies must be written so a signed-in person can only ever read and
write their own rows.

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

**Hardware reality — SUPERSEDED 2026-08-15.** This used to say local training was ruled out
because the rig kernel-panicked (`0x1E`/`0xC0000096`, repeated Kernel-Power 41 reboots). The
cause was the old **Ryzen 1700** — that fault code is a classic unstable-CPU signature — and
since the **3700X** swap sustained full-GPU load has been stable. **It has now been proven in
the hardest possible way:** a 7B QLoRA ran on that desktop for roughly six days, 409 steps at
~20 min/step, and finished. Local training is not ruled out; it is slow.

What remains true: the RTX 2070's **8 GB is the binding constraint** (the 7B run sat at
7.9/8 GB, leaving ~97 MB spare, so any other GPU consumer spills it to system RAM and collapses
throughput), and for anything bigger the answer is still to **rent a cloud GPU on demand** rather
than add cards — more GPUs pool VRAM only with FSDP/ZeRO-3, which is slow and fragile over PCIe
risers with no NVLink. Keep the rig for **inference serving**, which is what it is good at.

**Where the trained artefact lives, and it is not in this repo.** `scripts/train_lora.py` writes
the adapter to `models/nutriflow-lora`, and `/models/` is gitignored — correctly, since the repo
is public. Nothing about it is on the GPU: VRAM is volatile, the run checkpointed to disk every
10 steps, and powering the machine off cost nothing. But it means the adapter exists as **one
copy, on one drive, in one house** — on a machine whose SSD has already died once. Back it up
before merging anything.

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

**Why this settles "would a bigger model be better?" — for CORRECTNESS, which is what it was
ever about:**
- Claude Code is reliable at coding because of its **deterministic substrate** (files,
  compiler, tests), not only because the model is large. This is identical: correctness comes
  from the **macro engine**, not the parameter count.
- Model size is **irrelevant to numeric correctness, forever.** We already saw the failure
  mode: when the model did macro math it hallucinated (fiber 64g→9g). **Code owns the math;
  the model never touches it.** A bigger brain would just hallucinate more fluently.

> **⚠️ CORRECTED 2026-08-15.** This section used to also claim that *"model size helps only
> language understanding — a narrow fine-tune already covers that; if it ever falls short, the
> fix is more training examples, not more parameters."* **That is wrong under the agent goal
> stated at the top of this section, and it was written to justify the small-model path.**
>
> Handling any phrasing is language understanding, and a fine-tune does cover it. But planning
> across several steps, noticing that an action did not do what it intended, recovering from
> that, and answering something nobody wrote a training example for is **capability**, and
> capability tracks scale. A 7B trained on 3,272 in-domain examples will be strong on the shapes
> it saw and brittle just outside them. It will not feel like Claude Code, however good the data.
>
> What survives intact is the **architecture**: reason-then-act, over general composable
> primitives, on a deterministic engine. That shape does not care how big the brain is — which is
> exactly why the fine-tune is not wasted work. It is the free/offline tier and the proof the
> design holds, and swapping in a frontier model is `AI_PROVIDER` plus a key, not a redesign.
> **Correctness never needs a bigger model. Feeling like an agent does.**

**Build milestones:**
1. ✅ **Macro-aware `swap_meal`** — selects the candidate by dish match, tie-broken toward
   the slot's macro profile (protein-forward pancake on a high-protein plan), then holds the
   day on target.
2. ✅ **Two-lever day solver** (`rebalanceDay` in `recipeDb.ts`), wired into swap, regenerate-day,
   and week/profile changes:
   - **Lever 1 — portion scaling:** gradient descent on per-meal scale factors matches the
     day's `{cal,protein,carb,fat,fiber}` vector (protein weighted highest), within realistic
     0.6–1.8× limits.
   - **Lever 2 — protein re-selection:** when scaling can't raise protein at fixed calories,
     upgrade the weakest non-locked meal to a higher-protein same-type recipe ("bumped your
     lunch to make room"), avoiding cross-day repeats.
   - The swapped-in dish is **locked**; only the other meals move. Verified: initial week holds
     every day ~2000 kcal / ~145g protein; a low-protein swap recovers protein and holds calories.
3. ✅ **LLM-controlled intent** — `preserveMacros` (default on = nutritionist default). The model
   sets it false only for an explicit treat ("cheat day"), so behaviour is the model's decision,
   not a keyword trigger. **Honest reporting:** the engine returns the resulting kcal/protein +
   what it upgraded, which the route appends to the LLM's reply (the LLM does no math).
4. **Micros later** — extend the macro vector + ingredient data (USDA FoodData Central); the
   same solver balances the new axes, no architecture change.

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
