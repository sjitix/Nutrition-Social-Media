# Dish photography — the style system

How every recipe photograph in the app gets made, so that 500 of them read as **one product**
rather than 500 unrelated pictures. Written after a session of live iteration; every rule below
was bought with a failed generation.

Files live in [`public/food/`](../public/food/) and are mapped to recipes by EXACT name in
`RECIPE_IMAGES` ([`src/lib/recipes.ts`](../src/lib/recipes.ts)). Read that file's header before
adding anything.

---

## 1. The decision behind all of this

The app had 12 stock photos across 500 recipes, matched by keyword regex, so `/chicken/` served
one photograph as **46 different dishes**. They were deleted, and the design went fully
typographic.

That has now been reversed, deliberately, and the reasoning matters:

- **A discovery feed of 500 dishes needs pictures.** Explore is where people decide what to cook.
  Text-only cards are worse there, whatever the craft.
- The old failure was **not** "too few photos". It was **a photo standing in for a dish it wasn't**.
  An exact per-dish map cannot do that; a regex list can.
- **Generated images are the floor, not the ceiling.** When user uploads land (roadmap Phase 4),
  a real photo of the dish someone actually cooked *replaces* the generated one. Authenticity is
  the upgrade, not the problem.
- **Uniformity comes from the frame, not the photograph.** Fixed crop, fixed radius, fixed type
  position, and a subtle wash — that is what will absorb wildly different user photos later. It is
  how Instagram looks coherent while containing everything.

### Honesty rules (non-negotiable)

1. **An image appears only on the dish it depicts. Never as a stand-in.**
2. **Look at every image before mapping it**, and check it against the recipe's `dietTags`. A
   `vegan` card showing cheese, or a `gluten_free` dish with bread in frame, is the failure this
   whole system exists to prevent.
3. **The photo carries identity; the numbers carry quantity.** Portions are scaled 0.6–1.8× per
   user, so no single photo can be accurate to grams — and it does not need to be. The macros
   beside it are exact and already scaled. Shoot a neutral single serving; never "generous".

---

## 2. The style block

Consistency comes from a **fixed block** with only the dish swapped. Fixed angle, fixed vessel,
fixed surface, fixed light. Those four are what make image #400 match image #1.

```
raw photograph, overhead food photography, one single serving of DISH, tipped casually onto a plain off-white speckled ceramic plate, pieces overlapping and clumped unevenly, food gathered to one side with bare plate showing on the other, one piece resting against the rim, plate slightly off centre and cropped by the frame edge, soft sage green linen surface with visible weave, natural window light from the upper left with a soft directional shadow, shallow depth of field with the plate edges falling soft, shot on a 50mm lens at f/2.8, subtle film grain, documentary food photography, natural and unstyled, muted green and cream tones --ar 16:10 --style raw --s 50 --no evenly spaced, arranged in a ring, symmetrical plating, neatly arranged, fanned out, styled, garnished, 3d render, cgi, illustration, digital art, plastic, artificial, glossy, fork, knife, spoon, cutlery, chopsticks, napkin, hands, people, faces, text, words, logo, cluttered props, busy background, oversaturated, neon
```

**Two vessels, one rule:** plated proteins on a **plate**, mixed grain dishes in a **wide shallow
bowl** — same speckled off-white ceramic either way. Swap the noun; change nothing else.

**Aspect ratios must match the real slots**, or you regenerate everything later:

| slot | ratio |
|---|---|
| Explore / featured cards | `--ar 16:10` |
| large featured card | `--ar 5:4` |
| hero | `--ar 4:5` (add `generous empty space` — type sits over it) |

---

## 3. The two fixes that took the longest

### Realism — it looked like CGI

Symptoms: every lentil identically shaped and spaced, salmon with no fat striations, everything
equally sharp, no spills, background a flat fill with no material.

| lever | why |
|---|---|
| `raw photograph` + `shot on a 50mm lens at f/2.8` + `subtle film grain` | tells it *photograph*, not *render*. The single biggest lever |
| `--s 50` (default is ~100) | cuts Midjourney's aesthetic embellishment, which smooths everything into plastic |
| `shallow depth of field, plate edges falling soft` | zero focus falloff is the strongest CGI tell |
| `natural window light from the upper left with a soft directional shadow` | replaces `soft diffused daylight`, which produced shadowless CGI lighting |
| `linen surface with visible weave` | gives the background a **material**. A flat colour reads as a render |
| removed `fine detail` | pushes toward hyperreal CGI crispness, not photographic texture |
| `--no 3d render, cgi, plastic, artificial, glossy` | closes it from the other end |

### Arrangement — "so perfectly placed, that's what makes it look AI"

The sharper diagnosis, and it is about **composition**, not render quality. Cubes and florets came
out in a neat evenly-spaced ring, none touching, every piece face-up. A plating diagram, not a
plate of food.

| lever | why |
|---|---|
| `tipped casually onto` | gives a **physical cause** for the arrangement. Far stronger than "uneven" — it implies gravity did the placing |
| `food gathered to one side with bare plate showing on the other` | AI fills plates evenly; real plates have an empty patch |
| `one piece resting against the rim` | forces at least one thing out of the tidy centre |
| `--no evenly spaced, arranged in a ring, symmetrical plating` | **names the exact failure.** Generic words like "natural" do not reach it |

### Difficulty rule — how hard this fight is, by dish

Observed: the miso cod came out convincing immediately; the chicken-and-sweet-potato plate fought
hard. The variable is how separable the components are.

- **Easy** — soups, stews, dahl, saucy bowls, anything leafy. Physically clumps; can't be tidy.
- **Medium** — grain bowls, salads, pasta. Some structure, but tangles.
- **Hard** — roasted vegetable + protein plates, tacos, anything with cubes or florets.

Use the full arrangement language on the hard ones; you can drop half of it on the easy ones.

---

## 4. Per-dish `--no` additions

Midjourney adds conventional garnish that **breaks diet tags**. Always block the dish's clichés:

| dish type | block | breaks |
|---|---|---|
| any white fish (cod) | `salmon, pink fish` | wrong species entirely |
| dahl / curry | `yogurt, cream, naan, bread` | `vegan`, `gluten_free` |
| shawarma / kebab | `pita, flatbread, naan, wrap` | `gluten_free` |
| chilli | `cheese, sour cream, tortilla chips, cornbread` | not in the recipe |
| soup | `bread, croutons, toast` | `gluten_free` |
| poke | `seaweed, avocado` | not in the recipe |
| vegetarian anything | `meat, chicken, bacon` | `vegetarian` |
| tacos | `flour tortilla, wheat` | `gluten_free` |
| "sheet-pan" in the name | `baking tray, sheet pan` | pulls a metal tray in, breaks the ceramic system |
| keto dishes | `rice, potatoes, bread` | Midjourney adds a starch to any plated protein |

---

## 5. Locking the style (do this before generating at volume)

Style drifts run to run. Image #400 must sit beside image #1 without looking like a different app,
and **this cannot be fixed retroactively**.

1. Generate until one image is right.
2. Commit it to `designs/screens/`.
3. Put its `raw.githubusercontent.com` URL as `--sref` on every subsequent dish prompt at
   `--sw 60–80`.
4. **Write the URL and the `--sw` value into this file**, below.

```
ANCHOR: not yet locked.
--sref <url>   --sw <value>
```

Parameters must follow the prompt text, and `--no` goes **last** — it swallows the
comma-separated list after it.

---

## 6. Cost, honestly

- Generation is not the expensive part; **reviewing is**. 500 dishes means 500 human looks to
  confirm the food is right. Days of work, not minutes.
- A metered plan is the wrong tool for volume — check whether yours has **relax mode** before
  committing to full coverage.
- Do not batch-generate until the **layout is locked**. The aspect ratio is baked into every
  prompt; changing the design later means regenerating everything.
- At ~250 KB per JPEG, 500 images is ~125 MB of binaries in a **public** repo. Fine at this size,
  but never commit multi-MB PNGs — convert to JPEG at ~1400 px wide first.

---

## 7. Prompts for real library recipes

All macros below are the engine's own derived numbers, not claims. Use the block in §2 and swap
the dish.

| recipe | id | macros | notes |
|---|---|---|---|
| Miso-Glazed Cod with Bok Choy & Rice | `d-miso-cod` | 25 min | **shot, in use.** Brown rice, not white; glazed, not sauced |
| Baked Salmon & Potatoes | `d-baked-salmon` | 683 kcal · P40 · fibre 10 | **shot, in use.** Best all-round fit for high protein + fibre |
| Sheet-Pan Chicken & Veg | `d-american-sheetpan-chicken` | 537 kcal · P47 · fibre 9 | **shot, in use.** Block `baking tray` |
| Poached Salmon & Green Lentil Salad | `l-poached-salmon-lentil` | 488 kcal · P43 · fibre 14 | |
| Lemon Parmesan Chicken & Asparagus | `d-fast-lemon-parm-chicken` | 633 kcal · P55 · fibre 8 | the asparagus dish |
| Harissa Halloumi & Chickpea Tray | `d-fast-halloumi-chickpea-traybake` | 691 kcal · P43 · fibre 20 | **vegetarian**, highest-fibre photogenic dish |
| Turkey Chili | `d-turkey-chili` | 449 kcal · P42 · fibre 16 | top-scoring dinner; warm-palette test |
| Lentil & Parmesan Soup | `l-italian-lentil-parmesan-soup` | 558 kcal · P31 · **fibre 26** | highest fibre in the library |
| Shrimp, Corn & Black Bean Salad | `l-mexican-shrimp-corn-salad` | 509 kcal · P46 · fibre 19 | top-scoring lunch |
| Chilli-Lime Prawn Tacos | `d-fast-prawn-tacos` | 513 kcal · P41 · fibre 16 | breaks the vessel rule — plate, not bowl |
| Garlic Butter Salmon with Asparagus | `d-keto-salmon-asparagus` | 496 kcal · P39 · **fibre 3** | keto — beautiful, but off the high-fibre brief |

### Finding more

**101 of the 494 non-treat recipes** clear `protein ≥30 g, fibre ≥8 g, fat ≥10 g, carbs ≥20 g` —
the "balanced" profile. Only **7 are breakfasts**, against 37 lunches and 57 dinners. That
breakfast gap is a library gap, not a photography one, and is worth fixing.

To re-run that query, write a throwaway script importing `RECIPES` from `@/lib/recipeDb` and bundle
it the way `package.json` does:

```bash
npx esbuild scripts/_tmp.mts --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json --outfile=node_modules/.cache/_tmp.mjs --log-level=error \
  && node node_modules/.cache/_tmp.mjs
```

Delete it afterwards — do not leave scratch scripts in `scripts/`.

---

## 8. Prompt failures worth not repeating

Beyond the ones already in CONTEXT.md's Midjourney table:

| what came back | cause |
|---|---|
| beautiful posters of a single huge number, no interface | `one enormous number` + `vast empty space` + `award winning minimal` with **no interface content named**. The prompt described a composition and named nothing to render but the number |
| a photoreal phone mockup | the word **`app`**. Already documented; `--no device, mockup` cannot beat a positive noun |
| food arranged in a tidy ring | `centred`, plus no arrangement language. See §3 |
| hyperreal plastic CGI | `fine detail`, `soft diffused daylight`, default `--s` |

**Prompt length:** CONTEXT.md's "~25–35 words" rule is real but applies to **interface** prompts —
long UI prompts render dense gibberish text. A photograph has no text to render, so descriptive
photo prompts of 60–90 words are correct. Do not apply the wrong rule.
