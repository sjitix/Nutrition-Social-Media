# Dish photography

Per-recipe photographs, served from `/food/<file>`.

## The rule that makes this safe

> **An image lives here only if it depicts the dish it is mapped to. Never as a stand-in.**

The mapping is an EXACT recipe-name lookup in [`src/lib/recipes.ts`](../../src/lib/recipes.ts)
(`RECIPE_IMAGES`), not a keyword rule. That distinction is the whole point: the previous set of
photos was matched by regex, so `/chicken/` served one photograph as 46 different recipes and
`bowl1.jpg` stood in for 31 more. Scrolling showed the same picture over and over, of food that
was not the recipe on the card, and the photos were deleted for it.

A recipe with no entry returns `null` and falls back to a typographic tile. Partial coverage is
therefore honest — photographed dishes show themselves, everything else shows type. It is
impossible for a rule here to accidentally widen.

## When the photograph comes first

`chicken-egg-poke` happened the other way round: the picture was generated, and there was no dish
in the library it depicted. The only poke bowls were salmon and tofu, and mapping a photograph of
chicken and egg to either of them is precisely the stand-in failure this whole mechanism exists to
prevent.

**So the recipe was added first, and the photograph mapped to it second.** That is the order, always.
`l-chicken-egg-poke` lists all twelve components the picture shows, every one already curated to an
FDC id — no ingredient was auto-matched to USDA, which is unsafe.

Two things this turned up that will recur:

- **`maxIngredients` can silently exclude your best photograph.** The selector keeps recipes with
  `ingredients.length <= maxIngredients + 1`, and a loaded bowl is a twelve-ingredient dish. The
  design fixture in `src/app/sage/demo.ts` was set to 8, so the one dish with a cut-out could never
  be chosen for the screen composed around it. Raised to 12.
- **Shoot cut-out candidates square-ish.** `--ar 16:10` gives Midjourney room to clip the bowl top
  and bottom, and a bowl clipped by its own frame cannot be masked whole. `--ar 4:5` or `1:1` keeps
  it intact. This frame also came out slightly oval, which is why the masking script grew an
  ellipse option.

## Before adding an image

1. **Look at it.** Does it show this recipe's actual ingredients?
2. **Check it against the recipe's `dietTags`.** A `vegan` dish showing cheese, or a `gluten_free`
   dish with bread in frame, is the failure this guards against. Midjourney does both readily —
   it defaults fish to salmon, adds yoghurt to dahl, and puts pita next to shawarma.
3. Add one line to `RECIPE_IMAGES`, keyed on the recipe's exact `name`.

## Current files

All four have been looked at and checked against the recipe's ingredient list and `dietTags`.

| file | recipe | id | what is in frame |
|---|---|---|---|
| `miso-cod.jpg` | Miso-Glazed Cod with Bok Choy & Rice | `d-miso-cod` | white fish under a dark miso glaze, sesame, bok choy, brown rice. **Not salmon** |
| `baked-salmon.jpg` | Baked Salmon & Potatoes | `d-baked-salmon` | pink flaking fillet, baby potatoes, broccoli, lemon |
| `sheetpan-chicken.jpg` | Sheet-Pan Chicken & Veg | `d-american-sheetpan-chicken` | chicken breast, roast sweet potato, charred broccoli, paprika |
| `shakshuka.jpg` | Shakshuka | `b-shakshuka` | two eggs poached in tomato and pepper, feta, herbs. No bread in frame, so `gluten_free` holds |
| `chicken-egg-poke.jpg` + `chicken-egg-poke-plate.webp` | Chicken & Egg Poke Bowl | `l-chicken-egg-poke` | grilled chicken, two soft-boiled egg halves, brown rice, edamame, cucumber, carrot, red cabbage, sprouts, avocado, sweetcorn, cherry tomatoes, sesame. **The recipe was written for this photograph**, not the other way round — see below |

`sheetpan-chicken.jpg` was the one CONTEXT.md recorded as never visually verified — chosen by
job-ID grouping after a conversation's image budget ran out. It has now been looked at: it is
chicken. The alternates for all four are in `designs/references/food/`, whose folder names are
wrong (the salmon photograph was filed under `chickenandveg`), which is exactly why the check is
"look at it", not "read the filename".

## Cut-outs

`miso-cod-plate.webp` is the same photograph as `miso-cod.jpg` with its background removed, so the
plate is an **object** that can sit on the page and be cropped by the frame — the `sage-06` move.
A rectangle cannot do that; the rectangle is what reads as "a photo in a slot".

They are a separate map (`RECIPE_CUTOUTS`), with the same exact-name rule, rather than a filename
convention like `name + "-plate"` — a convention is a rule that can widen by accident, which is
what the exact map exists to prevent.

```bash
node scripts/make-plate-cutout.mjs <source.jpg> <out.webp> <preview.jpg>
```

**The source frame decides whether a good cut-out is possible at all — the script cannot rescue a
bad one.** Two properties, both set at generation time:

1. **The bowl fully inside the frame, with margin.** Shoot `--ar 1:1`, not `16:10`. A bowl touching
   its own frame edge cannot be masked whole at any radius.
2. **The ceramic rim clear, food only in the well.** This is the one that is easy to miss, because
   it is about the food rather than the framing. A masked plate reads as a plate because you can
   see the ring of ceramic around the food; fill the bowl rim to rim and the mask ends where the
   food ends, and it looks like a circular crop no matter how exact the mask is.

Both are in the cut-out prompt in `designs/midjourney-dish-photography.md` §7. When the source is
right, the automatic fit finds the bowl with no hand-tuning — needing to pass `cx cy rx ry` by hand
is usually the signal that the frame is wrong, not that the numbers are.

**Check the cut-out on MAGENTA, not on the page colour.** Composited on cream, both failure modes
are invisible: leftover background is cream-ish, and food sliced at the mask edge just looks like
the edge. Against a colour that appears nowhere in the photograph, both are obvious at a glance.
Two rounds of "fixed it" went out because the check was made against cream.

It fits a **circle** to the plate rather than segmenting the background. Segmenting was tried
first and fails on exactly this dish: a flood fill from the edges leaks through the bok choy where
a leaf bridges the rim, and eats a bite-shaped hole out of the food. The plate is a circle shot
from overhead, so fitting one is both simpler and exact. Feed it the **original** frame from
`designs/references/food/`, not the cropped card asset — the crop cuts the plate at three edges.

Always look at the preview it writes: it is the cut-out composited on the page colour, which is
the only way to see a green fringe or a background ring.

## Format

Landscape, roughly 3:2 or wider — the cards crop to `16/9`, `5/4` and `4/5` depending on slot, so
keep the dish away from the extreme edges. Around 1400 px wide is plenty; `next/image` handles the
rest. `.jpg` unless a dish genuinely needs transparency.

## Style consistency

Prompts and the locked `--sref` anchor live in
[`designs/midjourney-dish-photography.md`](../../designs/midjourney-dish-photography.md).
Use them — a library of 500 images only reads as one product if every image was generated against
the same fixed style block.
