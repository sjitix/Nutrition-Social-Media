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

**A Figma Make file exists** that Ana explored directions in:
`figma.com/make/5qe9IcoI2dQWzGNCRYNiY2/User-dashboard`. It is **not fetchable** — Figma Make renders
inside a logged-in session and returns 403. Its "C — Signal" direction was rebuilt from a screenshot
as `designs/top-designs/signal-asymmetric.html`.

### What each failed generation actually returned

Useful because the failure mode names the cause:

| what came back | what caused it |
|---|---|
| illustrated desktop computers on desks | the word "desktop" |
| photoreal phone mockups, tilted | the word "app" |
| dense grey spreadsheets, unreadable | ~90-word prompts, and banning all imagery |
| scattered collages of tilted screens | "dribbble", "ui design", "ui screenshot" |
| a small window floating on a pastel backdrop | no word forcing a full-bleed crop |
| the UI styled on a table with bowls and herbs | dropping the food terms from `--no` |
| overhead food photography, no interface at all | leading with the subject instead of the format |
| a wooden sign, plates of beans, an illustrated fish | `--chaos 100` |
| phone illustrations and app icons | the mobile prompt on V8.2; removed as unsalvageable |

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

## Running in parallel, do not disturb

**A 7B QLoRA fine-tune is training on Ana's desktop.** Kicked off 2026-08-05 on
Qwen2.5-7B-Instruct, 4-bit, 3,272 engine-validated examples, 409 steps at ~20 min/step, ETA around
Aug 11. See STATUS.md and WORKPLAN's "ASSISTANT v2" section.

Ana's instruction this session: *"the training is still going on another device. Don't think about
it."* WORKPLAN rule 7 also says the GPU run is never interrupted by other work. It is on a different
machine, so laptop work cannot disturb it — but do not propose anything that would.

## Documentation drift

**CLAUDE.md is stale.** It still describes Phase 1 as the frontier and lists the pre-`EditIntent`
tool set. In reality Phase 2 (the reel importer) and Phase 3 (the feed) are both shipped, along with
a 31-finding UX overhaul. WORKPLAN.md is the accurate record. Worth reconciling at some point;
deliberately not done this session because it was not what was asked for.

## What Ana asked for, in her own words

Recorded because they are the actual brief, and paraphrasing them has already caused misses:

- *"Very smart layout structure, attractive, modern design"* — like **Revolut, TikTok, Instagram**,
  the apps that "maximize their design layout success in very creative ways", because design is part
  of going viral.
- *"I don't want a pc having the screen, I want the full pic of it"* — on Midjourney rendering
  monitors.
- *"It should look as professional and modern as possible, the kind of design that usually go
  viral."*
- **Bright backgrounds.** Explicitly not a dark dashboard.
- **No imagery**, then later *"let it have pictures"* for Midjourney inspiration specifically — the
  product constraint stands, the mood-board constraint was relaxed.
- On the first Signal rebuild: *"I like it for the design in itself"* but not for this app.
- On shadcn: *"could be useful but not what I want"* — it is plumbing, not design, and default
  shadcn looks like every AI-built app.
- *"Screen design is ass"* — the honest feedback that ended four rounds of me producing evenly
  weighted dashboards.

## Design tooling researched

Ana asked what professionals use, and was considering a Midjourney subscription (since bought).

- **Mobbin** (~$15/mo, free tier) — searchable library of real screens and complete flows from
  shipped apps, Revolut included. Recommended as the single highest-value subscription: studying the
  real thing beats prompting for an imitation. Not yet taken up.
- **shadcn/ui** — free, not a dependency but a CLI that copies component source into the repo. The
  project is Next 15 + React 19 + Tailwind v4 + `@/*` → `./src/*`, all compatible. **Not
  initialised.** The risk flagged at the time: `init` rewrites `globals.css`, which carries
  hand-tuned WCAG values with the reasoning in comments.
- **v0.dev** — best AI-to-code fit, outputs React + Tailwind.
- **Recraft** — better than Midjourney for design/vector work.
- Free imagery: Unsplash, Pexels, Foodiesfeed; Google AI Studio, Ideogram, Leonardo, Krea.
- A short engagement with a **human product designer** was suggested as the highest-leverage spend.

## Environment and tooling notes

- **Dependencies were not installed** on this laptop at session start — `npm install` was needed
  before anything would run. `node_modules/.bin` was empty.
- Node lives at `C:\Program Files\nodejs`, on PATH. CLAUDE.md's note about a portable install under
  `%LOCALAPPDATA%` did not apply here.
- **The folder is a ZIP extract, not a clone** — note the doubled path
  `Nutrition-Social-Media-main\Nutrition-Social-Media-main`. It had no `.git`. Connected to the
  remote this session by `git init` + `fetch` + adopting `origin/main`, so full history is intact
  and no force-push was ever needed.
- **Line endings:** the repo stores CRLF, the extracted folder was LF. Git's autocrlf handles it —
  diffs come out as pure additions. Do not "fix" line endings; it would produce a 16,000-line noise
  diff.
- **Ports:** several dev/prod servers were left running during the session and Next fell through
  3000 → 3001 → 3002. Kill node before starting fresh.
- **Python is not on PATH.** Use node for scripting.
- `gh` CLI and `vercel` CLI are **not installed**. Git credentials are cached in Windows Credential
  Manager (`credential.helper=manager`), which is how pushes work without prompting.

## Git identity

The repo history had three identities. Set repo-locally this session to match the dominant one:

```
git config --local user.name  "sjitix"
git config --local user.email "adrawing26@gmail.com"
```

The machine's global identity is `Ana Seuleanu <anaseuleanu3@gmail.com>` and is untouched. Three
commits early in the session carry that identity; they were left alone rather than rewritten,
because fixing attribution is not worth a force-push that would break the desktop's clone.

## A bug worth not repeating

An interactive artifact rendered as a **blank page** because of a top-level `const top = …`.
`top` is a read-only property of `window`, so the browser threw a SyntaxError and the entire script
never ran. Node has no `window.top`, so a syntax check and a stubbed execution both passed locally.
The other names that do this: `self`, `parent`, `name`, `status`, `length`, `location`, `closed`,
`origin`, `event`, `screen`.

Lesson: testing in the wrong environment told me it was fine.

## Commits from this session, in order

```
91790ae  Recipe library 169 -> 292
51dfb4e  Recipe library 292 -> 500          (Ana's desktop, merged cleanly, zero overlap)
62c107b  Remove the stock food photos; add a desktop design candidate
0f0971a  designs/ — a reference folder for design candidates
956cbc0  Midjourney prompts; stop privileging one reference app in the brief
e8eee71  Midjourney file is prompts only, each self-contained
472e96f  rewrite the Midjourney prompts — they were producing pictures of monitors
8da8731  vary the visual hero across the Midjourney prompts
139a8c1  much shorter Midjourney prompts, imagery allowed
394eea8  ask for ONE full screen layout, not a Dribbble collage
2b7a140  every prompt names the subject and opens with beautiful modern
51ac3d9  lead the prompts with the format, not the subject
cf598d3  ask for a screenshot so it stops floating the UI on a backdrop
6afdbee  describe a homepage, not a ui screenshot
7c4df2d  crop tight to the page, put the food scene back on the block list
fdad3cc  restore the framing language that produced flat full-frame results
40b24c3  drop --s 50; try naming no page object
5c40f1c  prompts for the week plan screen, with and without imagery
b31f63a  put the proven framing prefix back on the week plan prompts
3b96f3c  make the week plan prompts concrete and shorter
85ba9e8  expand the week plan set from 8 to 20
71a160d  drop the --chaos exploration file
3053091  add a top-designs shortlist, starting with sage-typographic
e434a84  carry the sage language across Plan, Explore, Groceries, Assistant
bb6b999  fold Home into sage-app so the whole product is one file
bb683c0  Sage theme in the real app, as a scoped override
f4b37d6  the card tiles were still violet, because they were not tokens
393e354  Sage design connected to the engine at /sage
311a104  full navigation and all five tabs, connected to the engine
4a6aa25  publish a public design preview to GitHub Pages
7f22198  Explore and Groceries are live, not pictures of themselves
145687b  send the preview root to /sage, keep the original at /classic
81bd401  make the sage design the front door; original moves to /classic
2aba982  prompts for refining the shipped sage design
cc4312f  screenshots of the live sage app, for Midjourney --sref
8fdabe4  fix --sref prompts, parameters must follow the prompt text
bd90d29  fourteen week-plan layouts, palette held constant
2d780d7  CONTEXT.md — session handoff
```

Sixteen of those are Midjourney prompt iterations. That ratio is itself the finding.

## Verification commands used

Worth reusing rather than rediscovering:

```bash
npm run check:recipes     # gate: every ingredient priced, every dish plausible, Atwater holds
npm run test:engine       # 449/0 at last run, ~10 min at 500 recipes, fuzz is the slow part
npm run export:recipes    # writes NutriFlow-recipes.xls — the Gaps sheet drove the expansion
npx tsc --noEmit
npm run build             # NOT while `npm run dev` is running — it corrupts .next
```

Screenshotting the live app for `--sref`:

```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --no-sandbox `
  --hide-scrollbars --screenshot="$PWD\designs\screens\sage-home.png" `
  --window-size=1600,1100 --virtual-time-budget=8000 "https://ntrux.vercel.app/sage"
```

Reading an image from the clipboard (works around attachment limits):

```powershell
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()   # then downscale and save, then Read the file
```

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
