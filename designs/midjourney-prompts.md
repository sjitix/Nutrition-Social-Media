# Midjourney prompts — NutriFlow

## What to expect before you spend credits

Midjourney produces **mood, palette and layout feel**. It does not produce a usable interface:
the text it renders is decorative gibberish at small sizes, nothing is measurable, and you cannot
ask it to move a column 20px. Treat every output as a **painting of an app**, not a spec.

That is still worth having. Use it to answer *what should this feel like* — then hand the winning
image to a designer, or to v0.dev alongside [`../DESIGN-PROMPT.md`](../DESIGN-PROMPT.md), to get
something buildable.

## How to run these

- Paste one prompt into `/imagine`, generate, then **vary** the best result rather than re-rolling
  from scratch.
- `--sref <image-url>` is the most useful parameter here: upload a screenshot of a design you like,
  paste its URL, and Midjourney matches its *style* while following your prompt. This is how you
  say "make it look like this" without describing it.
- Lower `--s` keeps it literal, higher lets it wander. For interface work stay low: `--s 50` to
  `--s 250`.
- `--style raw` removes Midjourney's default artistic flourish. Keep it on for UI.
- Check `/settings` for the current model version and use the latest; `--v 7` below may be behind.

---

## 1 — Editorial minimal

```
minimalist web app interface for a weekly meal planner, one enormous bold number dominating the
composition, tiny uppercase micro-labels with wide letter spacing, thin hairline dividers,
generous negative space, asymmetric two-column layout, warm off-white background, single deep
accent colour used sparingly, swiss typographic design, editorial magazine influence, calm and
premium, flat clean vector product design, no photographs --ar 16:9 --style raw --s 120 --v 7
```

## 2 — Confident data

```
premium fintech-grade dashboard interface for nutrition tracking, huge tightly-tracked numerals as
the hero element, dense modular cells, precise alignment, restrained monochrome palette with one
vivid signal colour marking an exception, deep negative space, high contrast typography, tabular
figures, light background, sophisticated and trustworthy, flat vector UI design --ar 16:9
--style raw --s 100 --v 7
```

## 3 — Warm and human

```
elegant meal planning app interface, soft ivory and bone paper background, large confident
typography, gentle earth-toned accent, generous whitespace, subtle layered depth, rounded soft
geometry, warm and calm and unhurried, high-end wellness brand, clean modern product design,
flat vector, no food photography --ar 16:9 --style raw --s 180 --v 7
```

## 4 — Bold and loud

```
striking modern app interface for a food planner, oversized display typography, dramatic scale
contrast between huge headline numbers and tiny labels, bold saturated accent colour blocks,
confident asymmetric composition, bright white background, poster-like graphic design energy,
screenshot-worthy, contemporary editorial layout, flat vector UI --ar 16:9 --style raw --s 250
--v 7
```

## 5 — Quiet precision

```
understated web application interface, near-white background, precise grid, hairline rules,
small refined typography with one very large focal number, muted neutral palette with a single
restrained accent, layered soft shadows, generous padding, engineered and calm, the visual
language of a serious professional tool, flat clean vector design --ar 16:9 --style raw --s 80
--v 7
```

---

## Variations worth trying

Append to any prompt above:

- `--ar 9:16` — the phone screen instead of desktop
- `--no gradient, glassmorphism, neon, dark mode, photograph, stock food photo` — steer away from
  what has already been rejected
- `--chaos 25` — more varied results per generation when you want to explore rather than refine
- Swap the palette phrase: *"deep forest green and cream"*, *"warm terracotta and sand"*,
  *"cobalt and bone"*, *"charcoal and pale amber"* — the brief asks for directions that abandon the
  current violet, and this is the cheapest way to test one.

## What NOT to ask it for

- The week timetable with 21 real meals. It cannot render that much legible text.
- Anything you intend to use directly. Nothing here ships.
- Food photography. The whole design constraint is that there is none.
