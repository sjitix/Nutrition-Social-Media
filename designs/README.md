# Designs

Design candidates and explorations. **Nothing here is wired into the app** — `src/` does not
import from this folder. It is a reference library: keep what is worth learning from, whether or
not it ends up shipping.

Every file is a **self-contained HTML page** with no external requests — no CDN fonts, no scripts,
no images. Double-click to open it in a browser, or serve the repo and open the file directly.
They stay out of `public/` on purpose so they are not served as part of the product.

The brief these were made against is [`../DESIGN-PROMPT.md`](../DESIGN-PROMPT.md).

---

## `top-designs/`

The shortlist — at most three candidates at a time, with the reasons they are still standing. Start
there; everything else in this folder is either a rejected experiment kept as a record, or raw
material for generating new ones.

---

## `references/`

**The design boards the current direction was chosen from.** Images, not code. A previous session
lost a whole set by leaving them in a chat transcript, and a conversation's image budget is finite —
so anything worth designing against belongs here. See that folder's README for naming and for
budget hygiene when reviewing them.

**`boards/sage-01 … sage-12` are BUILT** — they are the design now live at `/sage`, not a
candidate. A written description of what each of the twelve shows is in `CONTEXT.md`, so a future
session can work from text instead of spending its image budget re-deriving them.

---

## `midjourney-dish-photography.md`

**The style system for per-recipe food photography** — read before generating any food image. The
fixed style block (so 500 images read as one product), the two fixes that took longest (realism:
camera/grain/`--s 50`; arrangement: `tipped casually onto`, `--no evenly spaced, arranged in a
ring`), per-dish `--no` lists that stop Midjourney adding garnish which breaks a recipe's diet tags,
the aspect ratios that match the real card slots, the `--sref` locking procedure, and prompts for
real library recipes with the engine's own macros.

Also records the honesty rules: an image appears only on the dish it depicts, every image is looked
at before it is mapped, and the photo carries identity while the numbers carry quantity.

---

## `signal-asymmetric.html`

**Rebuild of "C — Signal" from a Figma Make exploration.** An asymmetric two-panel week plan:
the selected day fills a wide left panel, the week sits in a narrow right rail.

**Status: liked as a design, rejected for this app.** Kept because the craft is worth studying
even though the layout is not right for NutriFlow.

What it does well, and why it is worth keeping:

- **Extreme scale contrast** — roughly 13:1 between the day's calorie total and the micro labels.
  That single ratio is most of the difference between a designed screen and a dashboard.
- **A ghosted `WED` behind the total** — depth and scale built from type alone. This is a genuine
  answer to the no-photography constraint: texture without an image.
- **Accent used exactly twice** — the over-target day's number and the active row's left bar.
  Everything else is black, grey and white. Restraint is what makes the two reds read as signal.
- **Asymmetric 78/22 split** rather than equal columns, so the eye knows where to start.
- **Honest reporting in the interface** — "AI adjusted Sat lunch: bumped chicken +20g to hold
  protein at 120g" sits in the rail, not in a log. That is the product's personality made visible.
- The data is internally consistent: the seven days sum to the stated week total (11,148 kcal /
  760 g), and the three meals sum to the day's 1,450.

Known gap: the original uses a specific humanist sans. This rebuild is on a tuned system stack
because artifacts cannot load external fonts, so the letterforms differ; weights, tracking and
scale are matched.

## `modern-desktop-study.html`

**A study of app-shell layouts** — sidebar, 7-day timetable, coach rail, Explore and the
assistant, in three light styles (Aurora / Crisp / Canvas). Interactive: switch style and screen
from the controls at the top.

**Status: rejected.** Useful as a record of what *not* to do. Its failure is the one named in the
brief — it is the standard SaaS dashboard, evenly weighted, with nothing leading the eye. Depth,
gradients and motion were added and did not rescue it, which is the point worth remembering:
polish does not fix hierarchy.

---

## `midjourney-prompts.md`

Six ready-to-run Midjourney prompts (five desktop moods plus a phone screen), each self-contained
with the product context and the no-food-imagery constraint built in, and each carrying the
parameters that matter for interface work: `--style raw` to drop Midjourney's default flourish, a
low `--s` so it stays literal, and a `--no` list steering away from what has already been rejected.

Worth knowing before spending credits: Midjourney paints an app rather than designing one. Its text
is decorative gibberish at interface sizes and nothing it produces is measurable, so use it to
decide what the product should FEEL like, then hand the winning image to a designer or to v0.dev
alongside the brief. Also useful: `--sref <image-url>` matches the style of a reference screenshot
without you having to describe it.

---

## `midjourney-week-plan.md`

Prompts for the core screen — seven days, three meals each, recipe names, calories and protein.
Four layouts (seven columns, one-day-large with the week beside it, a timetable grid, and a dark
variant), each written twice: once with recipe thumbnails and once with none. Same layout on both
sides so the only variable is the imagery, which makes the with-or-without question answerable by
looking rather than arguing.

---

## `midjourney-sage-refine.md`

Prompts for improving the shipped sage design rather than replacing it. Eight describe the design
in words; three use `--sref`, which takes a screenshot of the live site
(https://ntrux.vercel.app/sage) and matches its style while following the prompt — the fastest way
to get variations that are recognisably the same product. `--sw` controls how tightly it holds to
the reference: 100 is the default, lower loosens it.

---

## `midjourney-week-layouts.md`

Fourteen structurally different ways to show the same week: columns, timetable, ribbon, vertical
feed, calendar, stacked bars, twenty-one cards, accordion, card deck, today-huge, dense ledger,
radial, and plan-beside-chat. The palette and framing are identical in every one, so the layout is
the only variable — run them together and the comparison is fair. Use when you know the current
layout is not it but not yet what should replace it.

---

## Adding to this folder

Drop in a self-contained `.html` file and add a section above saying what it is, what it does well,
and whether it was accepted or rejected **with the reason**. The reasons are the valuable part —
they are what stops the next attempt walking into the same wall.
