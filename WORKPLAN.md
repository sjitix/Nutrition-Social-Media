# NutriFlow — Strict Work Plan

> **Status:** living document. I follow this top-to-bottom. A phase is not "done" until its
> **exit criteria** pass and the work is **pushed to git**.
> **VISION.md** = what we're building and why. **CLAUDE.md** = how the repo works.
> **This file** = the ordered list of what gets built, how it gets tested, and in what order.

---

## RESUME HERE (last updated: 2026-08-10)

`main` is green: `npm run test:engine` **449 / 0, fuzz clean**. 501 recipes. tsc clean, build
clean. **See `CONTEXT.md` for the live cross-session state** — this section is the build record;
that file is where the last conversation left off.

### >>> SINCE 2026-08-05: library, photography, design, deployment <<<

Four things landed while the 7B trains. None touched the engine's contracts.

**Recipe library 169 → 500.** Gaps were measured, not guessed: four filters were unsatisfiable
(Indian, Italian, Mexican and Middle-Eastern snacks all zero) and eighteen more cells sat under
seven, the size at which one week is forced to repeat a dish. Now 0 empty, 0 critical. The two
Phase-2 rules held: only ingredients already curated to an FDC id, and macros derived rather than
written. `npm run export:recipes` was added — it writes the library to a spreadsheet whose Gaps
sheet is what drove the work.

**A latent bug the expansion surfaced.** `dietTagConflicts` matched `NON_VEGAN` on raw substrings,
so **"eggplant" contained "egg"** and a vegan aubergine dish reported an egg. This file's own
header documents that exact trap and fixes it on the ALLERGEN path; the diet-tag path never got the
fix, and it stayed invisible because no recipe paired vegan with eggplant until one was added.
Fixed with controls proving egg / eggs / egg whites / egg noodles are all still caught. → lesson 14.

**Photography removed.** Twelve stock photos against 500 recipes meant one image stood in for 46
different dishes. `imageForMeal` and `IMAGE_RULES` remain, deliberately empty, so real per-recipe
imagery can return without touching a caller. The card gradients were also hardcoded in JS — two of
them brand violet — so the app could not be re-skinned; they now live in `globals.css` as
`--tile-1 … --tile-14`.

**A design candidate at `/sage`,** sage-green and editorial, connected to the real engine rather
than fixtures. Implemented as a scoped token override: all ~291 colour utilities read from eleven
tokens, so `.theme-sage` re-skins everything with no component edits. Explore and Groceries are
interactive; Plan and Assistant are still read-only. The original design is preserved at `/classic`.
Contrast was verified ≥ AA before adoption.

**Deployed.** https://ntrux.vercel.app (Vercel, API routes run) and
https://sjitix.github.io/Nutrition-Social-Media/ (GitHub Pages static preview, built by
`.github/workflows/pages.yml`). The repo is now **public**.

**Photography reversed — the app is image-led again.** The no-imagery constraint was dropped: a
discovery wall of 500 dishes needs pictures. The old failure was never "too few photos", it was *a
photo standing in for a dish it wasn't* — so the MECHANISM changed. `imageForMeal` is now an
**exact recipe-name map** (`RECIPE_IMAGES`), a miss falls back to a typographic tile, and an image
may only ever appear on the dish it depicts. `public/food/` holds **four** photographs, all looked
at and checked against their recipe's `dietTags`; the style system for generating the rest is
`designs/midjourney-dish-photography.md`. A `check:images` gate is specced but **not built**.
Lessons 15–18 came out of this work.

**The reference boards are REPRODUCED at `/sage`.** `designs/references/boards/sage-01 … sage-12`,
built as composition rather than as tokens — the trap in lesson 15, which had already caught one
attempt. What changed and could not have been reached by adjusting the old page: the centred
container and pill tabs are gone in favour of a full-height forest **sidebar** (sage-10/11/12); the
ground **flipped** from sage-with-white-cards to cream-with-sage-blocks; radii went 26–32 px →
8–14 px; photography runs off the frame edge instead of sitting in a rounded card (sage-06/09); the
week became seven ragged columns instead of a bordered grid (sage-12); and the week's figures are
also set as a hairline-ruled ledger table (sage-08). Two tokens were added — `--color-panel` and
`--color-tint` — so `globals.css` now carries thirteen. Contrast recomputed, all ≥ AA. The engine
connection is unchanged: every figure is `selectWeekFromDb` / `RECIPES` output.

**A day screen at `/sage/today`, from `sage-04`.** The board that inverts the others — near-black
forest ground, cream cards, three circular arc gauges. The gauges hold the macros already hit, the
photograph is the dish coming up next, and the day's remaining meals sit below. "Already hit" is
inferred from the clock rather than from a log, because nothing writes one yet, and the page states
that rather than implying knowledge it does not have. The clock is read in the BROWSER: on the
static export the server's clock is the build clock, which would freeze "today" at deploy time.

**Next:** Ana's verdict on `/sage`. Then recapture `designs/screens/*.png` (Midjourney's `--sref`
still points at the old design), then `check:images`, then wire Plan and Assistant to be
interactive. Photography — four dishes of 500 — is now the binding constraint on the design.

### >>> ASSISTANT v2 — the 7B reason-then-act rebuild (owner's top priority) <<<

The 1.5B model line concluded at v9 (below). Owner's call: **train a bigger model, a better way —
a 7B on thousands of varied conversations that force ANY adjustment, flexible not an if-else tree.**
The design that answers that: a **reason-then-act** model (`{thinking, reply, operations}`) over a
few **general, composable primitives** (`constrain` the workhorse + `remember` + op-verbs), all
mapped onto the SAME tested deterministic engine — the two-layer rule holds, the model never does
arithmetic. The whole build is **code-complete and gated only on a freed desktop GPU** for the 12h
QLoRA run. Live status board: `public/status.html` (served at `/status.html`) + `STATUS.md`.

**Done + committed as sjitix (all green, all engine-validated):**
- **General primitives + executor** — `src/lib/primitives.ts`: `applyPrimitives` runs the whole v2
  vocabulary (constrain/remember/swap/log/rate/pin/report/…) through the proven engine; `previous`
  threaded so `undo` works. Turn schema `AssistantTurnV2Schema`. `src/lib/promptV2.ts` = the
  reason-then-act system prompt (used for BOTH training data AND live inference).
- **Generate-then-validate data pipeline** — `src/lib/dataValidate.ts` runs every example's ops
  through the REAL engine and keeps only the behaviorally-correct ones. `src/lib/genV2.ts` generates
  them: a surface-form multiplier (casual openers, you→u/pls, chat register) + rotating reasoning/
  reply banks (no parroting) + wide value ranges + situational classes (memory-application, deeper
  3–5 turn threads, honest declines). **`data/finetune-v2.jsonl` = 3,272 examples, 0 rejected,
  length-clean for the 7B (max 1998/2560, no all-masked drops — `scripts/check_lengths.py`).**
- **Hard eval** — `data/hard-cases.json` grown to **45 cases** across all four honest outcomes
  (do/clarify/decline/refuse) + memory + multi-turn + the cycle-aware health behavior. The ruler.
- **v2 route** — `src/app/api/assistant-v2/route.ts` (`parseAssistantTurnV2` + `applyPrimitives`),
  SEPARATE from the live `/api/assistant` so nothing breaks until we flip over post-train.
- **Post-train, one command each:** `scripts/merge_and_gguf.py` (merge LoRA → GGUF q8_0, self-clones
  llama.cpp, reads base from adapter config); `npm run eval:hardcases` (offline grader, graceful
  no-op when no model loaded). `scripts/train_lora.py` takes `DATA_FILE`/`BASE_MODEL` env.

**The one remaining step (needs the owner):** free the desktop GPU (close Brave/Cursor there, unload
the LM Studio model), then it's fully scripted —
`BASE_MODEL=Qwen/Qwen2.5-7B-Instruct DATA_FILE=finetune-v2.jsonl python scripts/train_lora.py` →
`python scripts/merge_and_gguf.py` → load in LM Studio → `npm run eval:hardcases` → report.

---

**Prior session (UX/importer, below) shipped, in order: the URL importer + hardening (Yoast/dual-unit
real-world fixes) → chat-import + imported-history + `rebalance_day` → the filterable Feed (Phase 3)
→ video/reel import (Phase 2 finish). All pushed as sjitix, all green.**

### >>> PRODUCT-WIDE UX OVERHAUL (owner: "improve all features → widely-used, convenient, social") <<<

Ran a user-perspective UX audit (31 findings, 6 tiers) and executed it top-down. All pushed as
sjitix, each tsc-clean + tests green:

- **Mobile (`c023757`)** — the week board was a 900px sideways-drag table on phones; now a vertical
  day stack below `lg`, timetable at `lg+`. Undo/toast lifted above the bottom nav; nav given ≥44px
  targets + safe-area + aria-current + short labels; landing headline made responsive.
- **Feed + Groceries (`44dc73a`)** — feed got **search** (name+ingredients, pure `filterFeed(query)`),
  **sort** (`sortFeed`), **save/favourites** (heart + "Saved" filter, persisted), and **pagination**
  (24 + "load more", not all 163 at once). Groceries got **aisle grouping** (pure, tested `grocery.ts`),
  **persistent check-offs** (survive reload + keep valid ticks across plan edits — a prune effect
  replaced 3 blanket resets), per-item price, total, progress bar, empty state.
- **Accessibility (`459b0b0`)** — WCAG AA contrast (muted text 3.2→5.7:1, violet 3.95→4.8:1); the meal
  drawer is a real `role="dialog"` modal (Escape, scroll-lock, focus, aria); decorative icons
  aria-hidden.
- **Onboarding/first-run (`09dc723`)** — asks your **name** (killed the hardcoded "Ana"); **prefills**
  from the saved profile for a returning user; generation shows a spinner; the plan page has a
  skeleton loader.
- **Social + sharing (`3f424ac`)** — your star rating shows on feed cards; **Share** copies a clean
  recipe and **Copy list** copies the aisle-grouped shopping list (clipboard, no backend).

- **Front-of-house + install (`cc6c533`, `1c68a3a`, `b28b4d3`, `6dca826`, `a6cac6f`)** — landing now
  showcases the reel-importer + aisle groceries (4-up); the app is an **installable PWA** (branded
  icon, manifest, standalone display, mobile theme-color) where before it had no favicon at all;
  **Open Graph / Twitter** cards give shared links a rich preview; a branded **404**; and the feed's
  gradient fallback went 4→14 tiles so photo-less cards look varied, not demo-like.
- **Correctness (`731dea3`) + review fixes (`3d764dd`)** — "In your plan" now derives from the real
  plan (survives reload). Then a code review of all the above caught a **real regression I'd
  introduced**: grocery check-offs were silently wiped on every reload (the prune effect ran against
  an empty list before the plan loaded and overwrote localStorage with `[]`). Fixed with a `!plan`
  guard. Same review found + fixed aisle miscategorisations (peanut butter→dairy, plant milks→dairy,
  stock→meat, egg noodles→dairy). **Lesson logged: an effect that persists derived state must not run
  before its source data has loaded.**

New tested pure libs: `src/lib/grocery.ts` (aisle categoriser), `filterFeed(query)`/`sortFeed`.
`test:engine` **389/0 fuzz clean**, `test:api` **21/0**. tsc clean; every route serves.

Backlog (lower value / needs a backend or design): progress/streak history (the biggest remaining
retention hook), a stepped onboarding wizard, community popularity signals, more photo assets to cut
photo repetition, a full focus-trap in the drawer, unifying the week-board's at-a-glance aside with
the Groceries view.

### Roadmap Phase 2 — the share-a-reel importer (DONE)

The strategy note below concluded the better near-term ROI is PRODUCT, not another QLoRA inside the
noise. So the direction is the roadmap's **Phase 2: paste a link → get a plan-ready meal.** The
URL half is shipped (commit `821622c`).

**Shipped — import a recipe from a link, DETERMINISTIC (no model):**
- `src/lib/import.ts` — reads the page's **schema.org/Recipe JSON-LD** (which nearly every recipe
  site embeds): name, ingredients, steps, per-serving nutrition. SSRF-guarded fetch (http/https
  only, no localhost/private IPs; 15 s timeout; 3 MB cap) → `findRecipe` across `@graph` nesting →
  parse ingredients ("2 tbsp cumin seeds" → qty+name, unicode fractions, HTML entities), steps
  (HowToStep/HowToSection), ISO-8601 times → a `Meal`. **Never guesses macros:** absent nutrition
  → 0 + a UI note (`macrosSource: "none"`); present → trusted (`"site"`), which sidesteps our
  nutrient table's thin coverage of exotic ingredients.
- `POST /api/import` `{url}` → recipe or a plain-English reason (bad link, no recipe, timeout, a
  site that blocks us).
- Explore gets an "Import a recipe" panel: paste → preview (macros/ingredients/source) → "Add to
  today's breakfast/lunch/dinner".
- **18 unit tests** (fixture HTML, no network): SSRF guard, ingredient/entity/time parsing,
  `@graph` extraction, the no-nutrition path, the no-recipe error.
- **Verified live:** BBC Good Food (463 kcal/serving, 20 ingredients, `"site"`) and Cookie & Kate
  import cleanly. Some sites block scrapers (AllRecipes → 402) — handled with a clear message.

**Next layers of Phase 2, in ROI order:**
1. ✅ **Persist + place correctly.** Persistence and groceries already worked (`savePlan` +
   the grocery `useMemo` over every meal's ingredients). The real bug was that "Add to X"
   **appended** a meal — two breakfasts, double-counted calories, and it broke every
   `.find(m => m.type === …)` (drawer refresh, Tonight hero). Now it **replaces** the slot's meal;
   returns honestly (no false "added" toast when the day isn't in the plan); and if the slot is
   pinned to another dish it says a regenerate will revert it. (commit below)
2. ✅ **Import into any day.** A day picker on the preview (defaults to today); `addRecipeToDay`
   generalises the old today-only handler.
3. ✅ **Source link.** Optional `sourceUrl` on `MealSchema` (model never emits it; stock recipes
   don't carry it); `importedToMeal` carries it; the drawer shows a "View original recipe" link.
   `test:engine` now asserts the imported meal passes `MealSchema` and round-trips the URL — **330
   / 0, fuzz clean.**
4. **Video platforms (TikTok/IG/YouTube)** — the actual "share-a-reel". Needs transcript/caption
   fetching + the MODEL to extract a recipe from prose (the JSON-LD path won't exist). This is the
   fragile, model-dependent layer; the URL path above is most of the value without it. Defer until
   the deterministic path is fully wired into the plan.
5. **Dedupe / "already imported"**, and a small imported-recipes history. *(low value)*
6. **Re-solve the day around an import** — NEEDS A UX CALL, not obviously right. `log_meal`
   rebalances because you ALREADY ATE the thing (a fait accompli the day must absorb). An import is
   a DELIBERATE choice; silently rescaling the other planned meals is more aggressive than a user
   may want. Best as an OPT-IN "balance my day around this" action (new deterministic op holding the
   imported slot fixed + `rebalanceDay`), or skipped. Deferred pending direction.

**Also shipped this pass (all pushed, sjitix):** the no-macros honesty note in the drawer (an
imported meal from a site with no nutrition sits at 0 kcal — the drawer now says so and that it
won't count toward the day, instead of a silent 0), and the `/api/import` route tests above.

**Live-probed 9 diverse real sites and found a HIGH-impact bug.** Coverage: BBC Good Food, Cookie &
Kate, RecipeTinEats, Food Network, Delish, Love & Lemons import cleanly; the rest are graceful
402/404 scraper-blocks with a clear message (0 invalid Meals produced). **The bug: Yoast SEO — one
of the most common WordPress plugins, so a large share of recipe blogs — minifies its JSON-LD to
`<script type=application/ld+json …>` with an UNQUOTED type attribute, and the extractor's regex
required quotes**, so it silently skipped *every* Yoast site (caught live on loveandlemons.com,
which returns 200 with a real recipe but parsed to nothing). Fixed (`["']?`), regression-tested with
the exact minified shape; loveandlemons now imports. This is the kind of miss that a fixture-only
test suite can't find — real HTML in the wild is messier than any fixture. `test:engine` **331 / 0**.

**Known limitation (noted, not yet fixed): dual-unit ingredients.** Sites that print both metric and
imperial ("1.2 kg / 2.4lb chuck beef", e.g. RecipeTinEats) leave the alternate measure stranded at
the front of the parsed name ("/ 2.4lb chuck beef …"). It's cosmetic — macros come from the site's
own nutrition block, not from ingredient parsing, so correctness is unaffected; only the grocery-list
label and the ingredient display are noisy. A targeted fold-alt-measure-into-quantity pass would
clean it. Low priority.

> **Owner said "do all of them"** (importer polish + Feed + video). Progress below.

### Importer polish — ALL THREE DONE (pushed)

1. ✅ **Paste a link in the chat to import it** (`d4d1351`). `sendMessage` spots a URL and routes it
   to the deterministic `/api/import` instead of the model — the "share a reel" gesture where people
   actually paste links. Preview card renders under the conversation; both entry points share one
   `placeImported` helper.
2. ✅ **Imported-recipes history + dedupe** (`4bd841c`). `rememberImport` stores each import
   (localStorage, newest-first, deduped by URL, cap 24); the Explore panel shows "Recently imported"
   chips that re-open a preview with no re-fetch.
3. ✅ **"Balance my day around this"** (`f965033`). New deterministic `rebalance_day` op: `scaleToTargets`
   already holds any no-base meal (import / logged / reserve) FIXED and rescales the day's OTHER meals'
   portions to target around it — never swapping the user's dishes. Drawer button on imported meals with
   macros. Tested: a 1100-kcal import stays fixed, others trim 1308→900.

### Feed — Phase 3 DONE (pushed with this)

`src/lib/feed.ts`: the whole macro-validated library (**163 recipes**, treat-only excluded) as
browsable cards, with a pure, unit-tested `filterFeed` (mealType · diet · high-protein ≥25g · ≤20min,
AND-combined). Explore is now a filterable feed: filter chips, a target-day picker, "Add to plan"
reusing `addRecipeToDay`. Defaults the diet filter to the user's own diet. Photos where a keyword
matches, a deterministic gradient tile otherwise. `test:engine` **349/0** (10 feed tests incl. "vegan
never surfaces meat").

### Video / reel import — Phase 2 finish — DONE (pushed with this)

The "share a reel" mechanic, the fragile model-dependent layer, built HONESTLY within the two-layer
rule:
- `src/lib/videoImport.ts`: `videoPlatform(url)` routes YouTube/TikTok/IG links to this path (a
  recipe *page* still goes to the deterministic JSON-LD importer). `extractVideoText(html, platform)`
  pulls the caption/description off the page — og:description on all three, plus YouTube's FULL
  `shortDescription` (og is truncated). Pure and fixture-tested.
- `ai.ts` `extractRecipeFromText`: the model reads the caption and returns STRUCTURE ONLY — name,
  ingredients, steps, servings, time. It is FORBIDDEN from producing nutrition (the two-layer rule:
  the model never does arithmetic), so a video-imported meal comes in without macros rather than with
  guessed ones. Schema-enforced (local `response_format`, Claude `zodOutputFormat`). $0 on the local
  model; a clear "off in demo mode" when there's no provider.
- `/api/import` routes video URLs here; the chat and Explore panel already send any pasted URL to
  `/api/import`, so a reel pasted in chat "just works".
- Graceful everywhere: a private video / a caption with no written recipe / a platform that blocks us
  each returns a plain-English reason, never a crash.

**Verified live:** the loaded model (even v9, a *tool* model — a general model like gpt-oss-20b would
do better) extracted "Creamy Tomato Pasta" (2 servings, 15 min, correct steps, most ingredients) from
a realistic caption, and correctly returned found=false for a "no recipe, just vibes" caption. End to
end through `/api/import`, a real YouTube non-recipe page fetched, extracted, and failed gracefully
with a 422. `test:engine` **357/0** (9 video tests: platform routing + caption extraction). The known
limit is the model's ingredient recall on messy captions — partial, but honest and useful; better
with a bigger base model.

> **State: owner's "do all of them" is COMPLETE** — importer polish (chat-import, history,
> day-rebalance), the Feed (Phase 3), and video/reel import (Phase 2 finish) are all shipped and
> green. Remaining backlog is optional: estimate macros for video/no-macro imports from their
> ingredients via the USDA table (coverage-gated), and grow the video caption parsers as platforms
> change their markup.

---

### (model work — concluded at v9; kept for context)

### v9 IS LIVE — the bigger eval reversed the call and it's the best model

The 65-case eval said v8 (97/95/10) beat v9 (94) and v10 (91), so I nearly kept v8. **That was
wrong, and the small eval was why**: it barely tested hydration/rate_meal — exactly where v8 is
genuinely weak (v8 fails 4 of 6 hydration cases). So it flattered v8 and hid v9's real win. I grew
the held-out eval **65 → 111** (thin tools to ~5–6 each; 0 training collisions) and made
`portionChange` direction-aware ("bigger" accepts "much_bigger" — magnitude is a subjective nudge).

On the balanced set, **3 runs each** (temp-0 nondeterminism is ~1–2 pts, so single runs don't decide):

| 111-case enforced | v8 | **v9** | v10 |
|---|---|---|---|
| toolAccuracy | 91–92% | **94–95%** | 92% |
| fieldAccuracy | 93–94% | **94–95%** | 92% |

**v9's ~3-point lead is above the noise floor, holds across runs, and is EXPLAINABLE** — it fixes
the hydration (26→50, lead-in reply) and rate_meal (empty-reply) cases v8 mostly fails, at a cost of
1 symptom_check case (`i feel worn out` → weekly_report) and ~1 clarify. v10's rebalance didn't help
(≈tied v8) — that part was noise. **v9 shipped**: loaded, `.env.local` = nutriflow-v9, verified live
("how much water" → "Here's your daily fluid target: At 78 kg, aim for about 2.6 L…"). v8/v10
preserved as GGUFs.

**The meta-lesson (now in the hard-won list): a metric too small doesn't just add noise — it points
you the WRONG way.** I nearly kept the worse model off a 65-case eval. Fix the ruler before the
model, and confirm a decision across multiple runs when the gap is small.

**v11 (targeted data fix) ALSO lost to v9 — narrow tweaking has hit diminishing returns.** v11 added
the exact "{day}'s {meal} is far more than i can eat" pattern to fix v9's scale_portions mealType
miss, plus macro-split clarify examples. Measured properly (`npm run eval:variance`, **3 runs each**
on the 125-case set):

| 125-case, 3 runs | **v9** | v11 |
|---|---|---|
| toolAccuracy | **94.3** (±0.5) | 91.7 (±2) |
| fieldAccuracy | **94.0** (±0) | 90.3 (±1.5) |
| clarify | **91.7** | 88.9 |

v9 wins by 2.6–3.7 points (above noise). And the targeted fix **didn't even work** — "wednesday's
dinner…" still drops the mealType. **Lesson: on a 1.5B model, adding narrow examples for one case
perturbs the whole net more than it helps locally** (field regressed 94→90). v10 and v11 BOTH lost
to v9; the only real model gain this session came from a STRUCTURAL data change (v9's hydration/
rate_meal reply shape), not case-targeting.

**Strategy going forward — stop tuning the 1.5B on this data.** v9 (94/94/92 on 125 cases) is the
ceiling for this approach and is a solid production model; its residual misses are minor and several
have deterministic UI workarounds. A genuinely better model would need a bigger base (the roadmap's
2–4 GPU path → a 7B/14B) or broadly more data — not more targeted examples. Better near-term ROI is
in PRODUCT (Phase 2: the share-a-reel importer) than in another ~4h QLoRA that lands inside the noise.

v11 preserved (`models/nutriflow-assistant-v11-q8_0.gguf`). v9 stays live. `npm run test:engine`
**310 / 0, fuzz clean**; `npm run test:api` 17/0; `npm run eval:variance` for future comparisons.

**Hardening done this session (all pushed, tsc-clean, engine at 310/0 fuzz-less):**
- `npm run test:api` — 17 integration tests over the HTTP routes (the `/api/operation` allowlist,
  rate→undo round-trip, graceful-offline), which had no automated coverage.
- `scale_portions` no longer claims a change when nothing moved (nonexistent slot / all-unscalable).
- onboarding requires a POSITIVE number for a body stat (a `0` would've made hydration prescribe 0 L).
- `train:status` tracks the latest `train-*.log` (it hardcoded v8 and falsely said "DONE" mid-v9).
- Added a README (the repo had none).

### v8 (the model v9 replaces) IS LIVE

The interrupted run was resumed (from checkpoint-390, RESUME=1 — which needed BOTH torch guards
bypassed, now fixed and proven), finished, promoted, and loaded. `.env.local` points the site at
`nutriflow-v8`. `npm run test:engine` is **308 passed / 0 failed, fuzz clean.**

**v8 on the honest held-out set (now 65 cases, incl. the 4 new tools):**

| enforced (`ENFORCE=1`, the production path) | v6 | v7 | **v8** |
|---|---|---|---|
| validJson / schemaOk / noHallucination | 100% | 100% | **100%** |
| **toolAccuracy** | 84% | 95% | **97%** |
| **fieldAccuracy** | 79% | 93% | **95%** |
| clarify/answer | 8/10 | 8/10 | **10/10** |

Higher than v7 while covering 9 MORE cases (the new tools), and clarify is now perfect. Unconstrained
(stress test): 92% tool / 91% field.

### >>> NEXT: v9 — fix the two weak tools <<<

Driving v8 through the LIVE app surfaced its one real gap: **hydration and rate_meal often emit the
right REPLY TEXT but an EMPTY operations list** — the model recites "Let me work that out from your
weight" or "Noted — I'll remember that" WITHOUT firing the tool. They're the newest tools with the
fewest examples, and their reply text reads like a complete answer, so the model learns it can stop
at the words. Two things for v9:
1. More hydration/rate_meal examples, and more varied phrasings ("how much water", "am i drinking
   enough", vague ratings like "it was fine").
2. Their training reply text must NOT stand alone — it should reference the operation's computed
   value (like weekly_report's does), so reciting the reply without the op is visibly incomplete.

Mitigation already shipped: the deterministic UI (hydration card, rating stars, portion +/-) calls
`/api/operation` with NO model, so users get these features reliably regardless of the chat weakness.

Two live-path fixes already landed (commit `7151a69`): the assistant call is now temperature 0
(was sampling at ~0.7, non-deterministic), and it no longer dumps the JSON schema as redundant text
when `response_format` already enforces it — the app now sends exactly what the eval sends.

**Also still open:** eyeball the session's UI in a browser (rating stars, pin toggle, portion +/-,
Home coach card, onboarding "Calculate my targets", the offline chat message) — all verified by
tsc + curl but NOT yet looked at rendered.

**The 17 tools:** update_profile, regenerate_week, regenerate_day, swap_meal, compute_targets,
log_meal, weekly_report, eating_out, explain_meal, substitute_ingredient, symptom_check, lock_meal,
unlock_meal, **rate_meal, hydration, scale_portions, undo**.

### Also shipped this session — a deterministic UI + infra layer (all pushed, no model needed)

Built while v8 trained, so all of it works with the assistant OFFLINE. Verified by tsc + live curl
(the engine is pure); the browser look-and-feel is NOT yet eyeballed — click through to confirm.

- **`/api/operation`** — runs ONE deterministic op (rate/pin/unpin/resize/undo/weekly_report/
  hydration), no LLM. Allowlisted; rejects anything needing interpretation. Tested: allowlist holds.
- **Meal drawer** — star rating, "Keep every week" pin toggle, portion −/+ (refreshes in place).
- **Undo button** — floating, appears when there's a change, labelled with what it reverses.
- **Home "coach" card** — the weekly review + (when a weight is known) the hydration target.
- **Onboarding** — optional body-stats row + "Calculate my targets" (Mifflin-St Jeor, the tested
  `computeTargets`); stores `bodyStats` so hydration never has to ask. Manual entry still works.
- **Graceful offline** — the assistant route no longer leaks raw LM Studio errors; a 503 +
  `offline:true` renders as a friendly assistant bubble pointing at the direct actions.
- **Infra** — `scripts/promote-model.sh` (one-command adapter→GGUF→load→eval, guarded),
  `npm run train:status`, and `train_lora.py` RESUME=1 fixed to survive an interrupted run.
- **Debt found + fixed:** `swap_meal` ignored exact recipe names (keyword-matched "Veggie Omelette"
  to a chickpea omelette); exact name now wins, still behind the hard filters.

Not yet done: the FULL `npm run test:engine` (fuzz) since v8's UI/engine changes — deferred to avoid
CPU contention with training; the fuzz-less run passed 308/0. Run it once the GPU is free (STEP 4).

### v7 (the model in production RIGHT NOW)

v7 is loaded and serving the site. It knows the original 13 tools but NONE of the 4 new ones, so
"rate that dinner 5 stars", "how much water", "smaller portions", "undo" won't work in the live
chat until v8 lands. Everything else works.

```bash
~/.lmstudio/bin/lms.exe load nutriflow-assistant-v7 --gpu max --context-length 8192 --identifier nutriflow-v7 -y
ENFORCE=1 MODEL=nutriflow-v7 npm run eval:assistant   # the production path
```

### The scoreboard was measuring memory, not skill

24 of the 56 eval cases were **verbatim training strings** — "i'm always tired", "make it better",
"i need more b12", "what can you do". Another 13 differed from a training string by exactly the
field under test. 66% of the eval was contaminated, and **every score from v4 to v7 was partly a
recall score.** The eval cases now live in `data/eval-cases.json`; the 24 verbatim ones were
rewritten to held-out phrasings; `check:data` fails if a training message ever equals an eval
message again, and `gen-synthetic.mjs` drops (and names) any example that collides.

Re-measured on the honest set, the model comparison did not shrink — **it grew**. v6 had memorized
the same strings, so the contamination was hiding v7's real advantage.

| enforced (`ENFORCE=1`, the production path) | v5 | v6 | **v7** |
|---|---|---|---|
| validJson / schemaOk | 100% | 100% | **100%** |
| noHallucination | 100% | 100% | **100%** |
| **toolAccuracy** | — | 84% | **95%** |
| **fieldAccuracy** | — | 79% | **93%** |
| clarify/answer | — | 8/10 | **8/10** |

*(v5's honest numbers were never taken; its old contaminated row read 82% / 86% / 9-10. The v6 and
v7 rows above are on the held-out set and are the only two directly comparable numbers here.)*

v7 unconstrained scores **higher** than enforced — 98% tool / 95% field / 9-10 clarify. JSON-schema
enforcement costs this model a little accuracy rather than buying it any; worth revisiting whether
the app still needs it now that the fine-tune emits the envelope natively.

### What v7 still gets wrong (all three are "read the sentence" failures)

1. `i ate pizza for lunch on monday` -> answers **breakfast**. Training contains "i ate pizza for
   breakfast on Monday". It matches the dish and the day and stops reading. Two generated examples
   ("Friday breakfast is at a work dinner") had actively taught it that the meal word is noise;
   those are gone and `check:data` now rejects any message naming a meal it isn't about.
2. `i'm out for dinner tuesday, probably 1000 calories` -> drops `estimatedCalories`. All 26
   training examples carrying a number label it correctly, but the closest phrasing it memorized
   ("i'm going out for dinner on friday") has no number.
3. `i feel worn out every afternoon` -> `weekly_report`, not `symptom_check`.

The fix for all three is **minimal pairs in the training data**: same dish, same day, different
slot; same outing, with and without a calorie estimate; more fatigue phrasings. **All three are now
in the training set** (`gen-synthetic.mjs`: the log_meal all-three-slots loop, the eating_out
with/without-number loop, ten fatigue phrasings) — they take effect when v8 trains.

### The four tools that shipped after v7 (all tested, all pushed, model not yet retrained)

- **rate_meal** — "that salmon was incredible" (5) / "never make the tofu again" (1). A preference,
  never a hard rule: it biases selection, and a 1-star relaxes if banning it would empty a slot. The
  ban has to hold on all THREE paths that place a recipe (day selector, protein rebalancer, nutrient
  boost) — it leaked through two of them until a test caught it (5/25 weeks).
- **hydration** — "how much water?" 35 mL/kg + a training allowance − the ~20% from food, as a band.
  Forced compute_targets to finally PERSIST its body stats (it computed and discarded them); the app
  knew your calories but not your weight.
- **scale_portions** — "still hungry" / "too much food". The one tool that deliberately leaves the
  calorie target, so it discloses; and it will not cross the calorie floor no matter how often asked.
- **undo** — "put it back". The engine is pure and the server stateless, so a one-step snapshot rides
  the request. Restores the profile wholesale (a pin/rating/weight the last turn ADDED must not
  survive its own undo). Also flipped `planChanged` from inferred-from-tool-name to MEASURED — a swap
  for a dish we don't stock is a no-op that used to say "Done, I updated your plan."

### Debts paid since v7

- **PAID: plant protein powder.** The table's only protein powder was whey, capping vegan breakfasts
  and (worse, historically) masking vegan B12. Added soy protein powder (fdcId 173181, B12=0) + a
  "Vegan Berry Protein Shake Bowl" (24g protein). Needed a VEGAN_EXCEPTION because "soy protein
  powder" contains the substring "protein powder" that flags whey.
- **Found + fixed while there: swap_meal ignored exact names.** It scored dishes by keyword overlap
  with no exact-name preference, so "swap in the Veggie Omelette" returned a chickpea omelette. Exact
  name now wins, still behind the hard filters.

---

## 0. The aim (never lose sight of this)

Build an AI that **replaces a nutritionist *and* a knowledgeable health coach**. The user talks
in plain language; the AI understands, decides, and the plan **actually changes correctly**.

It must feel like a **genuine convenience**, not a toy: it should absorb real life (you ate a
burger, you're travelling, the spinach is about to turn, you're exhausted) and quietly keep you
on track.

### The one architectural rule

> **The LLM decides *what* to do. Deterministic code guarantees *that it is correct*.**

- **Intent layer (LLM):** understands the conversation, infers unstated constraints, picks a
  tool and its arguments, decides whether to ask a clarifying question. Flexible. Fine-tuned.
- **Correctness layer (code):** macros, nutrients, portions, safety. Never guesses. **The model
  does no arithmetic, ever.**

Every new capability is therefore: **a tool the LLM may choose** + **an engine that executes it
reliably**. Never a keyword trigger, never an if-else chatbot.

### The second rule: almost everything is the same primitive

`log_meal`, `eating_out`, `substitute_ingredient`, `scale_portions` are **not new engines**.
They are new *entry points* into the solver we already have:
**"re-solve the remainder of the plan under the constraints that are now true."**

### The third rule: honesty over silence

If the engine substitutes a dish, relaxes a limit, changes another meal, or *cannot* satisfy a
request — **it says so.** A silent wrong answer is worse than a refusal. Impossible constraint
sets get an explanation and a proposed trade-off, never a quietly broken plan.

---

## 1. Standing loop (applies to EVERY task, no exceptions)

```
build  →  typecheck  →  test from the USER's perspective  →  adversarial / edge cases
      →  invariants + fuzz  →  green?  →  commit + push  →  next task
```

**Rules I hold myself to:**
1. **Never push red.** If a test fails, fix it or revert; do not "temporarily" disable it.
2. **Never weaken a test to make it pass.** If a test is wrong, fix the *test* and say so
   explicitly. If the code is wrong, fix the *code*.
3. **Test as a user, not as a programmer.** Tests are phrased as real utterances
   ("*I'm allergic to peanuts*" → "*swap lunch for the Thai peanut bowl*").
4. **Adversarial by default.** Every feature gets: a contradiction test, an impossible-request
   test, an unknown-input test, and a "does it violate a hard rule?" test.
5. **Hard rules are inviolable:** diet, allergies, exclusions. Everything else (cook time,
   budget, ingredient count) is a *preference* that may be relaxed **only with disclosure**.
6. **Report honestly** at each milestone: what passed, what broke, what I changed.
7. **The GPU training run is never interrupted** by this work.

---

## 2. Test architecture (`npm run test:engine`)

Three layers, in `scripts/test-engine.mts`:

| Layer | Purpose |
|---|---|
| **Scenarios** | User-perspective behaviours ("swap breakfast but keep me lean") |
| **Adversarial** | Contradictions, allergies vs requests, unknown dishes, idempotence, ordering |
| **Invariants + Fuzz** | Random operation sequences; properties asserted after **every** op |

### The invariants (must hold after ANY operation, forever)

| id | property |
|---|---|
| `I1` | Diet never violated (per-day overrides respected) |
| `I2` | Allergen / excluded ingredient never present — **inviolable** |
| `I3` | Every day has exactly `mealsPerDay` meals (never silently drop a meal) |
| `I4` | No duplicate dish within a day |
| `I5` | Day calories on target unless `preserveMacros:false` (or physically unreachable) |
| `I6` | Portion scale stays within realistic bounds (0.6–1.8×) |
| `I7` | Cook-time limit respected — relaxed only when **no** compliant recipe exists, and disclosed |
| `I8` | Per-day overrides never persist into the saved profile |

> The fuzzer exists to **break** the engine, not to flatter it. It has already found three real
> bugs (silent meal-drop, swaps ignoring cook time, silent dish substitution).

---

## 3. Phases

Order chosen deliberately. Safety is **deferred to the end at the owner's explicit direction** —
he wants to see the AI be *rational and coherent* first. (Existing allergy/exclusion invariants
stay in force regardless; removing them would be a regression.)

### ✅ Phase 0 — Testing as a first-class asset
- [x] Move suite into repo → `scripts/test-engine.mts`, `npm run test:engine`
- [x] Invariants `I1`–`I8` + fuzzer over random op sequences
- [x] Fix bugs the fuzzer found: silent meal-drop, swap ignoring cook time, silent substitution,
      calorie weight losing to carbs/fat/fiber
- **Exit:** suite green, fuzz clean, pushed.

### Phase 2 — Micronutrient engine (USDA FoodData Central) ← *owner chose option (a)*
The foundation for every health skill. VISION already predicted it: **same solver, more axes.**
- [x] Download **USDA FoodData Central SR Legacy** bulk CSV (public domain, 7,793 generic foods).
- [x] Scope: **132 recipes, 174 distinct ingredients**. Units: `g` (305), *none* (84), `tbsp` (62),
      `tsp` (26), `piece`, `can`, `scoop`, `clove`, `slice`.

> **⚠️ Finding: auto-matching ingredients to USDA is UNSAFE and must not be shipped.**
> Naive token-overlap gave `salmon fillet → "Vegetarian fillets"`, `eggs → "Eggs, scrambled,
> frozen mixture"`, `brown rice → "Rice flour, brown"`, `greek yogurt → "Yogurt, Greek,
> **strawberry**"`. Even after tuning the ranker, `eggs` still returns fish roe and
> `salmon fillet` returns *Salmonberries*. Shipping that would mean **fabricated nutrition
> presented as USDA data** — exactly the hallucination this engine exists to prevent.

**Therefore:**
- `scripts/usda-search.mjs` surfaces **candidates for human review**; its top-1 is never trusted.
- `ingredient → fdc_id` is **hand-curated and committed**, so every nutrient value is traceable
  to a real FDC record.
- **Automatic accuracy gate:** each recipe already carries hand-authored macros. Recomputing its
  macros from the mapped ingredients + gram conversions must land close to them. Large divergence
  = a bad mapping or a bad unit conversion. This validates all 174 mappings without eyeballing them.
- Unmapped ingredients must **not** silently contribute zero; coverage is reported, and micros are
  only exposed once coverage is high.
- Unit → grams uses a curated, versioned table (`scripts/food-units.json`).

**Status:** `npm run build:nutrients` → **175/175 ingredients resolved, 132/132 recipes covered.**
The `--audit` trail confirms the curation: `brown rice → Rice, brown, long-grain, raw (367 kcal/100g)`,
`chicken breast → skinless boneless raw (120)`, `eggs → Egg, whole, raw, fresh (143)`,
`olive oil → 884`, `oats → dry (379)`. The gate caught a real 3× error (`red lentils` are used **dry**
— no "cooked" marker — while `lentils`/`green lentils` say "150 g cooked").

> **⚠️ Finding: recipe ingredient lists are simplified, not complete formulations.**
> Each recipe lists ~4 ingredients for easy cooking/shopping. So ingredient-derived calories
> diverge from the authored macros in both directions: *Shakshuka* computes 244 vs 430 (its list
> omits oil/bread), while *Peanut Banana Oatmeal* computes 557 vs an authored 410 (oats 233 + milk
> 128 + banana 105 + PB 94 = 560 — **the computed figure is right and the authored one is wrong**).
> Median divergence: **16.2%**.

**Decisions:**
1. **Do NOT auto-replace authored macros with ingredient-derived ones** — the lists are incomplete,
   so that would introduce a different error. Authored macros stay canonical for the solver.
2. **Micronutrients ARE derived from the mapped ingredients** and labelled as such. For the engine's
   real purpose (bias selection toward iron-rich meals), *relative* nutrient density across recipes
   is what matters, and the listed ingredients carry the dominant sources (lentils, spinach, beef).
3. **Never silently scale micros** to force agreement with authored calories — that would inflate
   the nutrients of whichever foods happen to be listed.
4. **Two real bugs to fix:** (a) batch recipes need a `servings` field — *Banana Walnut Protein
   Muffins* computes 913 vs 360 because the ingredients make ~2.5 servings; (b) recipes whose
   computed calories fall far below authored have incomplete lists → complete them over time,
   prioritised by the gate's worst-offenders report.
- Extend the vector: `{cal, protein, carbs, fat, fiber, iron, calcium, vitD, B12, magnesium,
  potassium, folate, zinc, vitC}`. Recipe micros **computed from ingredients**, deterministically.
- `targetNutrient` support: "boost my iron" → engine biases iron-rich foods **while macros hold**.
- **Tests:** nutrient sums; sanity checks (spinach→iron/folate, salmon→vitD/B12); iron-boost
  raises iron without breaking macros; all invariants still hold under fuzz.
- **Exit:** micro values traceable to an FDC id; suite green; pushed.

### ✅ Phase 3 — `compute_targets` + `log_meal` — **DONE**
- **`compute_targets`** — user never types "2000 kcal" again. Age/height/weight/sex/activity/goal
  → Mifflin-St Jeor + activity factor + a sane rate → sets calories & protein. Pure math.
- **`log_meal`** — 🔥 *the killer feature.* "I ate a burger for lunch" → **the rest of the day
  re-solves** to keep you on target. Turns the plan from a document into a living coach.
- **Tests:** "I ate pizza for lunch" → dinner adapts, day still near target; logging a huge meal
  → engine says honestly that the day can't be saved rather than starving dinner.

### Phase 4 — Hydration — *not started* (needs `UserProfile.weightKg`, which `compute_targets` should persist)

- Water target from bodyweight/activity; `set_hydration_target`, `log_water`.
- Plan surfaces hydration; suggests water-rich / electrolyte foods when short.
- **Tests:** "how much water should I drink?", "I only drank 1L today".

### ✅ Phase 5 — Symptom → nutrient reasoning — **DONE** (`symptom_check`)
Built differently, and better, than planned. The tool does **not** map a symptom to a nutrient
and then recommend food. It names what the symptom is *associated* with, then checks those
nutrients **against the user's actual week**, and reports which are genuinely low *in their
own numbers*. A claim about their food, never about their body.
- Recommends **no supplement and no dose** — asserted by test across every symptom.
- A tired vegan is told B12 is at 3%, vitamin D at 0%, and that *no vegan food in the library
  can fix it* — see a dietitian. Honest where a lookup table would have lied.
- **Red flags moved here from Phase 9**, because shipping the symptom tool without them was not
  defensible: chest pain / blood / fainting / slurred speech → urgent care, no nutrient talk.
  Self-harm is a **separate** category with a crisis line, because "see a doctor" is the wrong
  sentence. The engine **overrides the model's reply entirely** on these paths.

### Phase 6 — Personalization & trust — *partly done*
- ✅ **`explain_meal`** — justifies every choice from the plan and the USDA table. Drops a
  nutrient claim entirely when ingredient coverage is under 60% rather than softening it, and
  refuses to invent reasons for a meal the user told it about (a restaurant reserve, a logged
  meal).
- ✅ **`weekly_report`** — computed averages, admitted shortfalls, micronutrients under 80% of
  reference. Distinguishes gaps it *can* close from gaps no compliant food can close.
- ⬜ `rate_meal` / `lock_meal` → persistent taste model.
- ⬜ `undo` — "actually, revert that."

### Phase 7 — Real life — *partly done*
- ✅ **`eating_out`** — reserves a realistic calorie budget for a meal it cannot see, books
  **zero protein** for it (you can't know what you'll order), re-solves the rest of the day, and
  tells you *what to order*: "your other meals carry 102g of protein, so order something with
  roughly 48g." Refuses to prescribe the physically impossible (121g of protein in a 300 kcal
  salad).
- ✅ **`substitute_ingredient`** — safety filter first (diet, allergies, dislikes), curated
  candidates second (a nutrient table doesn't know lentils can't replace a chicken breast),
  computed macro cost third. 440 ingredient×restriction combinations verified safe.
- ⬜ Remaining:
- `scale_portions` ("cooking for 2", "my partner is vegetarian, I'm not")
- `whats_for_now` ("15 minutes and these 5 things")
- `pantry_expiry` ("use the spinach before it turns") · `batch_cook` (cook once, eat twice)
- `travel_mode` · `meal_timing` ("I train at 6pm") · `fasting_window` (16:8)
- `set_budget` (weekly £/$ cap, enforced by the engine)

### 🔄 Phase 8 — Model evaluation, data expansion, **retrain** — *in progress, v5 shipped, v6 queued*
1. `merge_lora.py` → GGUF `q8_0` → LM Studio → `.env.local` (toolchain verified).
2. **Eval harness, not vibes.** Held-out set + hand-written hard cases. Metrics:
   valid-JSON %, correct-tool %, field exactness, hallucination rate, clarification
   appropriateness, refusal correctness. **Fine-tuned vs prompted base**, head to head.
3. **Expand training data 452 → 2,000+**, diversified across:
   every new skill · safety refusals & escalations · symptom conversations · hydration ·
   micronutrients · contradictions ("vegan but add chicken") · impossible constraints
   ("300 g protein, vegan, $20/week") · unknown dishes · vague asks needing clarification ·
   multi-turn pronouns ("do that", "only Tuesday") · typos/slang · users pushing back.
4. **Retrain on GPU.** Then iterate: eval → find the weakness → add targeted data → retrain.

> **Data beats model size.** 452 → 2,000 good examples will improve this more than any bigger
> model or fancier training technique.

### 🔄 Phase 9 — Safety & guardrails *(deferred — but the red flags could not wait, see Phase 5)*
- Red-flag symptoms (chest pain, fainting, blood, pregnancy, meds e.g. warfarin×vitamin K) →
  **escalate to a professional, change nothing.**
- Never diagnose. Hard floors in code: refuse unsafe calorie targets, absurd protein, crash diets.
- Disordered-eating guardrails. Allergy remains inviolable everywhere, including cheat mode.

---

## 3b. Added to the plan mid-build (these weren't in the original phases)

Each of these was discovered by doing the work, and each earned its place.

- **✅ `npm run check:data` — a gate on the training data.** A silent `slice(0, TARGET)` in the
  generator deleted every clarify example the moment the hand-written tail grew past the cap; the
  model would have quietly lost the ability to ask a question instead of guessing. The checker now
  rejects contradictory labels for the same message, null or invented fields, and any tool or the
  clarify category falling below a minimum.
- **✅ Read-only tools, enforced in code.** `weekly_report`, `explain_meal`,
  `substitute_ingredient` and `symptom_check` answer questions; they must never flag the plan as
  changed. `lib/reply.ts` owns that rule and a test fails if a new tool is added without deciding
  which side it falls on.
- **✅ The engine overrides the model on dangerous replies.** The route used to prepend the LLM's
  prose to the engine's notes, so a 1.5B could have written "sounds like low iron!" above a suicide
  hotline. `applyOperations` now returns a `replyOverride` that discards the model's words.
- **✅ A nutrient boost is a guarantee, not a bias.** As a scoring bias, "rebuild my week around
  vitamin D" could hand back *less* vitamin D. Now a monotone upgrade pass, verified after portion
  rebalancing; if no week beats the user's, theirs is kept and the assistant says so.
- **✅ Adversarial audit as a recurring practice, not a one-off.** Independent agents attacking the
  new skills found six real defects in one pass, including a **live allergen exposure**: a user who
  typed `peanuts` — the placeholder in our own onboarding form — was served peanut butter, because
  the matcher only asked whether the ingredient was a plural of the token, never the reverse. Run an
  audit after every batch of new skills. My own 440-combination safety sweep had missed it.
- **✅ PAID: the recipe cards lied.** 46 of 140 recipes disagreed with their own ingredient list
  by more than 20%, one by 63%. Since every micronutrient is derived from the ingredients while
  the calories came from the card, the nutrients were silently wrong in proportion — a Shakshuka
  whose ingredients covered 57% of its calories reported 57% of its real iron. 54 recipes were
  cooked in a pan and listed no fat; five described a smaller meal than the dish is. The
  hand-written macros are now **deleted**: calories, protein, carbs, fat and fiber are computed
  from the ingredients. `npm run check:recipes` fails on an unpriced ingredient, low nutrient
  coverage, an implausible meal, a keto tag over 20g of carbs, or macros that miss Atwater.
- **✅ PAID: the fridge is a guarantee.** "Use up the salmon" was a per-slot bias that the
  protein-diversity cap could defeat, so the test could only assert "usually". The week is now
  built, checked, and the missing ingredient placed: 12/12. Hard rules still win — a vegan asking
  to use up salmon is told, not served — and a pinned meal is never displaced.
- **✅ PAID: the library couldn't feed the diets it offers.** A keto user got Turkey Cobb Salad
  seven days running (3 keto breakfasts, ONE keto lunch, 2 keto dinners). A vegan could not reach
  a protein target — the gap was in the food, not the solver. 28 new recipes: every diet now has
  ≥7 options per slot, vegan protein went 100g -> 131g.
- **✅ PAID: keto sets its own macros.** `dayTargetMacros` gives keto `KETO_NET_CARB_TARGET = 30`
  and lets fat absorb the freed calories; the profile is left untouched. It turned out the weeks
  were already ketogenic (51g total carbs − 21g fiber = 30g NET) — the measurement was wrong, not
  the plan, so `weekly_report` now tells keto users their net carbs.
- **✅ PAID: plant protein powder.** Added soy protein powder (fdcId 173181, B12=0 so it can't mask
  a vegan B12 gap the way whey did) + a "Vegan Berry Protein Shake Bowl" (24g protein). Needed a
  `VEGAN_EXCEPTION` because "soy protein powder" contains the "protein powder" substring that flags
  whey as non-vegan.

### Testing rules learned the hard way

1. **A test that samples a random week is a coin flip.** The dairy-allergy check passed for weeks
   and only failed once Thai Peanut Chicken Rice Bowl happened to be selected. Scan several weeks,
   or scan the library.
2. **When a test fails, ask whether the test is wrong first.** Four times now the engine was right:
   per-day diet overrides are legitimate; a treat day is *supposed* to be off-target; "unicorn
   tears" contains "corn"; peanut butter is not dairy.
3. **`tsc` will not catch a corrupted regex.** `\b` written through a bash heredoc becomes a
   backspace character. It compiles, and then matches nothing.
4. **Read the summary line, not the tail.** I committed red once because the last three lines of
   the test output were the failure list, not the score.
5. **A green mutation test that never mutated is worse than no test.** Assert the edit landed
   before trusting the result.
6. **Silence is the enemy.** Four bugs this week were silent: a `slice()` that deleted every
   clarify example, an `OP()` allowlist that dropped five fields from every training label, a
   trainer that skipped 1028 of 1030 examples and saved an adapter as though nothing happened, and
   an eval set sharing 24 verbatim strings with the training data. None of them failed anything.
   All four now abort loudly.
7. **Adversarial audit after every batch of skills.** Two audits, eleven real defects, including
   a live allergen exposure and a pin that could break a diet. My own tests missed all of them.
8. **A metric you never audited is a number you made up.** I reported toolAccuracy and
   fieldAccuracy for four model versions before ever checking whether the eval questions appeared
   in the training set. 43% of them did, verbatim. The eval is now a data file behind a gate,
   because the thing that measures the work needs the same scrutiny as the work.
9. **Bad data is a teacher too.** Two nonsense examples — "Friday breakfast is at a work dinner",
   produced by crossing a random meal slot with a venue named "a work dinner" — taught the model
   that the meal word in a sentence is unreliable. It then read "i ate pizza for lunch on monday"
   and answered `breakfast`. Two examples out of 1030 were enough.
10. **A test that asserts an absence must first prove the presence.** The nutrient-boost ban test
    passed before the fix — because I'd ranked "the dish the boost wants" by iron-per-calorie while
    the engine ranks by absolute iron, so I banned a dish it never picks and proved nothing. Every
    "X never happens" check now has a control showing X happens without the guard.
11. **A wandering test count hides a deleted test.** Two checks emitted one assertion per dish of a
    random week, so the suite total drifted run to run (297, then 299) and a genuinely missing test
    would have vanished into the noise — and `if (claimed) check(...)` meant a dish that omitted the
    field was silently never checked. Fixed count now, same number every run.
12. **A fresh training run must not resume the last version's checkpoint.** v8 crashed on launch
    auto-resuming v7's `checkpoint-387` (blocked by a torch.load CVE guard). Resume is for one
    interrupted run; every vN is fresh data. A fresh run clears the checkpoint dir; `RESUME=1` opts
    back in.
13. **Adding one recipe can tip over a latent test — and a latent bug.** The new vegan recipe
    shifted the random week, which exposed both a fragile note-parsing regex AND that `swap_meal`
    ignored exact recipe names. The test shift was noise; the swap bug was real. Read what a new
    failure is actually telling you before you "fix the test".
14. **A fix applied to one path is not applied to the sibling path.** `exclusions.ts` opens by
    documenting that `"egg"` must not match `"eggplant"` — and fixes it, with word-aware matching,
    on the ALLERGEN path. The DIET-TAG path a hundred lines below still used raw `.includes()`, so
    `dietTagConflicts("vegan", ["eggplant"])` reported an egg. It sat latent because no recipe in
    the library paired vegan with eggplant; the 169 -> 293 expansion added one and it surfaced
    immediately. When you fix a matching bug, grep for every OTHER place that does the same kind of
    matching — the header comment proved we knew about this class of bug and still shipped it twice.
15. **Reproducing a design means reproducing its COMPOSITION, not applying its tokens.** Asked to
    build a set of reference boards into the app, I started from the existing page and added the
    boards' surface qualities — a serif face, a cream surface token, one forest panel, unequal
    cards. Rejected: *"you slightly changed our initial design, you didn't incorporate the
    inspiration well."* The tokens were right and the result was still wrong, because the
    composition never changed. Start from the reference and build what it shows, even when that is
    unlike anything in the repo. Starting from the existing component tree guarantees a near-miss.
16. **A tool's budget is a project constraint — plan the session around it.** A conversation can
    read only so many images before every further image is rejected at any size. It has now been
    hit twice, the second time mid-task, which is why a shipped photograph went out without ever
    being looked at. Do image-heavy work in a fresh session, read the (free) docs first, downscale
    to ~900–1200 px, read 1–3 at a time, and use contact sheets to check many things at once.
17. **Knowledge that lives only in a chat gets re-derived, badly.** The prompt that produced a
    phone mockup used the word `app` — a failure documented in CONTEXT.md for weeks — because that
    prompt was improvised in a message instead of taken from a repo file. Reference images pasted
    into a chat are worse: they cannot be re-derived at all. Prompts belong in `designs/`,
    reference boards in `designs/references/`.
18. **A folder name is not evidence of what is in a picture.** The salmon photograph was sitting in
    a folder called `chicken andveg`. Anything mapping an image to a specific dish must be verified
    by looking, which is exactly why `RECIPE_IMAGES` is an exact map with a "look at it first" rule
    rather than a keyword matcher.
19. **A tool's own limits can counterfeit a bug.** A 430 px headless screenshot showed headings and
    card titles clipped at the right edge — a textbook horizontal-overflow symptom. There was no
    overflow: **headless Chrome on Windows will not lay out below about 500 px**, so it rendered at
    ~500 and handed back the left 430 columns. Proved by capturing at both widths and diffing —
    the 430 image was pixel-identical to the left 430 columns of the 500 one, which it could only
    be if both had laid out at 500. Before debugging what a tool shows you, check that the tool can
    show it. (Same family as lesson 2, "ask whether the test is wrong first", and the `window.top`
    bug in CONTEXT.md: testing in the wrong environment told me it was fine.)
20. **"Large photograph" is not the same instruction as "the food, cut out."** The hero was built
    as a full-bleed rectangle running off the frame edge — faithful to sage-09, and still not what
    the reference does, because sage-06 lays the *bowl itself* on the page with its own shadow and
    lets the frame crop it. Ana's correction was immediate. A rectangle reads as a photo in a slot
    at any size; only removing the background makes the dish an object the layout can sit under.
    When a reference shows imagery integrated rather than placed, check whether the thing being
    reproduced is the picture or its silhouette.
21. **Fit the shape you know is there.** Masking that plate by segmentation failed in a way worth
    remembering: a flood fill from the frame edges leaked through the bok choy where a leaf bridges
    the rim, and ate a bite-shaped hole out of the food. The plate is a circle photographed from
    overhead — fitting a circle to the brightest connected blob is both simpler and exact. Reach
    for the strong prior about the subject before reaching for a general algorithm.
22. **Lesson 15 recurs the moment you stop transcribing.** Handed `sage-04` and told what each
    part should hold — plate, gauges, upcoming meals — I built those parts in an arrangement of my
    own and got *"this is definitely not what i showed you. Do it exactly like in the pic."* Right
    parts, invented composition: the identical failure, one screen after learning it. Being told
    what the elements MEAN is not the same as being told where they GO, and a brief that supplies
    the meaning still leaves the layout to be copied. Transcribe the board first — panel by panel,
    column by column — and only then decide what each panel holds.
23. **The reference is the frame you were handed, not the file it was cropped from.** Told to copy
    a layout, I found the crop in `designs/references/boards/sage-04`, transcribed that board — and
    shipped the sidebar, the stack of side cards and the dark footer strip that live elsewhere in
    it. The crop contained none of them. *"I don't want the lateral sections, I only want what is
    in the model."* Knowing where a reference came from is useful; it is not permission to build
    the parts that were cropped out.
24. **An oval cut-out reads as a mistake even when the mask is perfect.** The poke bowl was masked
    exactly and still looked wrong, because Midjourney's "orthographic" overhead is only
    approximately overhead and that frame's bowl was 17% wider than tall. A plate is round, so an
    oval one looks like a botched cut rather than an accurate one. The masking script now always
    outputs a square, splitting the correction across both axes. And shoot cut-out candidates at
    `--ar 4:5` or `1:1`: `16:10` gives it room to clip the bowl by the frame, and a bowl clipped by
    its own frame cannot be masked whole at all.
25. **A cut-out is decided at generation time, not at masking time.** The poke bowl was masked three
    times and looked wrong every time, and none of it was the mask's fault: the source frame was
    `--ar 16:10`, so the bowl filled it vertically and could not be enclosed at any radius, and the
    prompt said *"the entire surface covered rim to rim"*, so the food reached the ceramic and the
    mask ended where the food ended. A plate reads as a plate because you can see the ring of
    ceramic around the food. Regenerating at `--ar 1:1` with *"the bowl sits fully inside the frame
    with a wide margin"* and *"the rim left completely clear"* produced a clean cut-out on the
    first generation, with no hand-tuning at all. Needing to pass the ellipse by hand is the signal
    that the FRAME is wrong, not that the numbers are.
26. **Check a cut-out against a colour that is not in the photograph.** Composited on the page's
    cream, both failure modes are invisible — leftover background is cream-ish, and food sliced at
    the mask edge just looks like the edge. On magenta, both are obvious instantly. Two rounds of
    "fixed it" went out because the check was made against cream, and the third only found the
    fault because the two versions were finally put side by side. **Diff the before and after
    before claiming an improvement**; had I done that, I would have seen the second attempt changed
    almost nothing.
27. **Tailwind silently drops an arbitrary value containing a comma.** `lg:w-[min(44%,54vh)]`
    produced no CSS at all — no error, no warning — so the `sm:w-[88%]` underneath stayed in force
    and the plate ran off the bottom of the screen. It looked like a sizing mistake and was
    actually a class that did not exist. Put the expression in a custom property
    (`style={{ "--plate": "min(44%, 50vh)" }}` + `lg:w-[var(--plate)]`) and check the COMPUTED
    width, not the markup: the class being present in the HTML proves nothing about whether any
    rule was generated for it.
28. **A class name built by joining strings fails by producing a DIFFERENT class, not none.**
    `(collapsed ? "justify-center px-0" : "gap-3 px-3.5 ") + (active ? "bg-cream …" : …)` — the
    first branch has no trailing space, so the collapsed rail's active item got `px-0bg-cream` and
    silently lost both its padding and its highlight. Nothing warns: it is a valid string, a valid
    `class` attribute, and a class that matches no rule. Every fragment of a joined class list ends
    with a space, and the ternary that can land mid-string is the one to check.
29. **"It feels slow" deserves a measurement before a fix.** The reported delay on tab presses was
    real and was `next dev` compiling each route on first visit — 5.9 s for Explore, against 70–135
    ms warm and 13–20 ms for the same first visit on a production build. Ten minutes of curl timing
    found it; any amount of code-reading would have found nothing, because there was nothing in the
    app to find. Measure cold vs warm and dev vs prod before touching anything.
30. **Counting a mapping is not counting what renders.** Home says "500 recipes, N of them
    photographed". Taking N from `Object.keys(RECIPE_IMAGES).length` would make the sentence lie
    the moment a recipe is renamed — the key survives, the photograph never renders, and the page
    claims coverage it does not have. Every count on the page resolves its keys against `RECIPES`
    first. A number in the interface should be derived from the thing the user can see, not from
    the thing that was supposed to produce it.

---

## 4. Training track (runs in parallel, never blocked by the above)

- **Now:** QLoRA, `Qwen2.5-1.5B-Instruct`, 4-bit, 3 epochs, 452 examples, RTX 2070.
  Checkpoints every 30 steps → **resumable**, survives interruption.
- **Technique:** QLoRA is correct for this task. Full fine-tuning would need ~20–24 GB and buys
  nothing for a fixed-schema tool-calling problem.
- **Hardware note:** the old **Ryzen 1700** was the likely cause of the training bugchecks
  (`0x1E`/`0xC0000096` = illegal instruction — a classic unstable-CPU signature). Since the
  **3700X** swap, sustained full-GPU load has been stable.
- **VRAM is the binding constraint:** training holds ~7.9 GB of 8 GB. Other GPU consumers
  (browser, editor) force a spill to system RAM and collapse throughput (26 s/it → 69 s/it).
- **Scaling later:** more GPUs ≠ bigger models by default (DDP replicates the whole model).
  Pooling VRAM needs **FSDP / DeepSpeed ZeRO-3**, which is slow and fragile over PCIe risers with
  no NVLink. For >7B, **rent one big-VRAM cloud GPU**; keep the multi-GPU rig for **inference
  serving**, which is what it's actually good at.

---

## 5. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Micronutrient data | **USDA FoodData Central (real data)** | Never invent nutrient numbers — that's the exact hallucination the engine exists to prevent |
| Safety phase | **Deferred to Phase 9** | Owner wants coherence demonstrated first; allergy/exclusion invariants remain in force |
| Fine-tune technique | **QLoRA** | ~99% of full-FT quality at ~⅓ the VRAM for a fixed-schema task |
| Base model | Qwen2.5-1.5B (local) | Fits 8 GB; upgrade to 3B/7B once data is expanded |
| Correctness | **Always code, never the model** | The model hallucinated macros when trusted with arithmetic |
| Nutrient boost | **A guarantee, not a bias** | As a scoring bias it could return a week with *less* of the nutrient (vitD 9.5 → 6.5µg). Now a monotone upgrade pass, verified after portion rebalancing; if no week beats the user's, theirs is kept and it says so |
| Read-only tools | `weekly_report`, `explain_meal`, `substitute_ingredient`, `symptom_check` | Advice must never silently rewrite someone's week |
| Dangerous replies | **Engine overrides the model** | The route prepends the model's reply to engine notes — a 1.5B could have written "sounds like low iron!" above a suicide hotline |
| Red flags | **Pulled forward from Phase 9** | A symptom tool without them isn't shippable, whatever the phase order says |
| Training data | **`npm run check:data` gates it** | A silent `slice(0, TARGET)` deleted every clarify example; the model would have lost the ability to ask instead of guess |
| Symptom advice | **Check their food, not their body** | The only claim the data can support |
| Test strategy | Scenarios + invariants + **fuzz** | Fuzzing found 3 real bugs on day one |
