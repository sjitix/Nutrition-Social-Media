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
 * Maps a meal to a bundled photo by keyword. INTENTIONALLY EMPTY.
 *
 * There were 12 stock photos and 292 recipes, so the keyword rules made one image stand in for
 * dozens of different dishes: `chicken.jpg` was served for 46 recipes, `bowl1.jpg` for 31,
 * `eggdish.jpg` for 28. Scrolling the feed meant seeing the same photograph over and over, of
 * food that wasn't the recipe you were looking at — the two things that make a product read as a
 * template rather than a real app.
 *
 * A library this size cannot be photographed, so the design must not depend on photography:
 * every card is carried by type, colour and layout instead (`gradientForMeal` below). The
 * function and the rules array stay so that REAL per-recipe imagery — shot or user-submitted —
 * can be reintroduced later without touching any caller.
 */
const IMAGE_RULES: [RegExp, string][] = [];

export function imageForMeal(name: string): string | null {
  for (const [re, img] of IMAGE_RULES) {
    if (re.test(name)) return img;
  }
  return null;
}

// A wide, food-appropriate palette so cards without a bundled photo don't fall into just a handful
// of repeated tiles — variety is what makes the wall read as a real feed rather than a demo.
const FALLBACK_GRADIENTS = [
  "linear-gradient(140deg,#d9b78e,#a87f4f)", // wheat / bread
  "linear-gradient(140deg,#a8cfae,#6c9e74)", // fresh green
  "linear-gradient(140deg,#e8b393,#c0714a)", // terracotta / roast
  "linear-gradient(140deg,#b7aef5,#7a6ff0)", // brand violet
  "linear-gradient(140deg,#f2c1a0,#e07a5f)", // salmon / peach
  "linear-gradient(140deg,#c7e6c0,#7bbf6a)", // leafy
  "linear-gradient(140deg,#f6d491,#e0a83e)", // amber / squash
  "linear-gradient(140deg,#a3d9d4,#4fa89f)", // teal / herby
  "linear-gradient(140deg,#e6a8be,#c65b83)", // berry
  "linear-gradient(140deg,#c9c2f0,#8a7ee6)", // lavender
  "linear-gradient(140deg,#f3b7a3,#d96a4a)", // paprika
  "linear-gradient(140deg,#bcd39a,#89a95c)", // olive
  "linear-gradient(140deg,#f0c59a,#cf8b52)", // honey
  "linear-gradient(140deg,#9cc6e0,#5b8fc0)", // cool blue
];

export function gradientForMeal(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_GRADIENTS[Math.abs(hash) % FALLBACK_GRADIENTS.length];
}
