You are designing **NutriFlow**, a web app built in Next.js 15 + Tailwind CSS v4.
Design the **desktop** screens first (1440px); phone comes afterwards.

Explore **several distinct visual directions** — different palettes, typography and layout systems.
Do not settle on one look. Present each direction as a complete, finished screen rather than a
sketch, and make each one genuinely different from the others, not a recolour of the same layout.

## The quality bar

This has to look like the apps people screenshot and send to each other. Confident, current,
unmistakably designed. Not a template, not an admin panel, not a Bootstrap dashboard with rounded
corners.

Apps worth looking at for the *level* of craft, none of them a model to copy: **Revolut, TikTok,
Linear, Arc, Cash App, Duolingo, Things, Monzo**. Take the standard, not the look.

The qualities to aim for, whatever direction you take: numbers that are confident and enormous
rather than politely sized; tight geometry; deep restraint everywhere except the one place you
choose to be loud; and data that feels premium rather than clerical.

Virality is an explicit design goal. Every screen should answer: *would someone screenshot this?*

## What the product is

An AI meal planner turning into a social platform. You share a recipe video from TikTok or
Instagram; the AI extracts the recipe into your weekly meal plan and the grocery list builds
itself. You then edit the week by talking to it — *"make Tuesday vegetarian"*, *"I want pancakes
this week"* — and the app **re-solves the whole plan** so your calorie, protein, carb, fat and
fibre targets still hold.

The positioning: **it replaces a nutritionist.** Ask for pancakes and it doesn't refuse — it finds
a protein-forward pancake and rebalances the rest of the day so nothing slips. Every number shown
is computed from real USDA food data, never estimated. When it adjusts something it says so, in
the interface: *"bumped your lunch chicken 20 g to hold protein at 150 g."* That honesty is the
product's personality and should be visible in the design, not buried in a log.

## Who it is for

Young, mobile-first, health-conscious people who save recipe videos and never cook them. They are
comparing this against Instagram and TikTok, not against other diet apps.

## Scale of the content

- **500 recipes** in the library
- **21 meals per week** on the plan screen (7 days × 3 meals, sometimes 4)
- Each meal carries: name, calories, protein, carbs, fat, fibre, cook time, cuisine, diet tags

## Constraint 1 — photography, one image per dish (REVERSED — read carefully)

This brief previously said **no imagery, none**. That has been **reversed**, and the reasoning
matters because the old reason was nearly right.

**The design is now photography-led.** A discovery wall of 500 dishes needs pictures — people
browse food with their eyes. The target is a photograph for **every** recipe.

What was actually wrong before was not the *number* of photos, it was that **a photo stood in for a
dish it wasn't**: 12 images matched to 500 recipes by keyword regex, so one chicken photo appeared
on 46 different cards. So the mechanism changed, and the rule is now absolute:

> **An image appears only on the dish it actually depicts. Never as a stand-in.**

`imageForMeal` is an exact recipe-name map. A recipe with no photo falls back to a typographic tile,
so partial coverage is honest rather than misleading. Every image is checked against the recipe's
diet tags before it ships — a `vegan` card showing cheese is the failure this guards.

**Still forbidden:** emoji anywhere, ever. Icons standing in for food. Generated colour blocks
pretending to be pictures.

**The typographic system still has to be good**, because 500 photographs take a long time to make
and most cards will be typographic for a while. Photography is the floor it sits on, not a
substitute for hierarchy.

## Constraint 2 — bright

Light backgrounds. Not a dark dashboard. Warm or cool, tinted or near-white — but the product lives
in the light.

## Constraint 3 — it must not look evenly weighted

Read this twice; it is the requirement most often failed.

A layout where everything sits at the same visual weight — four equal stat cards in a row, a grid
of equal cards, a sidebar next to a table — is competent and completely forgettable.

**Good screen design has one strong organising idea and dramatic hierarchy: one element enormous,
everything else quiet.** For each screen, decide the single most important thing and make it three
times bigger than seems reasonable. Let everything else recede.

Asymmetry, deliberate negative space and extreme scale contrast are wanted. Even, tidy and balanced
is not.

## Colour — explore, don't inherit

The app currently uses the palette below. **Treat it as a starting reference, not a requirement.**
Actively explore other palettes and propose better ones; at least one direction should abandon this
palette entirely. Choose colour that suits a premium food and health product, not whatever the
codebase happens to have today.

```
--color-vio:       #675ce0   /* current accent (violet), 4.8:1 on white */
--color-vio-deep:  #5044c9   /* hover / accent text */
--color-lav:       #efecfb   /* accent tint surface */
--color-plum:      #372f55   /* deep ink */
--color-mut:       #605a84   /* muted text, 5.7:1 */
--color-mint:      #2e9e6e   /* positive / on target */
--color-mint-soft: #e2f3ea
--color-line:      #edeaf8   /* hairline borders */
--color-bgsoft:    #f3f1fb   /* app background */
```

Whatever palette a direction lands on, it must hold **WCAG AA** — 4.5:1 for body text — and it
needs a clear semantic set for on-target / short / over, kept distinct from the brand accent.

## The screens, in priority order

1. **Week plan (desktop)** — the core screen and the hardest information-design problem: 21 meals,
   each with a name and macros, plus per-day totals against a target, plus which days are off
   target. The most likely thing to be screenshotted, so it has to be beautiful, not merely
   legible. A 7-column timetable is the obvious answer; if there is a better one, take it.
2. **Explore** — browsing 500 recipes with filters (meal type, diet, high-protein ≥25 g, ≤20 min,
   cuisine) and "add to plan" on each.
3. **Assistant** — a conversation that changes the plan. Every reply itemises what actually moved:
   which meal was swapped, which portion was scaled, what the day now totals.
4. **Share a reel** — paste a TikTok or Instagram link and watch it become a real meal with real
   macros. The product's magic moment and its viral hook.
5. **Onboarding** — goal, diet, allergies, targets. Time-to-first-plan should feel like seconds,
   with no signup wall before the user feels the magic.

Also present: a **grocery list** grouped by supermarket aisle with check-offs.

## Hard requirements

- **Desktop first** at 1440px, then scale down.
- **WCAG AA** — 4.5:1 body contrast, ≥44px touch targets, visible keyboard focus, real semantics.
- **`tabular-nums` on every macro figure** so numbers align in columns.
- Numbers are hero content — calories and protein readable at a glance without reading labels.
- Motion is expected: things ease in, numbers count up, state changes animate. Respect
  `prefers-reduced-motion`.

## The chosen direction — editorial sage

A direction has been picked, from a set of Midjourney boards (saved in `designs/references/`).
Five elements define it:

1. **Deep forest green as large solid panels**, not merely as button fills.
2. **A serif editorial display face** against a small sans for data.
3. **Cream as a third surface** alongside the sage ground and white, so cards can recede or advance.
4. **Layered, unequal cards** — varied sizes, overlapping edges, breaking their containers.
5. **Photography as large integrated blocks** through the layout, with bowls **cropped by the frame
   edge** rather than floating politely in the middle.

### Reproduce the boards; do not adapt the existing page toward them

> **Status: done.** The boards are built and live at `/sage` — forest sidebar, cream page,
> photography off the frame edge, seven ragged day columns. This section is kept because the trap
> it describes is general and will apply to the next reference set as much as it did to this one.

This is the instruction most likely to be failed, and it has been failed once already.

An attempt that kept the existing layout and applied surface changes — a serif, a cream token, one
forest panel — was rejected as *"you slightly changed our initial design, you didn't incorporate the
inspiration well."* Correct: surface tokens on an unchanged composition read as the old design with
adjustments.

Reproducing a layout means reproducing its **composition**: panel structure, whether there is a
sidebar, where photography sits and how large, what overlaps what, the density, and the ratio
between the display face and the data type. **Build what the board shows, even when it is unlike
anything currently in the repo.** Starting from the existing component tree is what caused the miss.

## What has already been rejected — do not repeat these

1. **Arbitrary colour blocks per dish** (a hue assigned by cuisine). Colour that encodes nothing is
   decoration, and decoration reads as unfinished — it looked like a wireframe.
2. **Ingredient-derived "dish portraits"** (blobs sized by real gram weights). Cleverer, still
   images. The instruction is no imagery, including generated imagery.
3. **Austere flat layouts** — hairline borders, 9px padding, system fonts at default settings, no
   depth. Looked like unstyled HTML.
4. **The standard SaaS dashboard** — sidebar, top bar, a row of four equal stat cards, a table, a
   card grid. Competent, generic, evenly weighted, forgettable. **The most important one to
   avoid.** Adding shadows and gradients does not fix it; it just makes a generic layout with
   shadows.

Also avoid the current AI-design tells: a purple-to-blue gradient hero on white; warm cream
(#F4F1EA) with a serif display and terracotta accent; near-black with a single acid-green pop;
Inter or Space Grotesk chosen by default; emoji as section markers; everything centred;
`rounded-lg` on every surface; an accent bar down the left of every card; default shadcn/ui styling
straight out of the box.

## Deliverable

Several complete, distinct directions — each a finished desktop screen, each with its own palette,
type system and layout idea. Responsive React + Tailwind, or Figma frames.

Real content throughout: plausible dish names with real macros, e.g. *Tempeh & Quinoa Protein
Bowl · 698 kcal · 47 g protein · 25 min*. Never lorem ipsum, never placeholder rectangles.
