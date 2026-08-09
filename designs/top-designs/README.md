# Top designs

The shortlist. At most three at a time — anything that stops earning its place gets moved back up
to [`../`](../) or deleted, so this folder always answers "what are we actually choosing between".

Nothing here is wired into the app; `src/` does not import from this folder.

---

## 1. `sage-typographic.html`

Sage editorial ground, typographic hero, no photography anywhere.

Grew out of a Midjourney generation and was built out with the real 500-recipe library —
the dishes, calories, protein and the seven-day totals are the engine's own numbers.

**Why it holds up**

- The sage ground (`#dfe6da`) reads calm and expensive without a single image, and it is nothing
  like the white-and-violet dashboard every competitor ships.
- The hero states a real dish with real macros, so the biggest thing on the page is the product
  doing its job rather than a stock photo of food.
- Colour is doing work, not decoration: deep forest for actions, and lime used exactly once —
  Saturday's protein bar, because Saturday is genuinely 16 g short.
- The honest line sits in the interface, not in a log: *"Saturday is 16 g short on protein. The
  assistant can lift it without moving your calories."*

**Photo-ready.** Every image area is a `<div class="slot">` holding a typographic fallback. When
real photography exists, replace the slot's inner `.typo` with an `<img>` and change nothing else —
sizing, radius and overflow already live on `.slot`. Search the file for `SLOT:` to find them.

That is the plan for imagery: **hero moments only**, perhaps 8–12 photographs, not one per recipe.
500 dishes cannot be photographed, and the last attempt at partial coverage meant one image standing
in for 46 different recipes.

**Rejected while building this:** a "defocused" hero — blurred organic shapes in ingredient tones,
meant to read as shallow depth of field. It looked like an unfinished image rather than a deliberate
one. Typographic won.

---

## 1b. `sage-app.html`

The whole product in one file: **Home**, **Plan**, **Explore**, **Groceries**, **Assistant**. Start
here — this is the complete system. `sage-typographic.html` is the same homepage on its own, kept
because it is the cleanest single artefact to show someone.

- **Home** — the hero with a real dish and its macros, four recipe cards, and the week strip.
- **Plan** — four summary cards over a seven-day timetable. All 21 meals visible at once, per-day
  totals with a protein bar, and Saturday in lime because it is genuinely 16 g short.
- **Explore** — filters and a four-up card grid over the 500-recipe library.
- **Groceries** — grouped by aisle so you walk the shop once. The check-offs work: tick an item and
  the sticky total updates. Keyboard operable.
- **Assistant** — every reply itemises what actually moved, including the honest ceiling: *"7 g
  under, the best any vegetarian combination reaches today."*

Photo-ready on the same terms as the homepage — image areas are `.slot`, marked `SLOT:`.

---

## 2. *open*

## 3. *open*
