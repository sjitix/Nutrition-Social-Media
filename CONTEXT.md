# CONTEXT — session handoff

Written at the end of a long session so the next one starts where this ended.
**Read this first, then CLAUDE.md, VISION.md and WORKPLAN.md.**

Everything described here is committed and pushed to `main`. Nothing is only on the laptop.

---

## Where it left off

### >>> THE BOARDS ARE BUILT. What to look at, and what is still open <<<

`designs/references/boards/sage-01 … sage-12` have been **reproduced at `/sage`** — the whole
shell and all five screens, connected to the real engine as before. This replaces the previous
brief, which asked for exactly this and warned that the attempt before it had adapted rather than
reproduced. **What to do now is look at it and say whether it is the reference or not.**

**What the twelve boards actually contain** (worth having in text, so nobody spends the image
budget re-deriving it):

| board | what it is |
|---|---|
| `sage-01` | **not a design.** A screenshot of Midjourney's own web UI with the generation grid and the prompt visible: *"flat 2d web page design, straight on front view, orthographic, fills the entire frame edge to edge, beautiful modern nutrition and meal planning homepage, editorial headline, dish with calories, recipe cards"*, `--no tilted, angled, perspective, 3d, mockup, device, monitor`, `ar 16:9`, `raw`, `sw 60`. The provenance record |
| `sage-02` | cream page, mosaic of unequal sage/cream blocks, real bowls composited **on** the layout |
| `sage-03` | **full-width dark forest nav bar**; giant serif "Editorial Nutrition"; a huge bowl photograph overlapping its neighbours and cropped by the right edge, with a small round badge sitting on it; a forest block flush to the left page edge; a bar chart and a small data table |
| `sage-04` | the inversion — a **dark forest ground** carrying cream cards, three circular arc gauges with big numbers, a 4×3 tile grid |
| `sage-05` | pale sage hero over a white section; huge serif left, large square photograph right, a tiny stat stack, then an enormous "78" |
| `sage-06` | the clearest one. Huge serif left; **a photograph laid straight on the page with no card and cropped by the LEFT edge**; a text column right; **two deep forest cards, each carrying one very large number** (432, 4080) |
| `sage-07` | a **quiet sidebar** (same sage as the page, hairline only); serif headline; big photo right; a white **"Recipes" list card** — name, description line, figure and a small round control at the right, hairlines between |
| `sage-08` | headline left, and a **real table of numbers** used as a design element on the right; a near-black photo card beside a cream card; a narrow right column of stacked cards including one big number with a radial arc |
| `sage-09` | the best homepage. Light nav; enormous serif "Editon & meal planning"; **an enormous photograph running off the RIGHT edge**, ~45% of the width; below it a row of unequal blocks — a wide sage panel of hairline-ruled figures, a photo card, a narrow stack |
| `sage-10` | **the app.** Icon rail + **forest sidebar**; a band of dark summary cards; tall day columns; a right rail that is a masonry of small photographs |
| `sage-11` | same shell; a row of **unequal** summary cards where two are forest and one is a photograph; day columns as tinted panels holding cream rows |
| `sage-12` | the cleanest app screen. Forest sidebar carrying a long **list**, cream main area, a **row of six wide photograph cards**, a big "Weekly Plan" heading, then **seven day columns of flat sage blocks with ragged bottoms** |

The set therefore answers the question that was open: **it shows both** — 02–09 are editorial
homepage compositions, 10–12 are the application with a forest sidebar, and `sage-07` shows the two
combined. So the shell is a sidebar and the Home content is editorial.

Food photographs go in `public/food/` and are mapped by EXACT recipe name in `RECIPE_IMAGES`
(`src/lib/recipes.ts`). Read `designs/midjourney-dish-photography.md` before touching any of it —
the honesty rules there are not optional.

### What was built, screen by screen

**The shell** (`src/app/sage/layout.tsx` + `SideNav.tsx`, which replaces `SageTabs.tsx`) — a deep
forest **sidebar** running the full height of the window, 268 px, with the nav AND content: the
real week, seven days with the engine's calorie and protein totals. The page beside it is warm
cream, edge to edge, with **no max-width wrapper** — a centred container makes running photography
off the frame impossible, which is half of what the boards do. Below `lg` the panel becomes a bar.

**Home** — the boards' composition, section by section: an enormous serif headline left, and the
hero photograph as a **cut-out plate** — masked out of its background, laid on the cream with its
own shadow, oversized, cut by the right edge of the frame, sitting *on* the layout with the library
card sitting on *it* (sage-06, plus sage-03's badge on the rim). Then a row of unequal blocks — a
sage panel of hairline-ruled macros, a photo block, two deep forest cards each carrying one very
large number (sage-09, sage-06); the week as a **hairline-ruled ledger table**, dense and editorial
(sage-08); a photograph cropped by the **left** edge beside a dense list card (sage-06, sage-07); a
full-width forest band (sage-03).

> The hero was a full-bleed rectangle first, and Ana's note was that it should be *"only the bowl
> cut, sitting on top of the layout"* — which is right, and is the difference between reproducing
> sage-06 and approximating it. A photograph in a rectangle reads as a photo in a slot however
> large it is; the plate as a free object is what makes the page look like the board.

**Plan** — sage-12: a strip of photograph cards across the top, a big "Weekly plan" serif heading,
then **seven columns of flat sage blocks** rather than a bordered grid. A grid locks every cell to
its row's tallest; columns let each meal be its own height, which is where the boards' texture
comes from. The day that is under target carries a forest block saying by how much, which is also
what makes the row of columns ragged.

**Today (`/sage/today`) — an EXPLORATION, added after the rest was approved.** Ana: *"i really like
this design and all but i still wanna explore more. Keep this as a version."* The version she liked
is committed at `0f45fa7`, so it is recoverable whatever happens next. Today is built from
**`sage-04`**, the one board that inverts the others — a near-black forest ground carrying cream
cards, with three circular arc gauges. Her brief for what those parts hold: the photograph is the
**dish coming up next**, the three circles are the **macros already hit**, and the **upcoming meals
sit below them**. The week screen is untouched; she has said the week is a later conversation.

**It took three goes, and the two failures are the same failure.**

1. *"this is definitely not what i showed you. Do it exactly like in the pic."* — right parts, an
   arrangement of my own. Lesson 15, one screen after writing it down.
2. Then I transcribed the board faithfully — and **transcribed more of it than she had sent me**.
   Her second message was a crop of the board's single cream card; I built the card plus the forest
   sidebar, the stack of side cards and the dark footer strip that are elsewhere in the same board.
   *"I don't want the lateral sections, I only want what is in the model."*

So: **the reference is the frame you were handed, not the file it was cropped from.** The screen is
now exactly what that crop shows, on one cream page:

```
a nav row — mark and two links left; a label, a chevron and three small circles right
LEFT   a serif headline of two lines, a short paragraph, and beneath them a HUGE ROUND PLATE
       running off the bottom of the frame
RIGHT  a caption, THREE THICK RINGS with a number in each, two hairline spec rows (the second
       with a leader rule), then outlined rows each led by a dot
```

A fourth pass moved it OUT of `/sage` to shed the sidebar, and that was a misread of "no lateral
sections" — she meant the board's side panels, not the app. *"I meant rebuild the Today tab inside
the sage design."* It is back at `/sage/today`, in the shell, and drops the board's own internal nav
row because the sidebar is that nav.

**The plate always has a photograph on it, and no component special-cases a dish to achieve that.**
The demo profile pins `Chicken & Egg Poke Bowl` to Monday lunch through `lockedMeals`, the engine's
own pin. Three things had to be true for that to work:

- **`selectWeekFromDb` does not place a pin.** It RESERVES the dish — marks it spent so the
  selector cannot put it elsewhere — and `reimposeLocks`, which actually places it, is internal and
  runs inside `applyOperations`. So `demo.ts` builds the week and then runs it through
  `applyOperations(…, [{tool: "regenerate_week"}])`, the same public path the assistant takes.
  Verified over five runs: the pin lands every time, Monday rebalances to exactly 2,000 kcal, and
  all 21 dishes stay distinct.
- **Today shows the fixture week's Monday**, and says "Monday". `/sage` holds no per-reader data —
  the week is a fixture — so a screen claiming to know your day would be the only dishonest thing
  on it. The HOUR is real, so "up next" still moves through the day.
- **The plate prefers an upcoming meal that is photographed**, falls back to the next meal, then to
  a photographed meal already eaten — and each case carries its own label (`Up next` / `Later
  today` / `Earlier today`). Five of 501 recipes are photographed, so "the next meal" is usually a
  dish with no picture on a screen that is entirely a picture. The plate never claims to be up next
  when it is not, and never borrows another dish's photograph.

**A knock-on worth knowing: regenerating through the executor re-solves every day, so the week now
lands on target and the "Saturday is 42 g short" copy on Home, Week and Assistant could read "0 g
short".** All three now branch on whether there is actually a shortfall. A sentence like "lands 0 g
under on protein" is the kind that makes a reader stop believing the other numbers.

When the dish has no photograph the plate keeps its circular shape and carries the name on a
**fixed sage**, not `gradientForMeal` — the tile palette hashes a name onto fourteen hues, which is
right for a wall of cards and made the plate dusty pink.

Two things about it worth knowing:

- **"Already hit" is inferred from the clock, not from a log.** The app has no record of what you
  actually ate — `log_meal` exists in the engine but nothing on `/sage` writes to it — so a meal
  counts as eaten when its slot time has passed (breakfast 08:00, lunch 13:00, snack 16:30, dinner
  19:30). The page says so in as many words rather than implying knowledge it does not have. When
  logging is wired up, `SLOT_HOUR` is the only thing that changes.
- **The clock is read in the browser, not on the server**, so the whole week is passed to a client
  component and it picks the day. The server's clock is the *build* clock on the static export,
  which would freeze "today" at whatever day the deploy ran. First client render matches the server
  (nothing eaten), then an effect moves it to the real time — no hydration mismatch.
- **`?at=14` pins the hour** for review. A screen whose entire state is "what time is it" can
  otherwise only be judged at whatever o'clock you open it; at 21:30 every meal is behind you and
  half the design is invisible. The override prints a line on the page saying it is a preview.

The nav gained **Today** and the old **Plan** tab is now **Week**, since there are two now.

**Explore, Groceries, Assistant** — restyled into the same system (cream ground, sage blocks, one
forest panel carrying the big number, hairline data rows, small radii). Explore's wall is no longer
a uniform four-up: the first card of every page spans two columns. All the logic is untouched —
Explore still calls `filterFeed`/`sortFeed`, Groceries still has its guarded persistence.

**Tokens** — two were added, `--color-panel` (the deep block) and `--color-tint` (the sage block),
so there are now **thirteen**. And the ground was **flipped**: the page used to be sage with white
cards; it is now cream with sage blocks on it. That flip is most of why the previous attempt read
as the old design in new colours — sage as a background is wallpaper, sage as a block is
composition. Contrast was recomputed, not estimated; every pair is ≥ AA and the numbers are in the
comment above `.theme-sage`.

**`ThemeSwitch` no longer renders on `/sage`** — it was a floating pill reading "Violet" that
changed nothing (the subtree pins its own theme) and it sat on top of the sidebar footer.

### Practical: the image budget

**A conversation has a finite image budget.** Once spent, no further image can be read at any size.
It has been hit twice on this project — including mid-task, which is why one of the shipped photos
went out unverified. **The budget survived this session** by spending it deliberately:

- Read the docs FIRST — text is free — then spend the budget on pictures.
- **A contact sheet is the single biggest saving.** All twelve boards went into one 1560×1168 sheet
  (3×4, labelled) for the cost of one image; that alone identified which boards were the app and
  which were the homepage, so only the informative ones were opened full size.
- **Pair them.** Two boards stacked into one 1200×1344 image reads as one image, not two.
- All fifteen dish photographs went into one 4×4 labelled sheet at 430×300 per cell — legible
  enough to tell salmon from cod from chicken.
- `sharp` is already installed (Next pulls it in), so building sheets is a five-line node script.

### State

Committed on `main`. `npm run test:engine`, `npx tsc --noEmit` and `npm run build` are all green —
see the verification section at the bottom. Both live URLs redeploy from `main`.

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

## Photography: REVERSED — the app is photography-led again

The twelve stock photos were deleted because keyword regexes meant **one image stood in for 46
different recipes** (`chicken.jpg` for 46, `bowl1.jpg` for 31) — the same picture scrolling past,
of food that was not the recipe on the card.

**That decision has been reversed, deliberately.** Ana's argument, and it is right: a discovery
wall of 500 dishes needs pictures — people browse food with their eyes. Text-only cards are fine on
the Plan board (you already chose the meal); they are worse on Explore.

**The old failure was not "too few photos". It was a photo standing in for a dish it wasn't.**
So the mechanism changed, not just the count:

- `imageForMeal()` is now an **exact recipe-name map** (`RECIPE_IMAGES`), not a regex list. A
  regex can widen accidentally; an exact key cannot. A miss returns `null` and falls back to the
  typographic tile, so partial coverage is honest.
- **`public/food/` exists again.** Three photographs are in it (see below). 497 recipes still fall
  back to `--tile-1 … --tile-14`.
- **Target: an image for every recipe.** Generated in one locked style so the library looks like
  one product — see `designs/midjourney-dish-photography.md`.
- **User uploads are the upgrade, not the threat.** Generated images are the FLOOR; a real photo of
  the dish someone actually cooked replaces it. Uniformity comes from the **frame** (fixed crop,
  radius, type position, a subtle wash), not from the photographs — which is how Instagram stays
  coherent while containing everything.

**Shipped so far — all four looked at, and checked against the recipe's ingredients and dietTags:**

| file | recipe | what is in frame |
|---|---|---|
| `miso-cod.jpg` | `d-miso-cod` Miso-Glazed Cod with Bok Choy & Rice | white fish under a dark miso glaze, sesame, bok choy, brown rice. **Not** salmon |
| `baked-salmon.jpg` | `d-baked-salmon` Baked Salmon & Potatoes | pink flaking fillet, baby potatoes, broccoli, lemon |
| `sheetpan-chicken.jpg` | `d-american-sheetpan-chicken` Sheet-Pan Chicken & Veg | chicken breast, roast sweet potato, charred broccoli, paprika. **Now verified** — this is the one that shipped unlooked-at |
| `shakshuka.jpg` | `b-shakshuka` Shakshuka | two eggs poached in tomato and pepper, feta, herbs. No bread in frame, so `gluten_free` holds; feta is in the recipe, so `vegetarian` holds |

**A fifth dish, and the first time the photograph came before the recipe.** Ana generated a loaded
chicken-and-egg poke bowl from the prompt in `designs/midjourney-dish-photography.md` §7 and asked
for it on the Today plate. Nothing in the library depicted it — the only poke bowls were salmon and
tofu — so `l-chicken-egg-poke` was **added first** and the photograph mapped to it second. That is
the order, always; the alternative is a picture standing in for a dish that does not exist.

Three things that came out of it and will recur:

- **`maxIngredients` can silently exclude your best photograph.** The selector keeps recipes with
  `ingredients.length <= maxIngredients + 1`. A loaded bowl is a twelve-ingredient dish, and the
  fixture in `demo.ts` was set to 8 — so the one dish with a cut-out could never be selected for
  the screen composed around it. Raised to 12. It is a design fixture, not a user's setting.
- **Shoot cut-out candidates square-ish.** `--ar 16:10` gave Midjourney room to clip the bowl top
  and bottom, and a bowl clipped by its own frame cannot be masked whole. Use `--ar 4:5` or `1:1`.
- **`?at=` pins the hour for review.** Five recipes of 501 are photographed, so
  whether the composition works with a picture in it was otherwise down to luck. It swaps only the
  plate and its heading, and the page says the figures beside it are still the real day's.

**The poke bowl was reshot at `--ar 1:1` to make a clean cut-out possible**, after three masking
attempts on the `16:10` frame that all failed for the same two reasons: the bowl filled that frame
vertically so it could not be enclosed at any radius, and the prompt had asked for the food to
cover the bowl "rim to rim", so the mask ended where the food ended and it read as a circular crop.
The cut-out prompt in `designs/midjourney-dish-photography.md` §7 fixes both — `--ar 1:1`, the bowl
fully inside the frame, and the ceramic rim left clear — and produced a clean plate on the first
generation with no hand-tuning. `pokebowl-17` is the frame in use; `-16` is the one that could not
be masked whole.

Plus `miso-cod-plate.webp` — the **same photograph** as `miso-cod.jpg` with its background masked
off, so the plate is an object the hero can lay on the page and crop by the frame. Made by
`node scripts/make-plate-cutout.mjs <src> <out.webp> <preview.jpg>`, which fits a **circle** to the
plate. Segmenting the background was tried first and fails on this dish specifically: a flood fill
from the edges leaks through the bok choy where a leaf bridges the rim and eats a hole out of the
food. Feed it the ORIGINAL frame (`codmisobokchoi-09`), not the shipped crop — the crop cuts the
plate at three edges.

The other eleven photographs in `designs/references/food/` are **alternate frames of these same
four dishes** — five more chicken-and-veg, two more salmon, two more cod, three more shakshuka. So
there is nothing else in that folder to map: a fifth mapping would mean a photo standing in for a
dish it isn't, which is the exact failure the map exists to prevent. Growing coverage past four
means generating new dishes, not remapping these.

**A trap that already bit:** the source folders on the Desktop are mislabelled — the *salmon*
photo was sitting inside `design/recipes/chicken andveg/`. A filename or folder is not evidence of
what is in a picture. Always look.

The card tiles were also hardcoded gradients in JS, two of them brand violet — meaning the app
could not be re-skinned while its largest blocks of colour were baked in. They now live in
`globals.css` as `--tile-1 … --tile-14` and `gradientForMeal` returns `var(--tile-N)`.

**Queued, not built: `npm run check:images`** — a gate in the family of `check:recipes` /
`check:data`. It would catch, with no vision at all: a map key that is not a real recipe name (today
that fails **silently** — the card just shows a gradient), a mapped file that does not exist, an
orphan file with no entry, **two recipes pointing at the same file** (the 46-dishes failure, made
mechanically impossible), and oversized files. It cannot check whether the photo shows chicken;
that stays human.

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

### The chosen direction: editorial sage (current)

Settled from a set of eight Midjourney boards, produced by prompt #10 in
`designs/midjourney-sage-refine.md` (the `--sref` one at `--sw 60`) — so it is reproducible.

**The boards are committed at `designs/references/boards/`**, alongside
`designs/references/food/` (15 dish photographs) and a `manifest.csv` mapping every file back to
its original name.

> **BUILD `sage-01` … `sage-12` FIRST.** Ana named these as the set to try. They are the whole of
> what was `Desktop\design\sage\` — three Midjourney jobs plus one saved favourite. `board-13` …
> `board-36` are earlier rounds kept as a record, not the target.

Five things make them work. Four need no photography at all:

1. **Deep forest green as large solid panels**, not just button fills. The shipped app's biggest
   colour blocks are white cards; in the references a near-black green panel carries whole sections.
2. **A serif editorial display face** against a small sans for data. The app runs system sans at
   every size.
3. **Cream as a third surface** alongside sage and white, so a card can recede or advance.
4. **Layered, unequal cards** — different sizes, overlapping edges, breaking their containers.
   Not a uniform grid.
5. **Photography as large integrated blocks** woven through the layout, with bowls **cropped by
   the frame edge** — Ana called this out specifically.

**They settle the week-plan structure too, which was previously thought open.** `sage-10`, `11`
and `12` are the application, not homepage collages, and all three answer it the same way: seven
columns of stacked blocks on a cream page, with a forest sidebar. That is what `/sage/plan` is now.

### The rebuild that missed — worth not repeating

A first attempt applied 1–4 to the existing `/sage` Home and was rejected: *"you slightly changed
our initial design, you didn't incorporate the inspiration from the photos well."*

The cause is worth stating plainly, because it is a general trap: **it started from the existing
component tree and adjusted it, rather than starting from the board and building what the board
shows.** Surface tokens (a serif, a cream, one panel) applied to an unchanged composition read as
the old design with adjustments. Reproducing a layout means reproducing its *composition* — panel
structure, where photography sits and how big, overlap, density — even when that is unlike
anything currently in the repo.

The second attempt (the one now on `main`) started from the boards and threw away the page.
Concretely, the things that had to change and could not have been reached by adjusting: the
centred `max-w-[1400px]` container and the row of pill tabs are gone; the ground is cream and sage
is a block rather than the background; the radii went from 26–32 px to 8–14 px; photography runs
off the frame instead of sitting in a rounded card; and the week is columns rather than a bordered
grid.

### An environment quirk that cost time, so it is written down

**Headless Chrome on Windows will not lay out below about 500 px.** `--window-size=430,1500`
produces a 430-px-wide PNG, but the page is rendered at ~500 and the screenshot is simply the left
430 columns of it — so text appears cut off at the right edge and it looks exactly like a
horizontal-overflow bug. Proved by capturing at 430 and at 500 and comparing: the 430 image is
**pixel-identical** to the left 430 columns of the 500 one. Do that comparison before hunting for
an overflow that is not there, and treat sub-500 layouts as unverified by this tool.

### What landed earlier: the sage design

Grew out of a Figma Make exploration Ana liked ("C — Signal", rebuilt at
`designs/signal-asymmetric.html`), then a Midjourney generation with a sage-green editorial feel.

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
as `designs/signal-asymmetric.html`.

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
| beautiful posters of one huge number, no interface at all | `one enormous number` + `vast empty space` + `award winning minimal`, with **no interface content named**. The prompt described a composition and gave it nothing to render but the number. **Hierarchy is a ratio between two NAMED elements, not an adjective** |
| a photoreal phone mockup, again | the word **`app`**. Already in this table; it was improvised in chat rather than taken from the repo files. `--no device, mockup` cannot beat a positive noun |
| food arranged in a tidy evenly-spaced ring | `centred`, and no arrangement language. See `designs/midjourney-dish-photography.md` §3 |
| hyperreal plastic CGI food | `fine detail`, `soft diffused daylight`, and the default `--s` |

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
- **The ~25–35 word rule is for INTERFACE prompts only.** Long UI prompts render dense gibberish
  text; a photograph has no text to render, so descriptive **photo** prompts of 60–90 words are
  correct. Applying the interface rule to photography strips out exactly the material detail that
  makes an image look real.
- **A prompt that only exists in chat will be re-improvised badly.** The `app` failure above had
  been documented for weeks and still recurred, because the prompt that caused it was never in a
  repo file. Put prompts in `designs/`, not in a message.

### Dish photography

The style system for per-recipe food photography — the fixed style block, the realism and
arrangement fixes, per-dish `--no` lists that protect diet tags, and the `--sref` locking procedure
— lives in **`designs/midjourney-dish-photography.md`**. Read it before generating any food image.

---

## Running in parallel, do not disturb

**A 7B QLoRA fine-tune is training on Ana's desktop.** Kicked off 2026-08-05 on
Qwen2.5-7B-Instruct, 4-bit, 3,272 engine-validated examples, 409 steps at ~20 min/step, ETA around
Aug 11. See STATUS.md and WORKPLAN's "ASSISTANT v2" section.

Ana's instruction this session: *"the training is still going on another device. Don't think about
it."* WORKPLAN rule 7 also says the GPU run is never interrupted by other work. It is on a different
machine, so laptop work cannot disturb it — but do not propose anything that would.

## Stray artefact worth a decision

**`public/week-designs.html` is served publicly and documented nowhere.** It sits at
`ntrux.vercel.app/week-designs.html`: an old violet-era exploration of four week layouts
(Timetable / Refined columns / Today agenda / Dashboard) built on **invented** data — hardcoded
dish names, with "Grilled salmon with steamed broccoli" listed as a *breakfast*. In a product whose
entire claim is that its numbers are real, a public page of fabricated ones is a liability. Either
document it in `designs/README.md` or delete it.

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
npm run test:engine       # 449/0 at last run. Budget ~25 min at 501 recipes on the laptop, not the ~10 the docs used to claim; fuzz is the slow part
npm run export:recipes    # writes NutriFlow-recipes.xls — the Gaps sheet drove the expansion
npx tsc --noEmit
npm run build             # NOT while `npm run dev` is running — it corrupts .next
```

Screenshotting the live app for `--sref` (and for checking a design change without a browser):

```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --no-sandbox `
  --hide-scrollbars --screenshot="$PWD\designs\screens\sage-home.png" `
  --window-size=1600,1100 --virtual-time-budget=8000 "https://ntrux.vercel.app/sage"
```

Two things learned using it this session:

- **It will not lay out below ~500 px** on Windows, whatever `--window-size` says — see the
  environment quirk above. Sub-500 layouts cannot be checked this way.
- In `npm run dev`, the FIRST request for an optimised image can lose the race with the screenshot
  and the page captures with a blank photo slot. Warm it (`curl` the page once) before shooting.

Building contact sheets, which is what makes reviewing a set of images affordable — `sharp` ships
with Next, so no install is needed:

```js
// N images into one labelled grid; the whole sheet costs about what one image costs to read.
const sharp = require("sharp");
const buf = await sharp(file).resize(430, 300, { fit: "cover" }).toBuffer();
await sharp({ create: { width: 430 * cols, height: 300 * rows, channels: 3, background: "#fff" } })
  .composite(cells).jpeg({ quality: 90 }).toFile(out);
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

1. **Ana looks at `/sage` and says whether it is the reference.** That is the only question that
   matters right now; everything below is smaller.
2. **Recapture `designs/screens/*.png`.** They are headless-Chrome shots of the OLD design and are
   what Midjourney's `--sref` reads, so every future generation is currently anchored to a design
   that no longer exists. Command is in the verification section below.
3. **Photography is the binding constraint on the design now, not the layout.** Four dishes are
   photographed and 496 are typographic tiles; the composition is built for pictures. The eleven
   spare frames in `designs/references/food/` are alternates of the same four dishes, so coverage
   only grows by generating new ones — `designs/midjourney-dish-photography.md` §7 lists eleven
   library recipes with prompts ready.
4. **Build `npm run check:images`** (spec in the Photography section above). It would have caught
   the class of bug the page now guards against by hand: Home and Explore count photographed
   recipes by resolving each map key against `RECIPES`, not by taking `Object.keys().length`,
   because a stale key would otherwise inflate a claim while rendering nothing.
5. **Wire Plan and Assistant** to be interactive, matching Explore and Groceries.
6. Sub-500px layouts are **unverified** — headless Chrome on Windows will not render narrower (see
   the environment quirk above). Check a real phone or a browser devtools viewport.

## Standing rules

From CLAUDE.md and WORKPLAN, and they held all session:

- **No emoji in the UI.** SVG line icons only.
- **Never add an AI git co-author.** Commits are the owner's alone.
- **Never push red.** `npm run test:engine` must be green; it was 449/0 at last run.
- **The LLM decides what; deterministic code guarantees it is correct.** The model does no
  arithmetic, ever.
- **Honesty over silence** — if the engine adjusts something, the interface says so.
