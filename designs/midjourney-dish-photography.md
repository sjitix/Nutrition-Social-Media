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
ANCHOR: not yet locked — but the candidate is chosen and is already committed.
Proposed:  --sref https://raw.githubusercontent.com/sjitix/Nutrition-Social-Media/main/public/food/miso-cod.jpg   --sw 70
```

`miso-cod.jpg` is the right anchor of the four shipped: it is the one that came out convincing on
the first generation (see §3's difficulty rule), it is a wide shallow bowl on the sage linen, and
its light is the exact upper-left window light the block asks for.

**It will 404 until `main` is pushed.** `--sref` fetches over the public internet; a file that
exists only in a local commit is not reachable. Push first, open the URL in a browser to confirm it
serves the image, and only then start generating at volume — a broken `--sref` fails silently by
just ignoring the reference, and you will not notice until image #40 does not match image #1.

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

### Chicken & soft-boiled egg poke bowl

> ⚠️ **This dish is not in the library.** The only poke bowls are `l-salmon-poke` (Salmon Poke Bowl
> with Edamame) and `l-tofu-poke` (Tofu Poke Bowl with Edamame). A photograph of a chicken-and-egg
> bowl **must not** be mapped to either of them — that is a photo standing in for a dish it is not,
> which is the exact failure `RECIPE_IMAGES` exists to make impossible. Either add the recipe
> first, or generate this for a mood board rather than for a card.
>
> It **is** addable: every ingredient below is already priced in `NUTRIENT_TABLE`, which is the
> binding constraint on new recipes (auto-matching to USDA is unsafe — it produced
> `salmon fillet → Salmonberries`). Proposed list, all resolvable today:
>
> chicken breast · eggs · brown rice · **edamame · cucumber · carrot · cabbage · avocado · corn ·
> bean sprouts · cherry tomatoes** · sesame seeds · sesame oil · soy sauce · lime
>
> Nine toppings, which is what a poke bowl actually looks like. What is **not** priced, and so can
> be in neither the recipe nor the frame: spring onion, radish, ginger, rice vinegar, seaweed,
> pickled ginger, wasabi, sriracha, mango. Those are all in the `--no` list below for that reason,
> not because they would taste wrong.

Vessel: a **wide shallow bowl**, because it is a mixed grain dish. Difficulty: **hard** — many
discrete components is the worst case for the arrangement problem in §3.

```
raw photograph, overhead food photography, one single serving of a completely loaded chicken and soft-boiled egg poke bowl, the entire surface covered rim to rim with nine different toppings and hardly any rice visible underneath, packed full, sliced grilled chicken breast, one jammy soft-boiled egg halved, edamame, cucumber, julienned carrot, shredded red cabbage, sliced avocado, sweetcorn, bean sprouts, halved cherry tomatoes, sesame seeds scattered over everything, toppings crowded tightly against each other in loose adjacent drifts that overlap and spill into one another in uneven amounts, brown rice underneath and almost hidden, one egg half resting against the rim, bowl slightly off centre and cropped by the frame edge, plain off-white speckled ceramic wide shallow bowl, soft sage green linen surface with visible weave, natural window light from the upper left with a soft directional shadow, shallow depth of field with the bowl edges falling soft, shot on a 50mm lens at f/2.8, subtle film grain, documentary food photography, natural and unstyled, muted green and cream tones --ar 16:10 --style raw --s 50 --no sparse, half empty, bare rice, empty space in the bowl, few toppings, minimal, plain rice bowl, raw fish, tuna, salmon, sashimi, seaweed, nori, mango, pickled ginger, wasabi, sriracha, mayonnaise, spicy mayo drizzle, spring onion, radish, equal wedges, neatly separated sections, pie chart arrangement, evenly spaced, symmetrical plating, neatly arranged, fanned out, styled, garnished, 3d render, cgi, illustration, digital art, plastic, artificial, glossy, fork, knife, spoon, cutlery, chopsticks, napkin, hands, people, faces, text, words, logo, cluttered props, busy background, oversaturated, neon
```

**What was making it come out sparse, and it was my own wording.** The first version said
*"some rice still showing through between them"* — an instruction to leave gaps, written to fight
tidiness, which the model read as an instruction to under-fill. The standard block's
*"food gathered to one side with bare plate showing on the other"* does the same thing and is
already removed for this dish. Fullness has to be **stated positively and early** —
`completely loaded`, `the entire surface covered rim to rim`, `packed full`,
`hardly any rice visible` — and the opposite has to be named in `--no`:
`sparse, half empty, bare rice, empty space in the bowl, few toppings`.

**Coverage is not portion size, and the distinction matters here.** §1's honesty rule says shoot a
neutral single serving, never a generous one, because portions are scaled 0.6–1.8× per user and the
numbers beside the photo carry the quantity. That still holds: this asks for the surface to be
COVERED by nine distinct toppings, which is what the dish is, not for a mountain of food. Keep
`one single serving` in the prompt and never add `huge portion`, `piled high`, `overflowing`.

Swap `--ar 16:10` for `--ar 5:4` for the large featured card, or `--ar 4:5` plus
`generous empty space` for a hero. Nothing else changes — the style block is fixed on purpose.

**One documented deviation from §3, and the reason.** The standard block blocks
`arranged in a ring`, because a plate of roast vegetables should not come out as a tidy circle.
A loaded poke bowl is different: its toppings genuinely DO sit in sections around the bowl, and
blocking that fights the dish instead of the failure. So for this one the ring is allowed and the
real failure is named instead — `equal wedges, neatly separated sections, pie chart arrangement` —
with `heaped in loose adjacent drifts that overlap and spill into each other, uneven amounts, some
rice still showing through` doing the positive work. Nine components is the hardest version of the
tidiness problem, so it needs the specific words, not the generic ones.

**Why the `--no` list is long.** Three groups, each doing real work:

| blocked | why |
|---|---|
| `raw fish, tuna, salmon, sashimi` | **the important one.** "Poke" means raw fish to the model; without this it will serve tuna and the picture will be of a different dish entirely |
| `seaweed, mango, pickled ginger, wasabi, sriracha, spicy mayo, spring onion, radish` | the poke clichés — and every one of them is **unpriced in `NUTRIENT_TABLE`**, so it cannot be in the recipe, so it must not be in the frame |
| `equal wedges, pie chart arrangement, …` | the tidiness failure, named for this dish rather than in general (above) |

Note what is **no longer** blocked: **avocado** and **sweetcorn** are in the list because they are
priced and therefore allowed in the recipe. That is the rule in both directions — **a garnish the
model adds is an ingredient the card does not have**, and an ingredient the card DOES have should
be in the picture. Block by what the recipe can contain, not by habit.

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
