# References

The images the design is being made **against** — inspiration boards and the food photography
source set. Recovered from `Desktop\design\` and committed so they can never be lost again.

## Why this folder exists

Reference images pasted into a chat live only in that chat. A previous session lost a set that way,
and separately **a conversation has a finite image budget** — once spent, no further image can be
read at any size. Both have now happened on this project (see WORKPLAN lessons 16 and 17).

Saving them here does **not** make them free to look at — reading from disk costs the same budget as
pasting. What it buys is that they are never lost, any future session can open them on demand, and
nobody re-pastes the same board twice.

---

## `boards/` — 36 design boards

### ▶ `sage-01` … `sage-12` — BUILT, and live at `/sage`

**These twelve are the design.** They are the whole of what was `Desktop\design\sage\` — three
Midjourney jobs (`1251bd65`, `3adc4902`, `69eaf47f`) plus one saved favourite (`sage-01`, the only
`.jpg` in the source). Editorial sage: serif masthead, deep forest panels, layered unequal cards,
food photography as large integrated blocks, bowls cropped by the frame edge.

They split three ways, which matters when reading them: **02–09** are editorial homepage
compositions, **10–12** are the application (forest sidebar, cream page, seven ragged day columns),
and **`sage-01` is not a design at all** — it is a screenshot of Midjourney's own UI, which is
useful because the prompt is legible in it. `sage-07` shows the two halves combined, a sidebar with
an editorial page beside it, which is how `/sage` is built.

**A per-board written description is in `CONTEXT.md`.** Read that first — it is free, and it will
usually tell you which one or two you actually need to open.

Reproducible via prompt #10 in [`../midjourney-sage-refine.md`](../midjourney-sage-refine.md) — the
`--sref` one at `--sw 60`.

**Read the "reproduce, don't adapt" section of `../../DESIGN-PROMPT.md` before building from these.**
An earlier attempt applied their surface qualities to the existing layout and was rejected; the
composition is the thing to copy, not the palette (WORKPLAN lesson 15).

### `board-13` … `board-36` — earlier rounds, kept as record

From `Desktop\design\` top level. Mostly earlier homepage explorations, including rejected ones.
Useful for seeing what was tried; not the target.

## `food/` — 15 dish photographs

The generated food set. Filenames carry the **source folder name**, which is where they came
from — but see the warning below.

| prefix | what the folder claimed |
|---|---|
| `chickenandveg-01…08` | chicken & veg |
| `codmisobokchoi-09…11` | miso cod & bok choy |
| `recipes-12…15` | shakshuka |

> ⚠️ **The source folder names are wrong.** The *salmon* photograph — salmon, baby potatoes,
> broccoli, lemon — was sitting inside `chicken andveg\`. A folder name is not evidence of what is
> in a picture (WORKPLAN lesson 18). Verify by looking before mapping any of these to a recipe.

**All fifteen have now been looked at, and they are alternate frames of only FOUR dishes:**

| files | dish | mapped recipe |
|---|---|---|
| `chickenandveg-01…05` | chicken breast, roast sweet potato, charred broccoli | Sheet-Pan Chicken & Veg |
| `chickenandveg-06…08` | salmon fillet, baby potatoes, broccoli, lemon | Baked Salmon & Potatoes |
| `codmisobokchoi-09…11` | glazed white fish, bok choy, brown rice | Miso-Glazed Cod with Bok Choy & Rice |
| `recipes-12…15` | eggs poached in tomato and pepper, feta | Shakshuka |

Four are shipped as product assets in [`../../public/food/`](../../public/food/), mapped by exact
recipe name in `RECIPE_IMAGES`; the other eleven are alternate frames of those same four dishes, so
a future session can pick a different frame without regenerating — but **there is nothing else here
to map.** Coverage past four means generating new dishes.

`sheetpan-chicken.jpg`, the one that shipped without ever being looked at, **has now been
verified**: it is chicken.

## `manifest.csv`

`New,Original` — maps every file here back to its original path under `Desktop\design\`, so
provenance survives the rename.

---

## Housekeeping

- All files converted to **JPEG at ≤1600 px, quality 85**. The originals were ~78 MB of PNG; this
  set is ~10 MB. **Never commit multi-MB PNGs** — this repo is public and git keeps every version
  forever.
- Adding more: date-prefix new batches (`2026-08-10-…`) so rounds group and nothing is silently
  overwritten.

## Budget hygiene when reviewing these

- Downscale to **~900–1200 px** before reading; large images are rejected outright in multi-image
  requests.
- Read **1–3 at a time**, not eight.
- To check many dishes at once, tile a **contact sheet** — 12 cells in one 1500×1000 image costs
  roughly what one full-size image costs.
- Do image-heavy review in a **fresh conversation**, after reading the docs. Text is free.
