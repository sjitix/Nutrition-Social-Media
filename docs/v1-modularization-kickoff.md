# V1 + Modularization — kickoff brief for the next conversation

*Read `CONTEXT.md` first — its top block is the live cross-session state (batch mode done; Kimi K3 beta
in progress). This doc is the AGENDA for a NEW planning conversation. To open that conversation, the owner
pastes **"The prompt"** below; the agent should also read this whole file plus `CONTEXT.md`, `CLAUDE.md`,
`VISION.md` and `WORKPLAN.md`.*

---

## The prompt (paste this to start the new conversation)

We're starting a **planning** conversation to drive NutriFlow to **Version 1**. Read this whole thing
first, then `CONTEXT.md`, `CLAUDE.md`, `VISION.md` and `WORKPLAN.md`. Don't start coding — the output of
this conversation is a plan we then execute over the following days.

**1. Set DAILY milestones to ship Version 1.** Break the remaining work into the product **dimensions**
(the modules / features) and set **day-sized milestones** — one usable increment per day — so every day
moves us measurably closer to a V1 release. I want these dimensions tackled **individually and at the same
time**, and I want the **relationships between the modules kept optimal**: how the modules connect matters
as much as what each one does. First job is to enumerate the dimensions/modules honestly against the code
and the roadmap, then lay them out as a day-by-day schedule with dependencies made explicit.

**2. Modularise the whole app — this is the heart of it.** I believe good code runs on modular design:
independent modules that piece together like factions, resembling **APIs and ADTs (abstract data types)**.
I want our whole project reorganised that way — for organisation, security, and good coding practice. The
principle, in my words:

> I create a function, I give it a name and a description. The user of that function only knows the name
> and the description. If I change the backend of that function, it still does the exact same thing it
> promised in its description — without breaking the code that uses it.

So the problem I really want you to tackle, **explicitly and per module**, is:
**"what stays PUBLIC to a module, and what stays PRIVATE to it?"** Every module should expose a stable
**contract** (a name + a description + a signature) and hide its internals, so we can rewrite a module's
backend and nothing that depends on it breaks, as long as the module keeps its promise. Map this across the
**entire** app: for each module, define its public surface, its private internals, its invariants, and who
is allowed to depend on it. Then propose the reorganisation (folder/boundary structure, what to split, what
to merge) that makes those boundaries real and enforceable, without breaking the green test suite.

**3. Kimi K3 — keep the thread alive.** We're beta-testing Kimi K3 for free on NVIDIA's NIM tier to decide
whether Kimi-scale quality is worth buying hardware for. (Do NOT argue "we don't need the params" — the
point is to try it first.) Read the clean eval scorecard (see the Kimi section below / `CONTEXT.md`), then
help me make the hardware/hosting call. The emotional-case behaviour we saw is a prompt fix, not training.

**4. Build a daily-history page.** I want a page/log where we record, for each day of work: what we
accomplished, which milestone we tackled, how much of it we solved, what other issues we hit, and whether
those go on tomorrow's (or a later day's) todo. A separate artifact for this would be nice — **but there
may already be existing software that does this, so SEARCH for it first** before building something
bespoke, and tell me the options with a recommendation.

**Deliverables of this conversation:**
- A **module map**: every module, its public contract (name + description + signature), its private
  internals, its invariants, and its allowed dependents — plus the reorganisation proposal to enforce it.
- A **day-by-day V1 milestone schedule**: the dimensions as day-sized milestones, worked individually and
  in parallel, with dependencies and the "usable on its own" bar per day.
- The **Kimi K3 decision** (hardware vs fast-cloud vs stay-local), argued from the scorecard.
- A **daily-history approach**: existing software surveyed, a recommendation, and a plan for the page/log.

Keep it honest and grounded in the actual code — verify claims before writing them into the plan.

---

## Context the new agent needs

### Where the project is
- **Shipped:** AI meal planner + chat assistant, deterministic recipe DB + selection engine (501 recipes,
  USDA-derived macros), micronutrient engine, URL + video reel importer, in-app feed/Explore, a full
  `/sage` design system, and — most recently — a complete **batch / meal-prep planning mode** (`docs/batch-mode/`).
- **Not started (roadmap):** user uploads / creator tools (Phase 4), the workout vertical (Phase 5),
  and real accounts (a hosted DB; `savedStore.ts` is the seam, waiting on a Supabase URL + anon key).
- **Known open quality threads:** assistant sometimes invents non-library recipes, emoji in replies, weak
  fuzzy swap-match; the crisis-guard pre-scan must land before any live model ships publicly.

### Seams that already follow the modularization principle (use them as the model)
- `src/lib/storage.ts` — the ONLY place that knows a localStorage key name (all keys in `KEYS`).
- `src/lib/savedStore.ts` — a 3-method async interface (`list`/`add`/`remove`) over saved recipes;
  async on purpose so a network can slide behind it without changing call sites.
- `src/lib/reply.ts` — `composeReply` + `READ_ONLY_TOOLS`; engine notes are authoritative.
- `src/lib/agentTools.ts` — the agent's read surface (seven pure lookup tools the model calls, user never sees).
- `src/lib/agentLoop.ts` — `runAgent` with the **model injected as a `ModelFn`** (the seam that makes the
  whole loop testable with no model). These are the shape the rest of the app should be refactored toward.

### The two-layer rule that must survive any re-architecture
The MODEL only decides; the deterministic ENGINE does all arithmetic and is the only thing allowed to claim
a change happened. Macros are never stored on a recipe — `deriveMacros` computes them from ingredients
against USDA data. Do not collapse these layers when modularising.

### Kimi K3 beta — state at this handoff
- **Free path:** NVIDIA NIM (`build.nvidia.com`), OpenAI-compatible at `https://integrate.api.nvidia.com/v1`,
  `nvapi-` key, no card, 40 RPM. `moonshotai/kimi-k3` is provisioned free; `kimi-k2.6` is not (404).
- **Free-tier reality:** ~200–250s latency per request (queue wait), served in parallel, so the eval uses
  `EVAL_CONCURRENCY` (+ 429 retry + per-request timeout — all added this session; see `scripts/eval-hardcases.mts`).
  To run it: `BASE_URL=https://integrate.api.nvidia.com/v1 MODEL=moonshotai/kimi-k3 LOCAL_AI_API_KEY=<nvapi-key>
  EVAL_CONCURRENCY=3 npm run eval:hardcases` (key stays in the ENV, never in `.env.local`).
- **Baseline to beat — gpt-oss-20b (local, 45 cases): schemaOk 100%, actedRight 84%** (do 24/27, clarify
  6/7, refuse 5/5, **decline 3/6** — it FAKES declines and guesses a weight-loss deficit).
- **K3 preview:** strong on DO (beat gpt-oss on `pin-keep`, `general-qa`); over-acts on emotional cases
  (`health-period`, `eating-problem`) — a prompt fix. The clean full re-run's `decline` bucket vs the 84%
  baseline is the deciding number. Free K3 is a batch service (~4 min/reply > Vercel timeout), so a free
  hosted beta = fast free model for the live site + free K3 for offline evals only.

### Standing rules (unchanged — from `CLAUDE.md`)
- **No emoji in the UI** — SVG line icons + real photography only.
- **Commit AND push after every significant step**, without being asked; never push a red gate
  (`npm run test:engine` for `src/lib` changes, `tsc` + `npm run build` otherwise).
- **Commits are authored solely by the owner** (`sjitix <adrawing26@gmail.com>`); never add an AI co-author.
- **Keep the four docs current** (`CONTEXT.md`, `CLAUDE.md`, `VISION.md`, `WORKPLAN.md`) — edit in place,
  verify against the repo before writing. As modules get defined, fold the module map into `CLAUDE.md`.
