# NutriFlow — design brief / AI prompt

Paste the block below into **v0.dev**, **Google Stitch**, **Lovable**, **bolt.new**, Figma AI, or
ChatGPT/Claude. It is written to be self-contained: whatever tool reads it gets the product, the
audience, the constraints and the anti-patterns without needing this repo.

**How to use it**
- **v0.dev** (best fit — outputs React + Tailwind, which is what this app is built in): paste the
  whole block, then add one line naming the screen, e.g. *"Build the WEEK BOARD screen, Direction A."*
- **Stitch / Uizard**: paste it, then ask for one screen at a time.
- Ask for **one screen in one direction per generation.** Tools degrade badly when asked for
  everything at once.
- Iterate by *subtraction* — "remove the icons, make the numbers twice the size" beats a re-roll.

---

## THE PROMPT (copy from here)

You are designing **NutriFlow**, a mobile-first web app (Next.js + Tailwind CSS v4). Design the UI
described below. Output clean, responsive React + Tailwind components. No placeholder imagery.

### What the product is

An AI meal planner becoming a social platform. A user shares a recipe video from TikTok or
Instagram, the AI extracts the recipe into their weekly meal plan, and a grocery list builds
itself. The user then edits the week by talking to it in plain language — "make Tuesday
vegetarian", "I want pancakes this week" — and the app **re-solves the whole plan** so their
calorie, protein, carb, fat and fibre targets still hold.

The positioning: **it replaces a nutritionist.** Ask for pancakes and it doesn't refuse — it finds
a protein-forward pancake and rebalances the rest of the day so nothing slips. Every number shown
is computed from real USDA food data, never estimated. Honesty is the product's core value: if it
adjusts something it says so.

### Who it is for

Young, mobile-first, health-conscious people who save recipe videos and never cook them. They are
comparison-shopping against Instagram and TikTok, not against other diet apps. **The app must look
like something they would screenshot and send to a friend** — virality is an explicit design goal,
not an afterthought.

### THE CENTRAL CONSTRAINT — read this twice

**There is no food photography, and there will not be. Do not design around images.**

The library holds **292 recipes**. Nobody can photograph 292 dishes, and stock photos meant one
image standing in for 46 different recipes — the same chicken photo scrolling past again and again,
showing food that wasn't the recipe. That reads as a template and it is quietly dishonest.

So: **no photos, no illustrations of food, no emoji, no icon-as-mascot.** The visual system must
carry a recipe card on **typography, colour, number and layout alone.** Treat this as the creative
brief, not a limitation — this is the same discipline Revolut uses, and it is what will make the
app look designed rather than assembled.

Real photography returns later, from users and creators, per recipe. Leave space for it; depend on
none of it.

### Reference points

- **Revolut** — for confidence with numbers. Deep surfaces, huge legible figures, tight card
  geometry, restraint. A screen full of data that feels premium rather than busy.
- **TikTok / Instagram** — for feed rhythm and shareability, *not* for their look.

### Screens to design

1. **Week board** — the core screen. 7 days × 3–4 meals. Each meal shows a dish name, calories,
   protein and cook time. Each day shows its running total against a target. Must work as a
   vertical stack on mobile and a timetable/grid on desktop. This is the hardest information-design
   problem in the app and the most likely thing to be screenshotted.
2. **Explore feed** — a browsable wall of all 292 recipes with filters (meal type, diet,
   high-protein ≥25 g, ≤20 min) and an "Add to plan" action on every card.
3. **Landing page** — first impression. The hook is *"share a reel → it becomes your meal plan."*
4. **Onboarding** — a few questions (goal, diet, allergies, targets). Time-to-first-plan must feel
   like seconds. No signup wall before the user sees the magic.

Also present throughout: a **chat assistant** the user talks to to change the plan, and a
**grocery list** grouped by supermarket aisle with check-offs.

### Existing brand tokens (keep these unless a direction argues otherwise)

```
--color-vio:       #675ce0   /* primary accent (violet) */
--color-vio-deep:  #5044c9   /* hover / accent text */
--color-lav:       #efecfb   /* accent tint surface */
--color-plum:      #372f55   /* deep brand ink */
--color-plum-deep: #2d2650
--color-mut:       #605a84   /* muted text — WCAG AA at 5.7:1 */
--color-mint:      #2e9e6e   /* positive / on-target */
--color-mint-soft: #e2f3ea
--color-line:      #edeaf8   /* hairline borders */
--color-bgsoft:    #f3f1fb   /* app background */
```

### Hard requirements

- **Mobile-first.** Phone is the primary device; scale up to desktop.
- **Accessibility is non-negotiable** — WCAG AA contrast (4.5:1 body text), ≥44 px touch targets,
  visible keyboard focus, real semantics. The app already meets this and must not regress.
- **Light and dark themes**, both designed deliberately. Don't invert one to get the other.
- **`tabular-nums` on every macro figure** so numbers align in columns.
- **No emoji anywhere in the UI.** SVG line icons only. Emoji-as-icon reads as AI-generated.
- Numbers are the hero content. Calories, protein and fibre should be scannable at a glance
  without reading labels.

### Do NOT produce

These are the current default "AI-designed app" tells, and any of them makes the work look
generated:

- A purple-to-blue gradient hero on white
- Warm cream (#F4F1EA) + serif display + terracotta accent
- Near-black with a single acid-green or vermilion pop
- Inter or Space Grotesk chosen by default
- Emoji as section markers or icons
- Everything centred; `rounded-lg` on every surface
- A coloured accent bar down the left of every card
- Generic stock food imagery of any kind

### The direction to design in

> Pick ONE per generation and name it explicitly.

**Direction A — Instrument.** Dark, dense, precise; Revolut's confidence applied to nutrition.
Near-black grounds with a slight violet bias, macro figures set large in a tabular face, meals as
tight modular cells, colour used only to encode state (on target / over / short). The week reads
like a control surface you trust.

**Direction B — Editorial.** Calm and premium, like a high-end food publication. Generous
whitespace, a strong display face at large sizes, restrained colour, hairline rules. Dishes are
named like articles; macros sit quietly as metadata. Reads healthy and considered rather than techy.

**Direction C — Chromatic.** Each dish gets a deterministic colour identity derived from its
cuisine and main protein, so the feed becomes a mosaic that is recognisably *yours*. Turns the
absence of photography into the signature. Bold, saturated, high-contrast, extremely screenshotable.

### Deliverable

Responsive React + Tailwind. Real content — use plausible dish names with real-looking macros
(e.g. *Tempeh & Quinoa Protein Bowl · 612 kcal · 41 g protein · 25 min*). Never lorem ipsum.

## (copy to here)

---

## Notes for Ana

- **Don't buy Midjourney for this.** It makes pictures, not interfaces — it cannot give you a
  layout, a type scale or a component system. If you ever want imagery, free options are Unsplash,
  Pexels and Foodiesfeed for stock, or Google AI Studio, Leonardo, Ideogram and Bing Image Creator
  for AI.
- **The one subscription worth considering is Mobbin** (~$15/mo, free tier available) — a
  searchable library of real screens and full flows from real apps, Revolut included. Studying the
  real thing beats prompting for an imitation of it.
- Generate **one screen in one direction at a time**, then iterate by subtraction.
