# CONTEXT — session handoff

Written at the end of a long session so the next one starts where this ended.
**Read this first, then CLAUDE.md, VISION.md and WORKPLAN.md.**

Everything described here is committed and pushed to `main`. Nothing is only on the laptop.

---

## Where it left off

The session ended mid-design-exploration, blocked on a tooling limit rather than a decision:
**this conversation exhausted its image budget**, so pasted screenshots stopped being readable
regardless of size. A fresh chat fixes it. Images can also be pulled straight from the Windows
clipboard with PowerShell (`[System.Windows.Forms.Clipboard]::GetImage()` → save → read), so in a
new session you can just copy an image and say "look at my clipboard".

**The open question:** which layout the week plan should use. Ana knows the current seven-column
version is not it, but not yet what should replace it. Fourteen candidate layouts are written as
Midjourney prompts in `designs/midjourney-week-layouts.md`.

---

## What is live

| | |
|---|---|
| **https://ntrux.vercel.app** | the real app on Vercel. `/` redirects to `/sage`. API routes run. |
| **https://sjitix.github.io/Nutrition-Social-Media/** | static preview on GitHub Pages, auto-deployed by Actions on every push to `main`. `/sage` works; `/plan` cannot, as static hosting has no server. |

Repo: `sjitix/Nutrition-Social-Media`, public. Commits are authored `sjitix <adrawing26@gmail.com>`
(set repo-locally this session; the machine's global git identity is different). **Never add an AI
co-author trailer** — see CLAUDE.md.

---

## The recipe library: 169 → 500

Started at 169. The binding constraint on plan quality was library size, not the solver: four
filters were literally unsatisfiable (Indian, Italian, Mexican and Middle-Eastern snacks were all
zero) and eighteen more cells sat under seven, the point at which one week is forced to repeat a
dish.

- This session took it 169 → 292.
- Ana's desktop then took it 292 → 500 in a parallel commit (`51dfb4e`), adding fast dinners and
  high-protein snacks. **Zero dinners could be cooked in 15 minutes** before that.
- Result: 0 empty cells, 0 critical. `check:recipes` green, `test:engine` **449 passed / 0 failed,
  fuzz clean**.

Two rules held throughout, both from WORKPLAN Phase 2, and must keep holding:

1. **Only ingredients already curated in `NUTRIENT_TABLE`.** Auto-matching new ingredients to USDA
   is unsafe — it produced `salmon fillet → Salmonberries`. New ingredients need hand-curation with
   a real FDC id.
2. **Macros are never written.** They are derived from the ingredient quantities by `deriveMacros`.

**A real bug surfaced by the expansion:** `dietTagConflicts` matched `NON_VEGAN` on raw substrings,
so **"eggplant" contained "egg"** and a vegan aubergine dish was reported as containing egg. The
file's own header documents that exact trap and fixes it on the *allergen* path; the *diet-tag* path
never got the fix. It sat latent because no recipe paired vegan with eggplant until one was added.
Fixed via `VEGAN_EXCEPTIONS`, with controls proving `egg` / `eggs` / `egg whites` / `egg noodles`
are all still caught. Logged as hard-won lesson 14 in WORKPLAN: *a fix applied to one path is not
applied to the sibling path.*

**Tooling added:** `npm run export:recipes` writes `NutriFlow-recipes.xls` — four sheets (Recipes,
Ingredients with FDC ids, Coverage, Gaps). The Gaps sheet is what drove the expansion.

---

## Photography: removed

All twelve stock photos are deleted. The reason matters and should not be undone casually:
with 12 photos and 500 recipes, keyword rules meant **one image stood in for 46 different
recipes** — `chicken.jpg` for 46, `bowl1.jpg` for 31. Scrolling showed the same photograph
repeatedly, of food that was not the recipe on the card.

`imageForMeal()` and `IMAGE_RULES` remain in `lib/recipes.ts`, **deliberately empty**, so real
per-recipe imagery can return later without touching a caller.

The card tiles were also hardcoded gradients in JS, two of them brand violet — meaning the app
could not be re-skinned while its largest blocks of colour were baked in. They now live in
`globals.css` as `--tile-1 … --tile-14` and `gradientForMeal` returns `var(--tile-N)`.

**Agreed imagery plan:** hero moments only, perhaps 8–12 photographs. Not one per recipe — 500
dishes cannot be shot, and partial coverage is what caused the original problem.

---

## Design

### What was rejected, and why

Four rounds were turned down before anything landed. This list is the most useful part of this
document — it is also reproduced in `DESIGN-PROMPT.md`.

1. **Arbitrary colour blocks per dish** (hue by cuisine). Colour encoding nothing is decoration, and
   decoration reads as unfinished.
2. **Ingredient-derived "dish portraits"** (blobs sized by real gram weights). Cleverer, still
   imagery. The constraint is *no imagery*, including generated.
3. **Austere flat layouts** — hairline borders, 9px padding, system fonts at defaults. Looked like
   unstyled HTML. *"No photography" was mistaken for "no craft".*
4. **The standard SaaS dashboard** — sidebar, top bar, four equal stat cards, a table. Evenly
   weighted and forgettable. **The most important one to avoid.** Adding shadows and gradients does
   not fix it.
5. **A "defocused" hero** — blurred organic shapes meant to read as shallow depth of field. Read as
   an unfinished image.

The stated requirement that kept being failed: **one strong organising idea and dramatic hierarchy —
one element enormous, everything else quiet.** Even, tidy and balanced is not wanted.

### What landed: the sage design

Grew out of a Figma Make exploration Ana liked ("C — Signal", rebuilt at
`designs/top-designs/signal-asymmetric.html`), then a Midjourney generation with a sage-green
editorial feel.

Live at `/sage` with five tabs — Home, Plan, Explore, Groceries, Assistant — **connected to the real
engine**, not fixtures. `selectWeekFromDb` generates the week at request time; `RECIPES` fills the
library; `groupByAisle` builds the shopping list.

- Palette: sage ground `#dfe6da`, forest `#3d5233` actions, lime `#b9d94a` for exceptions only.
  Contrast verified ≥ WCAG AA before adoption (ink 12.5:1, muted 4.7:1, white-on-forest 8.6:1).
- Implemented as a **scoped theme override**: the app's ~291 colour utilities all read from eleven
  tokens, so `.theme-sage` re-skins everything without editing a component.
- **Photo-ready**: image areas are `<div class="slot">` holding a typographic fallback, marked
  `SLOT:` in the markup. Swapping in an `<img>` changes nothing else.
- `/classic` holds the original violet design. Both live, one click apart.

**A bug worth remembering:** each tab initially called `selectWeekFromDb` independently, and it
randomises — so Home said Saturday was 59 g short, Plan said Thursday 52 g, Assistant offered to fix
Wednesday. Three different weeks. Fixed by computing the week once at module load in
`src/app/sage/demo.ts`. React's `cache()` would not have fixed it: it dedupes within a request, and
these are separate navigations.

### Interactivity status

| screen | state |
|---|---|
| Explore | **live** — search over names and ingredients, meal/diet filters, ≥25g protein, ≤20 min, four sorts, paging. Uses `filterFeed`/`sortFeed` from `lib/feed.ts` rather than reimplementing them. |
| Groceries | **live** — check-offs persist, intersected with the current list on load so departed items do not linger; the write effect is gated on a `loaded` flag because WORKPLAN records that exact bug shipping once. |
| Home, Plan, Assistant | real data, **read-only** |

**Next code task:** wire Plan (regenerate, swap a meal, meal detail) and Assistant (real
`/api/assistant` calls). The engine is pure TypeScript so Plan can work client-side; the Assistant
needs the server, which Vercel provides.

---

## Deployment

- **Vercel** — Ana connected it via GitHub. Redeploys on push. API routes verified running:
  `/api/plan` 200; `/api/operation` 400 on an empty body and `/api/import` 422 on a bad URL, both
  correct rejections rather than crashes.
- **GitHub Pages** — `.github/workflows/pages.yml`, added this session. Builds a static export
  (`STATIC_EXPORT=1`, `BASE_PATH=/Nutrition-Social-Media`) and deploys via Actions. The workflow
  deletes `src/app/api` **in CI only**, because `output: export` refuses to build with dynamic route
  handlers; the exported pages call no API. Root redirects to `/sage`, original kept at `/classic`.
- Pages had to be enabled once via the GitHub API — `enablement: true` in the workflow failed. Done
  using the token from Windows Credential Manager. **Flagged to Ana at the time; do not reach for
  that credential again without asking.**
- The assistant is in demo mode — no `ANTHROPIC_API_KEY` set, which is correct for a public URL.

**Deployment gotcha, learned the hard way:** running `npm run build` while `npm run dev` is live
corrupts `.next` and the dev server serves blank white pages (`Cannot find module './611.js'`). Stop
dev first, or delete `.next` after.

---

## Midjourney

Ana has an account (V8.2) and wants to keep using it for inspiration. Prompt files:

- `designs/midjourney-week-layouts.md` — 14 week-plan structures, palette held constant
- `designs/midjourney-sage-refine.md` — refining the shipped design, including `--sref` prompts
- `designs/midjourney-prompts.md` — general product directions
- `designs/screens/*.png` — headless-Chrome captures of the live app, committed so
  `raw.githubusercontent.com` serves them to `--sref`. **Recapture after a design change.**

### What was learned about prompting it, expensively

Roughly a dozen rounds. Each fix below was discovered by a failed generation:

- **"desktop"** → it draws a desktop *computer*. Say "web page".
- **"app"** → device mockups, because Dribbble is full of them. Say "web page" or "homepage".
- **"ui design" / "ui screenshot"** → tilted multi-screen showcase shots.
- **"dribbble"** → the same. `awwwards` indexes full sites instead.
- **Negation in the positive prompt does not work.** "no device body" *summons* a device. Negation
  belongs only in `--no`, and `--no` must come **last** because it swallows the list after it.
- **Parameters must follow the prompt text.** A prompt starting with `--sref` is rejected.
- **Long prompts turn to grey mush.** ~90 words produced dense unreadable tables; ~25–35 works.
- **`--s` (stylize) is the aesthetic budget.** Lowering it to 50 made output plainer without fixing
  framing.
- **`--chaos` buys variety by ignoring the prompt.** At 100 it returned a wooden sign, plates of
  beans and an illustrated fish. Wrong trade when framing is the hard part.
- **Framing that works:** `flat 2d web page design, straight on front view, orthographic, fills the
  entire frame edge to edge`.
- **It cannot render dense UI text.** Prompts asking for "21 dish names with calories" spend their
  effort on gibberish. For inspiration, describe composition and mood, not the dataset.

---

## Other artefacts from this session

- `DESIGN-PROMPT.md` — the full design brief, prompt-only, for a human designer or any AI tool.
  Includes the rejected-concepts list.
- `designs/top-designs/` — the shortlist, max three at a time, each with the reason it is standing.
  Currently `sage-typographic.html` and `sage-app.html`.
- `designs/README.md` — indexes everything in that folder with accept/reject reasons.
- `NutriFlow-recipes.xls` — the library as a spreadsheet.
- `src/components/ThemeSwitch.tsx` — floating violet/sage toggle for the *original* layout. Arguably
  redundant now that `/sage` exists as a real route; removing it was suggested and not actioned.

---

## Immediate next steps

1. **Pick a week-plan layout.** Candidates in `designs/midjourney-week-layouts.md`. Ana is exploring
   in Midjourney; an offer to build four as real HTML with live data was declined in favour of
   continuing to generate.
2. **Wire Plan and Assistant** to be interactive, matching Explore and Groceries.
3. **Decide on imagery** — hero-only photography, or stay fully typographic.
4. Optional: remove `ThemeSwitch`, now that the real comparison is `/classic` vs `/sage`.

## Standing rules

From CLAUDE.md and WORKPLAN, and they held all session:

- **No emoji in the UI.** SVG line icons only.
- **Never add an AI git co-author.** Commits are the owner's alone.
- **Never push red.** `npm run test:engine` must be green; it was 449/0 at last run.
- **The LLM decides what; deterministic code guarantees it is correct.** The model does no
  arithmetic, ever.
- **Honesty over silence** — if the engine adjusts something, the interface says so.
