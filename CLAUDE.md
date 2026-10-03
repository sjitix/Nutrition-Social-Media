# NutriFlow — project brief

AI-powered weekly meal planner evolving toward a social platform where recipe and workout
videos convert into your actual meal or training plan with one tap.

**Read `CONTEXT.md` first** — it holds current state and where the last session left off. This
file is the standing brief: how the repo works and the rules that do not change. **VISION.md** is
the product north star (quality bar, and the constraint model: conditions → macros →
conversational adaptation). **WORKPLAN.md** is the accurate build record, including a long list of
hard-won lessons worth reading before repeating one.

## What it is (vision + roadmap)

An app that turns the recipe/workout videos people save on TikTok/Instagram into an
executable plan. You share a reel, the AI extracts the recipe (ingredients, macros,
steps) into your weekly plan, and a grocery list builds itself. An AI assistant edits
the week by chat ("make Tuesday vegetarian"). Later phases add an in-app feed and a
workout vertical.

Phased build order (one phase at a time, each usable on its own):
1. **DONE** — AI meal planner + chat assistant (web MVP)
2. **DONE** — Share-a-reel importer. URL path is deterministic (schema.org/Recipe JSON-LD, no
   model); the video path (TikTok/IG/YouTube) reads the caption and the model extracts structure
   only — never nutrition.
3. **DONE** — In-app feed: the whole macro-validated library as filterable cards with "Add to plan".
4. User uploads / creator tools — *not started*
5. Workout vertical (same mechanic for gym content) — *not started*

Also shipped beyond the phase list: a **deterministic recipe database and selection engine**
(`recipeDb.ts`, 501 recipes with USDA-derived macros), a **micronutrient engine**, and a
**product-wide UX overhaul** (mobile, WCAG AA, PWA, OG cards). See WORKPLAN.md.

## Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · AI via a provider
abstraction (Claude API, or any local/OpenAI-compatible server, or demo mode).

## Running it

```bash
npm install
# create .env.local (see below), then:
npm run dev          # http://localhost:3000
```

Node may not be on PATH on every machine here. On the laptop it is, at
`C:\Program Files\nodejs`; the desktop has a portable install under `%LOCALAPPDATA%\nodejs` —
prepend that if `npm` is not found.

**`npm run dev` is slow to change tabs, and it is not the app.** Next compiles each route on its
first visit in dev. Measured on this laptop: the first navigation to Explore took **5.9 s**,
Assistant 3.6 s, Groceries 3.2 s — while every WARM navigation was 70–135 ms. The same first
visits against a production build are **13–20 ms**. So when someone is reviewing the design rather
than editing it, serve the build:

```bash
npm run build && npx next start -p 3000
```

Do not go looking for a performance bug in the app because tab presses feel slow in dev.

**Never run `npm run build` while `npm run dev` is running.** They share `.next`, and the
production output breaks the dev server's chunk map — every page then serves blank white with
`Cannot find module './611.js'`. Stop dev first, or delete `.next` afterwards.

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

**The engine (pure TypeScript, no network, no model — this is where correctness lives)**

- **`src/lib/plan/` — the engine, the heart of the app** (split out of `recipeDb.ts` in V1 A3):
  `library` (`RECIPES` with macros computed — **macros are never written on a recipe**, `deriveMacros`
  computes them from the ingredients against USDA data), `rules` (diet/allergen/budget predicates),
  `rebalance` (`rebalanceDay`, portions within 0.6–1.8×), `select` (the constraint-filtering
  selector, `withSeed`), `batch` (meal-prep), `report` (totals and every note-writer), `boost`,
  `candidates` (`swapCandidates`), and `execute` (`applyOperations` — the executor every tool call
  runs through — and `previewOperations`). **`plan/index.ts` is the public surface**; anything not
  re-exported there is private to the folder, and `check:boundaries` enforces it.
- `src/lib/recipeDb.ts` — a 10-line barrel over `plan/` + the recipe types, kept so every
  `@/lib/recipeDb` import works unchanged. **Add engine code in `plan/`, not here.**
- `src/lib/data/seeds.ts` — **the 501 recipes as authored**, and the recipe types (`Recipe`,
  `DietTag`, `Cuisine`, `MainProtein`). Moved out of `recipeDb.ts` in V1 milestone A2; it imports
  nothing. Add a recipe HERE. `recipeDb` re-exports the types, so `@/lib/recipeDb` imports still work.
- `src/lib/nutrientTable.generated.ts` — USDA per-100g values, every entry keyed to a real
  `fdc_id`. Generated by `npm run build:nutrients`; do not hand-edit.
- `src/lib/nutrients.ts` — micronutrient maths, `gramsFor` unit conversion, coverage reporting.
- `src/lib/exclusions.ts` — allergen/diet matching. Word-aware, in both directions. Read the
  header before touching it; the comments record real allergen exposures this code has caused.
- `src/lib/targets.ts` — Mifflin-St Jeor, hydration. `src/lib/substitutions.ts`,
  `src/lib/symptoms.ts` — curated data for those tools.
- `src/lib/units.ts` + `unitGrams.generated.ts` — `gramsFor` and the unit weights, **kept apart from
  the USDA table** so browser code that only converts units does not download it (A4). Both generated
  files come from `npm run build:nutrients -- --emit`.
- `src/lib/feedFilter.ts` — the feed's card type and the pure `filterFeed`/`sortFeed`, **client-safe**.
  `src/lib/feed.ts` builds `FEED_RECIPES` from the engine and is SERVER-only; it re-exports
  `feedFilter`, so server code may import either. A client component imports `feedFilter` and gets its
  cards as a prop (see `sage/explore/page.tsx`) — `check:boundaries` rule 4 fails the other way.
- `src/lib/feed.ts` — the library as filterable cards. `filterFeed`/`sortFeed` are pure and
  tested; call them rather than writing new filter logic.
- `src/lib/grocery.ts` — aisle categoriser, pure and tested.
- `src/lib/primitives.ts` — the v2 assistant vocabulary + `applyPrimitives`.
- `src/lib/reply.ts` — `composeReply` (engine notes are authoritative; the model's prose only fills
  in when the engine is silent) and `READ_ONLY_TOOLS`, the set that must never report a plan change.
  Imported by all three assistant routes. **Do not confuse `READ_ONLY_TOOLS` with the read surface
  specified in `ASSISTANT-SCHEMA.md` v3** — these are user-facing answers, those are model-facing
  lookups whose results the user never sees.
- `src/lib/agentTools.ts` — the agent's **read surface**: seven pure lookup tools
  (`find_recipes`, `inspect_recipe`, `get_plan`, `get_profile`, `get_saved`, `report`,
  `what_if`) that the MODEL calls and the user never sees. Each reuses tested engine code rather
  than reimplementing it, `what_if` clones before simulating, `runReadTool` returns `{ error }`
  instead of throwing, and `MAX_ROWS` caps every list.
- `src/lib/agentLoop.ts` — `runAgent`: call, execute, feed the results back, call again, stop.
  `MAX_STEPS = 8` is a cap, not a target, and hitting it is reported rather than hidden. **The
  model is injected as a `ModelFn`**, which is what lets the whole loop be tested with a scripted
  provider and no model at all. Writes still go through `applyPrimitives` — the loop does no
  arithmetic and cannot claim a change the engine did not make.
- `src/lib/types.ts` — zod schemas (WeekPlan, Meal, AssistantResponse) = the data contract.
- `src/lib/storage.ts` — **the only place that knows a localStorage key name.** Every persisted
  thing (profile, plan, batchPlan, chat, imports, saved, grocery check-offs, visits) is a store in
  `KEYS` here. Do not invent a key elsewhere: a second saved-recipes key was added once and the two
  lists drifted apart silently until an audit caught it — and since accounts, **a key named anywhere
  else is also invisible to sync and export**. Every save stamps a write time and notifies
  `onStoreChange` listeners; that is the whole seam sync hangs off, and why its load/save API never
  had to change. Owned by the accounts lane (`docs/parallel/`).
- `src/lib/account/` — **accounts: local-first, the account is a mirror.** `portable.ts` (the export
  file), `validate.ts` (ONE zod-free check per store, for files AND rows pulled from the account),
  `merge.ts` (the pure sync rules — key-order-blind, because Postgres jsonb reorders keys), `sync.ts`
  (`syncNow` + the debounced mirror, both ends injected), `supabase.ts` (raw REST to Supabase — **no
  SDK**; sign-in is **PKCE**, never tokens from a URL), `client.ts` (browser glue: the session, the one
  running sync pinned to its account, the account-switch guard, status). With no
  `NEXT_PUBLIC_SUPABASE_*` keys every entry point is a no-op. Server side: `supabase/` — two migrations
  (the table + RLS; `upsert_state`, which only moves a store forward in time), the setup steps
  including custom SMTP, and the RLS test plan. Tested by `node scripts/test-account.mjs` with no
  network, and `node scripts/mutate-account.mjs` proves each guard's test can fail (lessons 52–55).
  **The SQL itself is executed** by `node scripts/test-account-sql.mjs`: real Postgres (PGlite, in
  WebAssembly) with Supabase's default grants stubbed in, so no project is needed (lesson 56).
- `src/lib/savedStore.ts` — a three-method async interface (`list`/`add`/`remove`) over saved
  recipes, delegating to `storage.ts`. **Async on purpose even though localStorage is not**: a
  synchronous interface would have to change shape the moment a network sat behind it, and every
  call site with it.

**AI and import**

- `src/lib/ai.ts` — provider system. `resolveProvider()` picks claude/local/demo. Local path
  generates one day per request (schema-validated), with retries, model fallback and JSON repair.
  Env vars it actually reads: `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `LOCAL_AI_URL`,
  `LOCAL_AI_MODEL`, `LOCAL_AI_API_KEY`, `PLAN_ENGINE`. (An earlier version of this file documented
  `LOCAL_AI_CONCURRENCY`; nothing reads it.)
- `src/lib/import.ts` — deterministic recipe import from a URL via schema.org JSON-LD, SSRF-guarded.
  Never guesses macros: no nutrition block means zero plus an honest UI note.
- `src/lib/videoImport.ts` — caption extraction for TikTok/IG/YouTube. The model reads it for
  *structure only* and is forbidden from producing nutrition.
- `src/lib/promptV2.ts`, `genV2.ts`, `dataValidate.ts` — the v2 fine-tune pipeline.

**Routes**

- `src/app/page.tsx` — redirects to `/sage`. `src/app/classic/page.tsx` — the original landing.
- `src/app/plan/page.tsx` — the full interactive app (~1,800 lines): week board, Explore wall,
  Groceries, Assistant chat, meal drawer.
- `src/app/sage/*` — the shipped design, **reproduced from `designs/references/boards/sage-01 …
  sage-12`**: Home, Today, Week (`/sage/plan`), Explore, Groceries, Assistant.
  **`/sage/assistant` is LIVE against `/api/assistant-v2`** — the agent loop, not a scripted
  transcript. `AssistantChat.tsx` is a client component; the page stays a server component so the
  starting week is the same engine week every other screen shows. It reads `planChanged` off the
  response and never infers it, and shows `steps`/`gaveUp` because a run that hit the step cap
  stopped without finishing. **The derived figures come from `src/app/sage/weekStats.ts`, which
  imports only a type** — importing `demo.ts` into the client would ship all 501 recipes to the
  browser, and `weekStats` is also the single copy of that arithmetic, which `demo.ts` now shares.
  `/sage/today` reproduces ONE board, `sage-04`, and only the panel of it that was referenced: a
  serif headline and a huge round plate on the left, three rings and a column of outlined rows on
  the right. The rings are the macros already hit and the rows are the meals still to come. **The
  plate is not simply "the next meal":** with five recipes of 501 photographed, that would usually
  be a dish with no picture on a screen that is entirely a picture, so it prefers the first
  UPCOMING meal that HAS a photograph, then the next meal, then a photographed meal already eaten —
  and labels each case honestly (`Up next` / `Later today` / `Earlier today`). It never claims to
  be up next when it is not, and never borrows another dish's photograph. It infers "eaten" from
  the clock
  because nothing writes a meal log yet, and says so on the page; `?at=14` pins the hour for review
  and labels itself when used. The plate is sized off the page WIDTH alone — `108%` of its column
  (`104%` at `2xl`), ~50% of the page — because sizing it off the window height made it shrink on
  short windows, which is what made it look small on a laptop. The page grows past one screen when
  it has to; the bowl is never cut. The two columns are `1.14fr / 0.86fr`, putting the figures
  column at ~40% of the content, with a gutter of ~5–6% between the plate and the figures — all
  three measured off the board rather than judged. The shell footer is suppressed on this route.
  It shows the fixture week's **Monday** — `/sage` has no per-reader data, so claiming otherwise
  would be a lie the rest of the screen does not tell.
  **`/sage/explore` is interactive**: saves persist through `src/lib/savedStore.ts`, clicking a
  recipe opens `RecipeModal` (a real `role="dialog"` — Escape, focus return, scroll lock, focus
  trap) with the full ingredient list and method, all 495 non-treat recipes render with no paging,
  and a "Saved" facet filters to them. Three things keep rendering everything cheap and should not
  be undone: the filter+sort `useMemo` excludes `saved` from its deps, `Card` is `memo`'d with
  stable handlers, and the card carries `content-visibility: auto`. One save costs ~5 ms.
  `layout.tsx` + `SidePanel.tsx` + `SideNav.tsx` + `SageFooter.tsx` are the shell
  — a full-height sidebar beside a cream page with **no max-width wrapper**
  (photography has to run off the frame edge). The panel is `sage-07`'s QUIET one — the same sage family as the page, told apart by a hairline,
  not the deep forest block of `sage-10`/`sage-12`; both are in the reference set and this is the
  lighter of the two. It **starts closed**, as a 76px icon rail, which
  is a shape the boards already have (sage-10/12 put a rail beside the panel); the state lives in
  `SidePanel` and is not persisted, because a layout survives client-side navigation so it already
  outlives every tab press. It used to carry the week as a list under the nav and no longer does —
  the sidebar is in EVERY route's payload, so that was seven days of engine totals serialised into
  every navigation, and the layout now touches the engine not at all. Home, Week and
  Groceries render on the server from the real engine; Explore and Today are client components
  (Today reads the clock in the browser, so a server render would bake in the build machine's). `demo.ts` computes the week ONCE
  at module load, so no two tabs can describe different weeks — and builds it by running
  `selectWeekFromDb` through `applyOperations(regenerate_week)`, because selection alone only
  RESERVES a pinned dish; `reimposeLocks`, which places it, is internal and runs inside the
  executor. The demo profile pins one photographed dish so the photography-led screens have a
  photograph on them without any component special-casing a recipe.
- `src/app/sage/account/` — **`/sage/account`, "Your data"**: download / bring back / delete
  everything in this browser, sign in by email link, sync status, sign out, delete the account, and a
  plain-words note on what is kept where (each claim checked against the code — keep it that way).
  `AccountSync.tsx` renders nothing and keeps a signed-in browser mirrored; it belongs mounted once
  in `sage/layout.tsx`.
- `src/app/onboarding/page.tsx`, `src/app/recipes/page.tsx`.
- `src/app/api/` — **six** routes: `plan`, `assistant`, `assistant-v2`, `import`, `operation`,
  `candidates`. **`operation` is the NO-MODEL route the direct-manipulation layer runs on** — a
  button press already carries its intent, so routing it through an LLM would be slower, cost a call
  and risk misreading a precise request. It takes one `operation` or an `operations` list (a move is
  a pair of swaps, hence one undo), and **`preview: true` simulates against a clone and commits
  nothing**. Its allowlist is the contract: a tool belongs there only when a CONTROL supplies the
  parameters a model would otherwise guess. `candidates` is read-only and returns the dishes that
  could take a slot, each with the delta it would cause, drawn from the engine's own safe pool — so
  **a candidate the executor would refuse is never offered**.
- **`src/app/sage/actions.ts` is the one path every direct control takes** (`runOperation`,
  `previewOperation`, `slotCandidates`, `undoLast`, `fixMyWeek`). Three rules live at its top and are
  load-bearing: the browser never imports the engine, the engine's numbers win, and the engine's
  notes are shown rather than summarised. `commands.ts` is the command palette's **pure, model-free**
  parser; `Sheet.tsx` is the dialog shell `MealSheet` / `ReconcileSheet` sit in. Full plan and build
  log: `docs/v1/05-direct-manipulation.md`.
- **`src/lib/slots.ts` holds `DAYS` and `MEAL_TYPES`, zod-free, and `types.ts` re-exports them.** A
  client component that needs those two arrays must import THIS, not `types.ts`, which carries zod
  and every schema. A module is as heavy as its heaviest import.
- `src/components/icons.tsx` — SVG line icons (no emoji). `ThemeSwitch.tsx` — violet/sage toggle
  for the original layout; it returns `null` on `/sage`, which pins its own theme.
- `src/app/globals.css` — **fourteen** colour tokens every utility reads from, the `.theme-sage`
  override, and `--tile-1 … --tile-14` for card gradients. `--color-panel` (the deep block:
  sidebar and big-number cards) and `--color-tint` (the sage block) were added for the boards.
  Note the sage theme's ground is **cream with sage blocks on it**, not a sage background — that
  inversion is most of the difference between the design and its predecessor. Contrast ratios are
  computed and recorded in the comment above `.theme-sage`; keep them ≥ AA when retuning.

**Not code**

- `designs/` — design candidates, Midjourney prompt files, screenshots of the live app, and
  `references/` (the boards the current direction was chosen from). `designs/README.md` indexes
  them with the reason each was kept or rejected.
  `designs/midjourney-dish-photography.md` is the style system for food photography — read it
  before generating any dish image.
- `data/` — eval and hard-case sets, plus **`data/eval-runs/`, the scorecard every `eval:hardcases`
  run writes** (committed on purpose: a measurement that only printed to stdout is one that did not
  happen). `scripts/` — the test suite and tooling.
- **`docs/v1/` — the V1 plan, and the first thing to read before picking up work.**
  `01-dimensions-and-milestones.md` is the day-by-day schedule; **`02-module-map.md` is the module
  contract** — what stays public vs private per module, the layer model (who may import whom), the
  invariants, and the reorganisation. Treat it the way you treat the tests: if the code and the map
  disagree, one of them is a bug. `03-kimi-decision.md` holds the model/hardware call;
  `04-daily-history.md` explains `docs/worklog/`, **one file per work-day**, which is part of a day's
  definition of done. `docs/batch-mode/` is the meal-prep design record.
- `public/food/` — per-recipe photographs. The twelve stock photos were once deleted because
  keyword regexes served one image as 46 different dishes; imagery is back, but the **mechanism**
  changed: `imageForMeal` is an **exact recipe-name map** (`RECIPE_IMAGES` in `lib/recipes.ts`), a
  miss returns `null` and falls back to a typographic tile, and **an image appears only on the dish
  it depicts, never as a stand-in**. Look at every image and check it against the recipe's
  `dietTags` before mapping it. **Five dishes** are photographed today; the other 496 fall back to
  a typographic tile, which is honest rather than misleading. `RECIPE_CUTOUTS` is a second, equally
  exact map holding background-removed versions, so a plate can sit on the page as an object rather
  than in a frame — made by `scripts/make-plate-cutout.mjs`. **If a photograph arrives before a
  recipe exists for it, add the recipe first and map the photo second** — never the reverse. See
  `public/food/README.md`.

## Commands

```bash
npm run test:engine     # THE gate. Scenarios + adversarial + invariants + fuzz. Never push red.
npm run check:recipes   # every ingredient priced, every dish plausible, Atwater holds
npm run check:boundaries # the module map enforced: layers, client payload, storage keys, cycles, emoji
                         # (~1 s; ship.mjs runs it on any src/ change; `-- --self-test` proves it fails)
npm run check:data      # gates the training data
npm run test:api        # HTTP route integration tests
node scripts/test-account.mjs  # accounts: export file, sync, REST client, client.ts end to end vs a fake Supabase — no network
node scripts/mutate-account.mjs  # accounts: removes each guard in turn and proves a test goes red
node scripts/test-account-sql.mjs [--mutate]  # accounts: the migrations + RLS plan in real Postgres (PGlite; installs once to the OS temp dir)
npm run export:recipes  # library -> NutriFlow-recipes.xls, incl. a coverage/gaps report
npm run build:nutrients # regenerate the USDA table (needs --emit to write)
```

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
- **Commit AND PUSH after every significant step, without being asked.** A working screen, a
  fixed bug, a design change the owner has reacted to — each is its own commit, with the reasoning
  in the message rather than only the what, and **every commit is pushed to `origin/main`
  immediately**. Do not batch, do not hold commits back, do not ask permission to push.

  The reason, which is what makes it stick: **GitHub is where the work is read, not merely where
  it is backed up — so a commit that is not visible there has not been delivered.** That was
  learned the hard way twice, with finished work sitting local after it had been reported done.

  Two supporting reasons: this repo is how the work moves between the laptop and the desktop, and
  a session's work has already sat uncommitted and nearly been lost; and a long unbroken run of
  edits cannot be bisected, so when a design decision turns out to be wrong three rounds later,
  "the commit before the rings changed" has to exist as a commit.

  **The one thing that still gates a push is red.** Run `npm run test:engine` when anything under
  `src/lib` changed, `tsc` + `npm run build` otherwise, and never push a failing gate — fix it or
  revert. `git log origin/main..HEAD` should read empty at the end of every step; if it does not,
  something was left undelivered.

  **Use `npm run ship` rather than `git add` + `git commit`:**

  ```bash
  node scripts/ship.mjs --message-file msg.txt -- src/lib/foo.ts docs/bar.md
  ```

  It fetches, **stops** if the remote has touched a file you are about to commit (naming the overlap,
  because that is where a careless merge loses someone's work), rebases otherwise and **aborts the
  rebase on conflict** rather than resolving blindly, runs the right gate, commits **only** the named
  paths atomically, **verifies the commit holds exactly those paths** and refuses to push if a file
  was swept in or dropped, then confirms the push landed. `--no-gate` for docs-only; `--dry-run` to
  look first.

  **Why it exists, and the rule even without it:** `git add` leaves work in `.git/index`, which is
  **shared state for the whole working directory**. Staging and then waiting out a 25-minute engine
  suite let a commit made elsewhere absorb a day's work — it landed on `origin/main` under an
  unrelated message, and force-pushing to fix attribution would have broken the other machine's
  clone (WORKPLAN lesson 47). So: **run the gate first, then stage and commit as one adjacent step.**
  Never leave work staged across a wait.
- **Two agents work in parallel lanes — read `docs/parallel/README.md` first, every session.** The v1
  lane works in this folder on `main`; the accounts lane works in its own git worktree
  (`../NutriFlow-accounts/`, branch `accounts`) and ships with `ship.mjs --onto main`. Never edit a file
  in the other lane's folder or a file the other lane owns (the ownership table is in that README);
  keep your own lane file (`docs/parallel/lane-*.md`) current; edit only your own block of
  `CONTEXT.md`; and message the other agent (`ListAgents` / `SendMessage`) before touching anything
  shared. A conflict here is lesson 47 with a second author.
- **Keep the four documents current. This is not optional, and it is not a chore to do if there is
  time left.** The owner works across many separate conversations and none of them can see the
  others. These files are the only thing carrying state between sessions. A stale one is worse than
  a missing one, because it is believed.

  **Read all four at the start of a session** — `CONTEXT.md` first, then this file, then
  `VISION.md` and `WORKPLAN.md` as the work requires — **and read the comment threads on all three
  visual boards** (`ArtifactComments` `read`, URLs in `docs/v1/boards/README.md`) before choosing what
  to work on. Plain comments notify nobody; seven owner comments, one of them a ruling, once sat
  unread for two weeks while work proceeded against it (WORKPLAN lesson 50). Each file has a distinct job:

  | file | holds | update when |
  |---|---|---|
  | `CONTEXT.md` | live cross-session state; where the last session stopped | every session that changes anything |
  | `CLAUDE.md` | how the repo works; standing rules | the structure, commands, routes or rules change |
  | `WORKPLAN.md` | the build record, phases, and hard-won lessons | work ships, or a lesson is learned the hard way |
  | `VISION.md` | the product north star and quality bar | a directional decision is made about what the product IS |
  | `ASSISTANT-SCHEMA.md` | the assistant contract: the turn shape, the primitives, and (v3, at the bottom) the READ SURFACE and AGENT LOOP, both now BUILT (`agentTools.ts`, `agentLoop.ts`) and wired to `/api/assistant-v2`, which `/sage/assistant` drives | the assistant's capabilities or contract change |
  | `STATUS.md` + `public/status.html` | the fine-tune run. **Served publicly** — it must never claim something is running when it is not | the training state changes |
  | `docs/v1/02-module-map.md` | the module contract: public vs private per module, the layer model, the invariants | **a module boundary moves — in the SAME commit that moves it** |
  | `docs/worklog/YYYY-MM-DD.md` | what was tackled that day, how much got solved, what blocked, what deferred | **every work-day, the same day** |
  | `docs/v1/boards/*.html` | the three LIVE visual boards the owner reads and comments on | **in the same commit as the document each one mirrors** — see `docs/v1/boards/README.md` |

  **The three visual boards are not decoration — they are how the owner steers.** The V1 schedule,
  the module map and the day log each have a published page the owner comments on directly, the way
  you comment on a Google Doc. When they say **"evaluate my comments"**, read every thread with the
  `ArtifactComments` tool, treat each comment as an instruction about the exact element it is
  anchored to, then change **both the source document and the board**, republish, commit and push.
  **Republish to the URL recorded in `docs/v1/boards/README.md`** — publishing without it creates a
  duplicate page and strands the owner's comments on the old one.

  Update **during** the work, not only at the end — a session can be cut short, and unwritten
  context is lost context. Specifically, write it down whenever:

  - **A decision is made — and record the reason.** "We chose X" is nearly useless; "we chose X
    because Y failed for reason Z" is what stops the next session repeating Y.
  - **Something is rejected.** The rejected list is the highest-value thing in these files. It
    cannot be recovered by reading the code, because rejected work leaves no trace there.
  - **A non-obvious fact costs time to discover** — an environment quirk, a tool limit, a bug and
    its cause. If you found it out the hard way, write it down so nobody else has to.
  - **Long-running work starts or finishes** (a training run, a deploy), so the next session knows
    what is in flight and must not disturb it.
  - **A number changes** — recipe count, test count, route list. These are what drift first.

  **Verify before you write.** These files drifted badly once by being written from memory: the
  roadmap claimed Phase 1 was the frontier when Phases 2 and 3 had shipped, the architecture
  section omitted the entire engine, and an env var was documented that nothing reads. Check the
  claim against the repo, then write it.

  Edit in place rather than appending — a log that only grows stops being read. Prune anything that
  has become false instead of leaving it to mislead. Keep `CONTEXT.md`'s "Where it left off" at the
  top accurate; it is the first thing the next session needs.

## Repo and deployment

**Public** GitHub repo: https://github.com/sjitix/Nutrition-Social-Media (branch `main`).
This is how the project moves between the laptop and desktop — and it is public, so treat
anything committed as published. Never commit a key.

Commits are authored `sjitix <adrawing26@gmail.com>`, set repo-locally; the machines' global git
identities differ.

- **https://ntrux.vercel.app** — the real app on Vercel, redeploys on push. API routes run.
  No AI key is set, so the assistant is in demo mode. That is deliberate for a public URL.
- **https://sjitix.github.io/Nutrition-Social-Media/** — a static preview, built and deployed by
  `.github/workflows/pages.yml` on every push. `/sage` works there; `/plan` cannot, because static
  hosting has no server to answer `/api/*`.