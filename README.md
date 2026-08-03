# NutriFlow

An AI meal planner that aims to **replace a nutritionist** — you talk to it in plain
language ("make Tuesday vegetarian", "I'm still hungry", "rate that dinner 5 stars")
and your weekly plan actually changes, correctly. The long-term vision: share a recipe
or workout video and the AI turns it into your executable plan with one tap.

**Phase 1 is built and working**: an AI weekly meal planner with a chat assistant, a
grocery list that builds itself, and a plan you can edit by conversation. See
[VISION.md](VISION.md) for the product north star and [WORKPLAN.md](WORKPLAN.md) for
what's built, what's next, and why.

## How it works — two layers

The single most important design rule:

> **The language model decides *intent*; deterministic code guarantees *correctness*.
> The model does no arithmetic, ever.**

1. The assistant LLM reads your message and emits a small tool call — one of **17
   tools** (`update_profile`, `regenerate_week`, `swap_meal`, `compute_targets`,
   `log_meal`, `weekly_report`, `eating_out`, `explain_meal`, `substitute_ingredient`,
   `symptom_check`, `lock_meal`, `unlock_meal`, `rate_meal`, `hydration`,
   `scale_portions`, `undo`, `answer`).
2. A deterministic engine ([`src/lib/recipeDb.ts`](src/lib/recipeDb.ts)) executes the
   tool against a real recipe library with USDA-sourced nutrition — hitting your macro
   targets, honouring hard rules (diet, allergies), and computing every number itself.

Because the actions are deterministic, the button-driven ones (rate, pin, resize
portions, undo, the weekly-review and hydration cards) run through
[`/api/operation`](src/app/api/operation/route.ts) with **no model in the loop** — so
they work even while the model is offline (e.g. mid-retrain).

## Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · a provider abstraction for the
AI (Claude API, any OpenAI-compatible local/hosted server, or demo mode).

## Running it

```bash
npm install
# create .env.local (see .env.local.example), then:
npm run dev            # http://localhost:3000
```

With **no `.env.local`** the app runs in **demo mode** (instant sample plan, assistant
disabled) — good for showing the UI with no AI. To use the real assistant, point it at
a provider:

```
AI_PROVIDER=local
LOCAL_AI_URL=http://localhost:1234/v1      # LM Studio, Ollama, or a hosted OpenAI-compatible API
LOCAL_AI_MODEL=<identifier from `lms ps`>  # e.g. the fine-tuned nutriflow-v8
PLAN_ENGINE=db                             # deterministic plan generation (no model needed to build a week)
```

Node isn't always on PATH on the dev machines — it's installed portably under
`%LOCALAPPDATA%\nodejs`; prepend that if `npm` isn't found.

## The local model

The assistant is a small model **fine-tuned in-house** (QLoRA, 4-bit, on an RTX 2070)
so the whole thing runs **free and offline**. The pipeline:

```bash
node scripts/gen-synthetic.mjs             # build the training data (each tool, hand-authored labels)
npm run check:data                         # gate: no contradictions, nulls, invented fields, or eval leakage
python scripts/train_lora.py               # train (RESUME=1 to continue an interrupted run)
npm run train:status                       # a clean progress readout of the latest run
bash scripts/promote-model.sh v9           # merge -> GGUF -> load into LM Studio -> eval, one command
```

Quality is measured on a **held-out** eval set ([`data/eval-cases.json`](data/eval-cases.json)),
kept strictly separate from training (the gate fails on any overlap):

```bash
ENFORCE=1 MODEL=nutriflow-v8 npm run eval:assistant   # the production path (JSON-schema enforced)
```

## Tests

```bash
npm run test:engine     # the deterministic engine: scenarios, invariants (I1–I8), and a fuzzer
npm run test:api        # the HTTP routes: /api/operation allowlist, undo, graceful-offline
npm run check:recipes   # recipe-data integrity (every ingredient priced, macros add up)
npm run check:data      # training-data integrity
```

## Repo map

- [`src/lib/recipeDb.ts`](src/lib/recipeDb.ts) — the engine: recipe library, macro
  solver, and every tool's executor.
- [`src/lib/types.ts`](src/lib/types.ts) — the zod schemas that are the data contract.
- [`src/lib/ai.ts`](src/lib/ai.ts) — the provider system (claude / local / demo) and the
  assistant prompt.
- [`src/app/plan/page.tsx`](src/app/plan/page.tsx) — the app shell (week board, Explore,
  groceries, chat, meal drawer, coach card).
- [`scripts/`](scripts/) — data generation, training, evaluation, and integrity gates.

## Project rules

- **No emoji in the UI** — SVG line icons and real photography only.
- **Commits are authored solely by the owner**; no AI co-author trailers.

Deeper docs: **[CLAUDE.md](CLAUDE.md)** (architecture handoff) ·
**[VISION.md](VISION.md)** (product north star) · **[WORKPLAN.md](WORKPLAN.md)** (the
ordered build plan and its lessons) · **[SITE.md](SITE.md)** (running the local site).
