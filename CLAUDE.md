# NutriFlow — project brief

AI-powered weekly meal planner (Phase 1 is built and working), evolving toward a
social platform where recipe and workout videos convert into your actual meal or
training plan with one tap. This file is the handoff/context doc — read it first.

## What it is (vision + roadmap)

An app that turns the recipe/workout videos people save on TikTok/Instagram into an
executable plan. You share a reel, the AI extracts the recipe (ingredients, macros,
steps) into your weekly plan, and a grocery list builds itself. An AI assistant edits
the week by chat ("make Tuesday vegetarian"). Later phases add an in-app feed and a
workout vertical.

Phased build order (one phase at a time, each usable on its own):
1. **DONE** — AI meal planner + chat assistant (web MVP)
2. Share-a-reel importer: paste a TikTok/IG/YouTube recipe link → AI extracts it into the plan
3. In-app feed (Pinterest/TikTok-style) seeded with recipes, each with an "Add to plan" button
4. User uploads / creator tools
5. Workout vertical (same mechanic for gym content)

## Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · AI via a provider
abstraction (Claude API, or any local/OpenAI-compatible server, or demo mode).

## Running it

```bash
npm install
# create .env.local (see below), then:
npm run dev          # http://localhost:3000
```

Node.js isn't on the system PATH by default on these machines — it was installed
portably under %LOCALAPPDATA%\nodejs. If `npm` isn't found, prepend that to PATH.

`.env.local` is gitignored (it can hold a secret) so it does NOT clone — recreate it.
The three provider options are documented in `.env.local.example`. For the desktop
with LM Studio, `.env.local` is just:

```
AI_PROVIDER=local
LOCAL_AI_URL=http://localhost:1234/v1
LOCAL_AI_MODEL=openai/gpt-oss-20b     # or whatever model is loaded in LM Studio
```

With no `.env.local`, the app runs in **demo mode** (instant sample plan, assistant
disabled) — good for showing the UI without any AI.

## Architecture — key files

- `src/lib/ai.ts` — the AI provider system. `resolveProvider()` picks claude/local/demo.
  Local path generates the week one day per request (schema-validated), with retries,
  model fallback, and JSON repair for imperfect open models. `LOCAL_AI_CONCURRENCY`
  (default 1) = sequential, which is fastest on a single GPU.
- `src/lib/types.ts` — zod schemas (WeekPlan, Meal, AssistantResponse) = the data contract.
- `src/lib/recipes.ts` — Explore-page demo recipes + meal→photo keyword mapping.
- `src/lib/demo.ts` — sample plan for demo mode.
- `src/app/api/plan/route.ts` / `assistant/route.ts` — the two API endpoints.
- `src/app/plan/page.tsx` — the main app shell (sidebar, Home/Tonight hero, Week board,
  Explore wall, Groceries, Assistant chat, meal detail drawer).
- `src/app/onboarding/page.tsx`, `src/app/page.tsx` — onboarding + landing.
- `src/components/icons.tsx` — SVG line icons + wordmark (no emoji).
- `public/food/` — licensed food photos.

## AI provider setup (the local-AI strategy)

The app talks to "a provider," so swapping models/hosts is a one-line env change:
- **Claude** — best quality; set `ANTHROPIC_API_KEY` (paid).
- **Local** — free/unlimited; `AI_PROVIDER=local` + `LOCAL_AI_URL`. Works with LM Studio
  (:1234), Ollama (:11434), or a hosted OpenAI-compatible API like OpenRouter (add
  `LOCAL_AI_API_KEY`). Local servers get JSON-schema enforcement; keyed hosted routes
  fall back to prompt-instructed JSON.
- **Demo** — no config; instant sample.

Provider ladder: local for dev/beta (free), cheap open-model API + Claude at launch,
self-host only if the inference bill gets large.

## Hardware / local-AI plan (desktop)

Desktop: 64 GB RAM, up to 4× RTX 2070 (8 GB each), Corsair HX1200i PSU (1200W — enough
for all 4 cards), ASrock ~6-slot (mining) board, Windows 10 on an HDD (SSD died — keep
backups; the HDD only slows model *loading*, not generation).

Model choice by hardware:
- **Now (1 GPU + 64 GB RAM):** run **gpt-oss-20b** — a mixture-of-experts (MoE) model.
  20B-class quality but only ~3.6B active per token, so it lives in RAM, offloads to the
  8 GB GPU, and runs at usable speed. Fixes the small-model quality gaps. A dense 8B
  (Qwen 2.5 7B / Llama 3.1 8B) fully on the GPU is the faster-but-simpler alternative.
- **With more GPUs (VRAM pools, not speed):** 2 cards → 14B dense / 20B MoE; 4 cards →
  32 GB → a 30B model (e.g. Qwen3-30B-A3B). App needs no changes — just load a bigger
  model in LM Studio.

LM Studio: load model, push GPU offload to max, context >= 8192, Start Server on :1234.

## Project rules (important)

- **No emoji in the UI.** Professional look only — SVG line icons and real photography,
  never emoji as icons. (Emoji-as-icon reads as AI-generated.)
- **Never add AI as a git co-author, committer, or repo collaborator.** Commits are
  authored solely by the owner. Do not add `Co-Authored-By` trailers.

## Repo

Private GitHub repo: https://github.com/sjitix/Nutrition-Social-Media (branch `main`).
This is how the project moves between the laptop and desktop.