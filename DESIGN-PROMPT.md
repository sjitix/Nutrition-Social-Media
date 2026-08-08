You are designing **NutriFlow**, a web app built in Next.js 15 + Tailwind CSS v4.
Design the **desktop** screens first (1440px); phone comes afterwards.

Explore **several distinct visual directions** — different palettes, typography and layout systems.
Do not settle on one look. Present each direction as a complete, finished screen rather than a
sketch, and make each one genuinely different from the others, not a recolour of the same layout.

## The quality bar

This has to look like the apps people screenshot and send to each other — **Revolut, TikTok,
Linear, Arc, Cash App**. Confident, current, unmistakably designed. Not a template, not an
admin panel, not a Bootstrap dashboard with rounded corners.

Revolut is the closest reference for how it should *feel*: enormous confident numbers, tight
geometry, deep restraint everywhere except one place, and an interface that makes financial data
feel premium rather than clerical. Do that for food.

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

## Constraint 1 — no imagery. None.

**No photographs. No illustrations. No icons standing in for food. No generated colour blocks
pretending to be pictures. No emoji anywhere, ever.**

Why: there are 500 recipes. Nobody can photograph 500 dishes. When this app had 12 stock photos,
keyword rules meant one image was shown for 46 different recipes — the same chicken photo scrolling
past over and over, of food that wasn't the recipe on the card. That reads as a template, and it is
quietly dishonest in a product whose entire claim is that its numbers are real.

The visual system must therefore carry a recipe on **typography, colour, hierarchy, space and
number alone.** Treat that as the creative brief, not a limitation — it is exactly the discipline
Revolut and Linear work under.

(Real photography returns much later, from users and creators, per recipe. Leave room for it.
Depend on none of it.)

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
