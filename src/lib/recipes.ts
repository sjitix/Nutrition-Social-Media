import type { Meal } from "./types";

// Explore-page demo recipes. Each is a full Meal so "Add to plan" produces
// real plan entries that flow into macros and the grocery list.

export interface ExploreRecipe {
  meal: Meal;
  /**
   * Optional, and currently never set — the bundled stock photos were removed. Twelve photos
   * across 292 recipes meant ONE image stood in for 46 different dishes (chicken.jpg), which
   * reads as a demo and shows food that isn't the recipe. The card design carries the visual
   * weight instead. Kept on the type so real per-recipe imagery can return later.
   */
  image?: string;
  tag?: "vegan" | "veg";
  height: number; // masonry tile height
}

type RawRecipe = Omit<ExploreRecipe, "meal"> & { meal: Omit<Meal, "timeMinutes"> };

const RAW_EXPLORE: RawRecipe[] = [
  {
    height: 190,
    meal: {
      name: "Rainbow Poke Bowl",
      type: "lunch",
      description: "Crispy tofu over greens, edamame, corn and quick-pickled cabbage.",
      calories: 460,
      proteinGrams: 38,
      carbsGrams: 42,
      fatGrams: 16,
      ingredients: [
        { name: "Firm tofu", quantity: "150 g" },
        { name: "Mixed greens", quantity: "80 g" },
        { name: "Edamame", quantity: "60 g" },
        { name: "Corn", quantity: "60 g" },
        { name: "Red cabbage", quantity: "40 g" },
      ],
      steps: [
        "Pan-fry cubed tofu until golden.",
        "Arrange greens and vegetables in a bowl.",
        "Top with tofu and dress with soy-lime dressing.",
      ],
    },
  },
  {
    height: 140,
    tag: "veg",
    meal: {
      name: "Avocado Egg Toast",
      type: "breakfast",
      description: "Seeded toast with sliced avocado and a soft-boiled egg.",
      calories: 340,
      proteinGrams: 15,
      carbsGrams: 28,
      fatGrams: 19,
      ingredients: [
        { name: "Seeded bread", quantity: "2 slices" },
        { name: "Avocado", quantity: "1 piece" },
        { name: "Eggs", quantity: "1 piece" },
      ],
      steps: [
        "Soft-boil the egg for 6 minutes.",
        "Toast the bread and fan the avocado over it.",
        "Halve the egg on top, season with pepper.",
      ],
    },
  },
  {
    height: 165,
    meal: {
      name: "Protein Penne Bolognese",
      type: "dinner",
      description: "Lean beef ragu over penne with parmesan.",
      calories: 520,
      proteinGrams: 41,
      carbsGrams: 58,
      fatGrams: 13,
      ingredients: [
        { name: "Penne", quantity: "80 g dry" },
        { name: "Lean ground beef", quantity: "125 g" },
        { name: "Chopped tomatoes", quantity: "1 can" },
        { name: "Parmesan", quantity: "15 g" },
      ],
      steps: [
        "Brown the beef with onion.",
        "Add tomatoes and simmer 15 minutes.",
        "Toss with cooked penne and finish with parmesan.",
      ],
    },
  },
  {
    height: 210,
    tag: "veg",
    meal: {
      name: "Berry Protein Smoothie",
      type: "snack",
      description: "Frozen berries blended with yogurt and oats.",
      calories: 290,
      proteinGrams: 22,
      carbsGrams: 38,
      fatGrams: 6,
      ingredients: [
        { name: "Frozen berries", quantity: "150 g" },
        { name: "Greek yogurt", quantity: "150 g" },
        { name: "Rolled oats", quantity: "30 g" },
        { name: "Milk", quantity: "150 ml" },
      ],
      steps: ["Blend everything until smooth.", "Top with a few whole berries."],
    },
  },
  {
    height: 155,
    tag: "vegan",
    meal: {
      name: "Crunchy Buddha Bowl",
      type: "lunch",
      description: "Roast sweet potato, chickpeas, avocado and slaw with tahini.",
      calories: 430,
      proteinGrams: 18,
      carbsGrams: 52,
      fatGrams: 17,
      ingredients: [
        { name: "Sweet potato", quantity: "1 piece" },
        { name: "Chickpeas", quantity: "1/2 can" },
        { name: "Avocado", quantity: "1/2 piece" },
        { name: "Red cabbage", quantity: "50 g" },
        { name: "Tahini", quantity: "1 tbsp" },
      ],
      steps: [
        "Roast sweet potato cubes and chickpeas at 200°C for 25 minutes.",
        "Assemble with slaw and avocado.",
        "Drizzle with lemon-tahini dressing.",
      ],
    },
  },
  {
    height: 130,
    meal: {
      name: "Grilled Lemon Chicken",
      type: "dinner",
      description: "Char-grilled chicken breast with grilled zucchini and peppers.",
      calories: 510,
      proteinGrams: 46,
      carbsGrams: 24,
      fatGrams: 18,
      ingredients: [
        { name: "Chicken breast", quantity: "180 g" },
        { name: "Zucchini", quantity: "1 piece" },
        { name: "Bell pepper", quantity: "1 piece" },
        { name: "Lemon", quantity: "1/2 piece" },
        { name: "Olive oil", quantity: "1 tbsp" },
      ],
      steps: [
        "Marinate chicken in lemon, oil and herbs for 10 minutes.",
        "Grill 5-6 minutes per side.",
        "Grill the vegetables alongside and serve.",
      ],
    },
  },
  {
    height: 160,
    meal: {
      name: "Salmon Couscous Plate",
      type: "lunch",
      description: "Seared salmon with herby couscous and green beans.",
      calories: 390,
      proteinGrams: 32,
      carbsGrams: 36,
      fatGrams: 12,
      ingredients: [
        { name: "Salmon fillet", quantity: "120 g" },
        { name: "Couscous", quantity: "60 g dry" },
        { name: "Green beans", quantity: "100 g" },
        { name: "Cherry tomatoes", quantity: "80 g" },
      ],
      steps: [
        "Steep couscous in hot stock for 5 minutes.",
        "Sear the salmon 3 minutes per side.",
        "Blanch beans and assemble the plate.",
      ],
    },
  },
  {
    height: 185,
    tag: "veg",
    meal: {
      name: "Soft Egg Breakfast Toast",
      type: "breakfast",
      description: "Jammy eggs and spinach on sourdough.",
      calories: 310,
      proteinGrams: 18,
      carbsGrams: 26,
      fatGrams: 14,
      ingredients: [
        { name: "Sourdough bread", quantity: "1 slice" },
        { name: "Eggs", quantity: "2 pieces" },
        { name: "Spinach", quantity: "40 g" },
        { name: "Avocado", quantity: "1/4 piece" },
      ],
      steps: [
        "Boil eggs for 7 minutes.",
        "Toast the sourdough and layer spinach and avocado.",
        "Halve the eggs on top and season.",
      ],
    },
  },
];

// Explore recipes are curated demos; give each a sensible default cook time.
export const EXPLORE_RECIPES: ExploreRecipe[] = RAW_EXPLORE.map((r) => ({
  ...r,
  meal: { ...r.meal, timeMinutes: 20 },
}));

/**
 * Maps a recipe to its OWN photograph, by exact name.
 *
 * This used to be a list of keyword REGEXES over 12 stock photos, and that is precisely what
 * broke it: `/chicken/` matched 46 different recipes, so one photograph was served as 46
 * different dishes, and `bowl1.jpg` stood in for 31 more. Scrolling showed the same picture over
 * and over, of food that was not the recipe on the card. The photos were deleted for that reason.
 *
 * The rule that makes imagery safe here, and the reason this is a Map and not a rule list:
 *
 *   AN IMAGE APPEARS ONLY ON THE DISH IT ACTUALLY DEPICTS. NEVER AS A STAND-IN.
 *
 * A miss returns null and the caller falls back to `gradientForMeal`, so partial coverage is
 * honest — 497 typographic cards and 3 photographed ones, rather than 3 photos pretending to be
 * 500 dishes. Adding a photo is one line; there is no rule that can accidentally widen.
 *
 * Before adding an entry, LOOK at the image and confirm it shows this dish's real ingredients and
 * does not contradict its dietTags — a vegan card showing cheese is the failure this guards.
 */
const RECIPE_IMAGES: Record<string, string> = {
  // Looked at, and checked against each recipe's own ingredient list and dietTags:
  //   miso-cod        white fish under a dark miso glaze with sesame, bok choy, brown rice.
  //                   NOT salmon — the species is the whole point of this one.
  //   baked-salmon    pink flaking fillet, baby potatoes, broccoli, lemon wedge.
  //   sheetpan-chicken chicken breast, roast sweet potato cubes, charred broccoli, paprika.
  //                   (This is the one CONTEXT.md recorded as never verified. It has now been
  //                   looked at: it is chicken.)
  //   shakshuka       two eggs poached in tomato and pepper, feta, herbs. `vegetarian` and
  //                   `gluten_free` both hold — feta is in the recipe, and there is no bread
  //                   in the frame, which is the usual way this dish breaks its own tags.
  "Miso-Glazed Cod with Bok Choy & Rice": "/food/miso-cod.jpg",
  "Baked Salmon & Potatoes": "/food/baked-salmon.jpg",
  "Sheet-Pan Chicken & Veg": "/food/sheetpan-chicken.jpg",
  Shakshuka: "/food/shakshuka.jpg",
};

/**
 * Cut-outs: the same dish, with its background removed, so the plate is an OBJECT on the page.
 *
 * The reference boards (`sage-06` especially) do not put photography in a rounded card — they lay
 * a bowl straight on the page ground, with its own shadow, cropped by the frame edge. A rectangle
 * cannot do that: the rectangle is what reads as "a photo in a slot".
 *
 * Same rule as `RECIPE_IMAGES`, deliberately — an exact recipe name, a miss returns null, and the
 * image may only ever be the dish it depicts. This is a SEPARATE map rather than a suffix
 * convention on the one above, because a convention ("try name + '-plate'") is a rule that can
 * widen by accident, which is the failure the exact map exists to make impossible.
 *
 * `miso-cod-plate.webp` is masked from `designs/references/food/codmisobokchoi-09.jpg`, which is
 * the ORIGINAL of `miso-cod.jpg` — same frame, before it was cropped for the card slot. It has to
 * be the original rather than the shipped crop, because the crop cuts the plate at three edges and
 * a round mask needs the whole plate. So the card and the hero are one photograph, two renderings.
 * Regenerate with `node scripts/make-plate-cutout.mjs <src> <out.webp> <preview.jpg>` — and look at
 * the preview it writes, which is the cut-out composited on the page colour.
 */
const RECIPE_CUTOUTS: Record<string, string> = {
  "Miso-Glazed Cod with Bok Choy & Rice": "/food/miso-cod-plate.webp",
};

export function cutoutForMeal(name: string): string | null {
  return RECIPE_CUTOUTS[name.trim()] ?? null;
}

/** Recipe names that have a cut-out, in map order. See `PHOTOGRAPHED_RECIPES` for the reasoning. */
export const CUTOUT_RECIPES: string[] = Object.keys(RECIPE_CUTOUTS);

/**
 * Every recipe name that has its own photograph, in map order.
 *
 * The photography-led screens need to know WHICH dishes can carry an image before they choose a
 * composition — a hero that picks a random meal and then discovers there is no picture of it has
 * to degrade, and the degraded version is the one that ships. Exported so a page can lead with a
 * photographed dish and stay honest about the rest.
 */
export const PHOTOGRAPHED_RECIPES: string[] = Object.keys(RECIPE_IMAGES);

export function imageForMeal(name: string): string | null {
  return RECIPE_IMAGES[name.trim()] ?? null;
}

// How many tile slots the card palette has. The gradients themselves live in globals.css as
// --tile-1 … --tile-14 so a theme can redefine them; only the COUNT is needed here, to hash a dish
// name onto a slot. They used to be literal strings in this file, and two of the fourteen were
// brand violet — which meant the app could not be re-skinned while its largest blocks of colour
// were baked into JS. Keep this in sync with the variables in globals.css.
const TILE_COUNT = 14;

/**
 * Returns a CSS variable, not a literal gradient, so the tile palette is themeable.
 *
 * These strings used to be baked in, and two of the fourteen were brand violet. Since every card
 * falls back to a gradient now that the stock photos are gone, that violet appeared on roughly one
 * tile in seven no matter what theme was active — the app could not be re-skinned while its
 * largest blocks of colour were hardcoded in a JS array.
 *
 * The values live in globals.css as `--tile-1 … --tile-14`, which a theme can redefine. The
 * hashing is unchanged, so a given dish still always gets the same slot.
 */
export function gradientForMeal(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `var(--tile-${(Math.abs(hash) % TILE_COUNT) + 1})`;
}
