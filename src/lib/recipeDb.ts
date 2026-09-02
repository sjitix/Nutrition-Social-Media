

import {
  DAYS,
  type DayPlan,
  type Meal,
  type Operation,
  type UserProfile,
  type WeekPlan,
  type LockedMeal,
  type MealRating,
  type PlanSnapshot,
} from "./types";
import { haystackBlocked, parseExclusionTokens, dietTagConflicts, wordMatches } from "./exclusions";
import {
  computeTargets, explainTargets, hydrationTarget, explainHydration,
  CALORIE_FLOOR, DEFAULT_CALORIE_FLOOR,
} from "./targets";
import { SUBSTITUTES, INGREDIENT_ALIASES } from "./substitutions";
import { SYMPTOMS, URGENT_FLAGS, CRISIS_FLAGS, PHRASE_NOISE } from "./symptoms";
import { conditionBoosts } from "./conditions";
import { NUTRIENT_TABLE } from "./nutrientTable.generated";
import {
  microsForIngredients,
  microDensity,
  gramsFor,
  MICRO_KEYS,
  MICRO_LABEL,
  MICRO_UNIT,
  DAILY_REFERENCE,
  type MicroKey,
} from "./nutrients";

// ---------------------------------------------------------------------------
// Recipe database (Phase A scaffolding — see VISION.md "Recipe data strategy").
//
// This is the structure + selection engine that will eventually hold a large,
// curated, USDA-accurate recipe library. Right now it ships with a small seed
// set so the DB-backed plan works end to end; the seed grows later via the
// offline ingest/clean pipeline. Selection is deterministic-ish (constraint
// filtering + diversity), so plans are accurate and free to produce at scale.
//
// It is OFF by default — the plan route only uses it when PLAN_ENGINE=db, so
// the live LLM path is untouched while this matures.
// ---------------------------------------------------------------------------

export type Cuisine =
  | "mediterranean"
  | "asian"
  | "mexican"
  | "italian"
  | "middle_eastern"
  | "american"
  | "indian";

export type MainProtein =
  | "chicken"
  | "beef"
  | "pork"
  | "turkey"
  | "fish"
  | "shrimp"
  | "eggs"
  | "tofu"
  | "legumes"
  | "dairy";

export type DietTag = "vegetarian" | "vegan" | "keto" | "mediterranean" | "gluten_free";

export interface Recipe {
  id: string;
  name: string;
  type: "breakfast" | "lunch" | "dinner" | "snack";
  cuisine: Cuisine;
  mainProtein: MainProtein;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  fiberGrams?: number;
  timeMinutes: number;
  approxCost: number; // 1 (cheap) – 3 (pricier) per serving
  dietTags: DietTag[];
  /**
   * Treat foods (pizza, burgers). The planner must NEVER select these on its own — a
   * nutritionist does not quietly slip a burger into your week. They are reachable only when
   * the user asks for them by name, which is exactly the cheat-day flow. Before these existed,
   * "it's my cheat day, swap Saturday dinner for pizza" answered "I don't have anything like
   * pizza" — the feature was unreachable.
   */
  treatOnly?: boolean;
  /**
   * How many servings this ingredient list yields. Macros above are PER SERVING; a batch
   * recipe's ingredients make several. Defaults to 1. Only nutrient math uses it — the
   * ingredient list stays as written, because that is how you actually cook it.
   */
  servings?: number;
  description: string;
  ingredients: { name: string; quantity: string }[];
  steps: string[];
}

/** Public Recipe -> Meal, for surfaces (the browse feed) that show library recipes as plan-ready. */
export const recipeToMeal = (r: Recipe): Meal => toMeal(r);

// Convert a stored Recipe into the app's Meal shape.
function toMeal(r: Recipe): Meal {
  return {
    name: r.name,
    type: r.type,
    description: r.description,
    calories: r.calories,
    proteinGrams: r.proteinGrams,
    carbsGrams: r.carbsGrams,
    fatGrams: r.fatGrams,
    fiberGrams: r.fiberGrams,
    timeMinutes: r.timeMinutes,
    servings: r.servings,
    ingredients: r.ingredients,
    steps: r.steps,
  };
}

// --- Seed library ----------------------------------------------------------
// A small but diverse starter set (7 breakfasts / 7 lunches / 7 dinners / 2
// snacks) spanning cuisines and proteins, enough to build a no-repeat week.
/** A recipe as authored: everything except the macros, which are computed from the ingredients. */
type RecipeSeed = Omit<Recipe, "calories" | "proteinGrams" | "carbsGrams" | "fatGrams" | "fiberGrams">;

/**
 * Add up what the ingredients actually are, per serving, from USDA per-100g values.
 *
 * `gramsFor` knows the unit conventions ("1 tbsp", "70 g dry", "1 can"). An ingredient we cannot
 * price contributes nothing — which would quietly understate the dish, so check-recipes.mts fails
 * on any unpriced ingredient rather than letting it pass.
 */
function deriveMacros(r: RecipeSeed): Recipe {
  const servings = Math.max(1, r.servings ?? 1);
  let cal = 0, protein = 0, carbs = 0, fat = 0, fiber = 0;
  for (const i of r.ingredients) {
    const key = i.name.trim().toLowerCase();
    const per = NUTRIENT_TABLE[key]?.per100g;
    const grams = gramsFor(key, i.quantity);
    if (!per || !grams) continue;
    const f = grams / 100;
    cal += (per.cal ?? 0) * f;
    protein += (per.protein ?? 0) * f;
    carbs += (per.carbs ?? 0) * f;
    fat += (per.fat ?? 0) * f;
    fiber += (per.fiber ?? 0) * f;
  }
  return {
    ...r,
    calories: Math.round(cal / servings),
    proteinGrams: Math.round(protein / servings),
    carbsGrams: Math.round(carbs / servings),
    fatGrams: Math.round(fat / servings),
    fiberGrams: Math.round(fiber / servings),
  };
}

/**
 * The seed library. Note what is NOT here: calories, protein, carbs, fat, fiber.
 *
 * Those used to be hand-written on each card, and 46 of 140 recipes disagreed with their own
 * ingredient list by more than 20% — one by 63%. That is not a cosmetic problem. Every
 * micronutrient this app reports is derived from the ingredient list against USDA data, while the
 * calories and protein shown to the user came from the card. When the two disagree, the nutrients
 * are silently wrong in proportion: a Shakshuka whose ingredients accounted for 57% of its
 * calories reported 57% of its real iron, and weekly_report could tell someone they were deficient
 * when they were not.
 *
 * So the ingredient list is now the single source of truth, and the macros are computed from it.
 * A recipe cannot lie about itself any more; the worst it can do is be an incomplete recipe, and
 * `npm run check:recipes` fails when it is.
 */
const SEED_RECIPES: RecipeSeed[] = [
  // ---- Breakfasts ----
  {
    id: "b-greek-yogurt", name: "Greek Yogurt & Berry Bowl", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Creamy yogurt with berries, honey and crunchy granola.",
    ingredients: [
      { name: "Greek yogurt", quantity: "200 g" },
      { name: "Mixed berries", quantity: "100 g" },
      { name: "Granola", quantity: "40 g" },
      { name: "Honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon yogurt into a bowl.", "Top with berries, granola and honey."],
  },
  {
    id: "b-veggie-omelette", name: "Veggie Omelette", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Fluffy three-egg omelette with peppers and spinach.",
    ingredients: [
      { name: "Eggs", quantity: "3 pieces" },
      { name: "Bell pepper", quantity: "1/2 piece" },
      { name: "Spinach", quantity: "50 g" },
      { name: "Olive oil", quantity: "1 tsp" },
    ],
    steps: ["Whisk eggs; sauté pepper and spinach.", "Add eggs, cook until set, fold."],
  },
  {
    id: "b-banana-oatmeal", name: "Peanut Banana Oatmeal", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Warm oats with banana, cinnamon and peanut butter.",
    ingredients: [
      { name: "Rolled oats", quantity: "60 g" },
      { name: "Milk", quantity: "250 ml" },
      { name: "Banana", quantity: "1 piece" },
      { name: "Peanut butter", quantity: "1 tbsp" },
    ],
    steps: ["Simmer oats in milk 5 min.", "Top with banana and peanut butter."],
  },
  {
    id: "b-tofu-wrap", name: "Tofu Scramble Wrap", type: "breakfast",
    cuisine: "american", mainProtein: "tofu",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Turmeric tofu scramble with veggies in a warm tortilla.",
    ingredients: [
      { name: "Firm tofu", quantity: "150 g" },
      { name: "Whole-wheat tortilla", quantity: "1 piece" },
      { name: "Spinach", quantity: "40 g" },
      { name: "Turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Crumble and fry tofu with turmeric and spinach.", "Wrap in the tortilla."],
  },
  {
    id: "b-shakshuka", name: "Shakshuka", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Eggs poached in a spiced tomato and pepper sauce.",
    ingredients: [
      { name: "Eggs", quantity: "2 pieces" },
      { name: "Chopped tomatoes", quantity: "1 can" },
      { name: "Bell pepper", quantity: "1 piece" },
      { name: "Onion", quantity: "1/2 piece" },
      { name: "Olive oil", quantity: "1 tbsp" },
      { name: "Feta", quantity: "40 g" },
      { name: "Paprika", quantity: "1 tsp" },
    ],
    steps: ["Simmer peppers, tomatoes and paprika.", "Crack in eggs; cook until set."],
  },
  {
    id: "b-salmon-bagel", name: "Smoked Salmon Bagel", type: "breakfast",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 8, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Wholegrain bagel with cream cheese and smoked salmon.",
    ingredients: [
      { name: "Wholegrain bagel", quantity: "1 piece" },
      { name: "Smoked salmon", quantity: "80 g" },
      { name: "Cream cheese", quantity: "2 tbsp" },
      { name: "Cucumber", quantity: "1/2 piece" },
    ],
    steps: ["Toast and spread the bagel.", "Layer salmon and cucumber."],
  },
  {
    id: "b-avocado-toast", name: "Avocado & Chickpea Toast", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Smashed avocado and chickpeas on toasted sourdough.",
    ingredients: [
      { name: "Sourdough bread", quantity: "2 slices" },
      { name: "Avocado", quantity: "1 piece" },
      { name: "Chickpeas", quantity: "80 g" },
      { name: "Lemon", quantity: "1/2 piece" },
    ],
    steps: ["Toast bread.", "Smash avocado with chickpeas and lemon; pile on top."],
  },

  // ---- Lunches ----
  {
    id: "l-chicken-quinoa", name: "Chicken Quinoa Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Grilled chicken over quinoa with roasted vegetables.",
    ingredients: [
      { name: "Chicken breast", quantity: "150 g" },
      { name: "Quinoa", quantity: "80 g dry" },
      { name: "Zucchini", quantity: "1 piece" },
      { name: "Olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook quinoa; grill chicken.", "Roast zucchini and assemble."],
  },
  {
    id: "l-tuna-nicoise", name: "Tuna Niçoise Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Tuna, egg, green beans and potatoes with a light dressing.",
    ingredients: [
      { name: "Canned tuna", quantity: "1 can" },
      { name: "Egg", quantity: "1 piece" },
      { name: "Green beans", quantity: "100 g" },
      { name: "Baby potatoes", quantity: "150 g" },
      { name: "Olives", quantity: "30 g" },
      { name: "Olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Boil egg, beans and potatoes.", "Flake tuna over; dress and toss."],
  },
  {
    id: "l-beef-burrito", name: "Beef Burrito Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "beef",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Seasoned beef with rice, black beans, corn and salsa.",
    ingredients: [
      { name: "Lean ground beef", quantity: "120 g" },
      { name: "Rice", quantity: "70 g dry" },
      { name: "Black beans", quantity: "80 g" },
      { name: "Salsa", quantity: "3 tbsp" },
    ],
    steps: ["Cook rice; brown beef with spices.", "Build the bowl with beans and salsa."],
  },
  {
    id: "l-lentil-soup", name: "Lentil Soup & Bread", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Hearty red lentil soup with carrot and cumin.",
    ingredients: [
      { name: "Red lentils", quantity: "100 g" },
      { name: "Carrot", quantity: "1 piece" },
      { name: "Onion", quantity: "1 piece" },
      { name: "Cumin", quantity: "1 tsp" },
    ],
    steps: ["Sauté onion and carrot.", "Add lentils, cumin and water; simmer 20 min."],
  },
  {
    id: "l-teriyaki-tofu", name: "Teriyaki Tofu Stir-Fry", type: "lunch",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crispy tofu and vegetables in teriyaki over rice.",
    ingredients: [
      { name: "Firm tofu", quantity: "150 g" },
      { name: "Rice", quantity: "70 g dry" },
      { name: "Mixed stir-fry veg", quantity: "150 g" },
      { name: "Teriyaki sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice; fry tofu until golden.", "Stir-fry veg with sauce; combine."],
  },
  {
    id: "l-turkey-wrap", name: "Turkey Avocado Wrap", type: "lunch",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 10, approxCost: 2,
    dietTags: [],
    description: "Turkey, avocado and salad in a wholegrain wrap.",
    ingredients: [
      { name: "Turkey breast", quantity: "120 g" },
      { name: "Whole-wheat tortilla", quantity: "1 piece" },
      { name: "Avocado", quantity: "1/2 piece" },
      { name: "Lettuce", quantity: "40 g" },
    ],
    steps: ["Layer turkey, avocado and lettuce on the wrap.", "Roll tightly and slice."],
  },
  {
    id: "l-shrimp-rice", name: "Shrimp Fried Rice", type: "lunch",
    cuisine: "asian", mainProtein: "shrimp",
    timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Wok-fried rice with shrimp, egg and peas.",
    ingredients: [
      { name: "Shrimp", quantity: "120 g" },
      { name: "Cooked rice", quantity: "200 g" },
      { name: "Egg", quantity: "1 piece" },
      { name: "Peas", quantity: "60 g" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Scramble egg; set aside.", "Fry shrimp and rice with peas; combine."],
  },

  // ---- Dinners ----
  {
    id: "d-baked-salmon", name: "Baked Salmon & Potatoes", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 30, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Oven salmon with baby potatoes and broccoli.",
    ingredients: [
      { name: "Salmon fillet", quantity: "150 g" },
      { name: "Baby potatoes", quantity: "250 g" },
      { name: "Broccoli", quantity: "150 g" },
      { name: "Lemon", quantity: "1/2 piece" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast potatoes 25 min.", "Add salmon and broccoli for the last 12 min."],
  },
  {
    id: "d-turkey-chili", name: "Turkey Chili", type: "dinner",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Lean turkey chili with beans and tomatoes.",
    ingredients: [
      { name: "Ground turkey", quantity: "150 g" },
      { name: "Kidney beans", quantity: "1/2 can" },
      { name: "Chopped tomatoes", quantity: "1 can" },
      { name: "Chili powder", quantity: "1 tsp" },
    ],
    steps: ["Brown turkey with chili powder.", "Add beans and tomatoes; simmer 20 min."],
  },
  {
    id: "d-pork-tenderloin", name: "Pork Tenderloin & Veg", type: "dinner",
    cuisine: "american", mainProtein: "pork",
    timeMinutes: 30, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Roast pork tenderloin with asparagus and garlic.",
    ingredients: [
      { name: "Pork tenderloin", quantity: "160 g" },
      { name: "Asparagus", quantity: "150 g" },
      { name: "Garlic", quantity: "2 cloves" },
      { name: "Olive oil", quantity: "1 tbsp" },
      { name: "Avocado", quantity: "1/2 piece" },
    ],
    steps: ["Sear pork, then roast 15 min.", "Roast asparagus alongside; rest and slice."],
  },
  {
    id: "d-chickpea-curry", name: "Chickpea Curry", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced chickpea and tomato curry with rice.",
    ingredients: [
      { name: "Chickpeas", quantity: "1 can" },
      { name: "Chopped tomatoes", quantity: "1/2 can" },
      { name: "Rice", quantity: "70 g dry" },
      { name: "Curry powder", quantity: "1 tbsp" },
    ],
    steps: ["Simmer chickpeas, tomato and curry powder 15 min.", "Serve over rice."],
  },
  {
    id: "d-beef-noodles", name: "Beef Stir-Fry Noodles", type: "dinner",
    cuisine: "asian", mainProtein: "beef",
    timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Beef and vegetables tossed with noodles in soy-ginger sauce.",
    ingredients: [
      { name: "Beef strips", quantity: "140 g" },
      { name: "Egg noodles", quantity: "90 g dry" },
      { name: "Mixed veg", quantity: "150 g" },
      { name: "Soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook noodles.", "Stir-fry beef and veg with soy; toss with noodles."],
  },
  {
    id: "d-chicken-fajitas", name: "Chicken Fajitas", type: "dinner",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "Sizzling chicken and peppers with warm tortillas.",
    ingredients: [
      { name: "Chicken breast", quantity: "160 g" },
      { name: "Bell peppers", quantity: "2 pieces" },
      { name: "Tortillas", quantity: "2 pieces" },
      { name: "Fajita spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Sear spiced chicken and peppers.", "Serve in warm tortillas."],
  },
  {
    id: "d-eggplant-parm", name: "Eggplant Parmesan", type: "dinner",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Baked eggplant layered with tomato sauce and mozzarella.",
    ingredients: [
      { name: "Eggplant", quantity: "1 piece" },
      { name: "Tomato sauce", quantity: "200 g" },
      { name: "Mozzarella", quantity: "60 g" },
      { name: "Parmesan", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast eggplant slices.", "Layer with sauce and cheese; bake 15 min."],
  },

  // ---- Snacks ----
  {
    id: "s-yogurt-honey", name: "Greek Yogurt & Honey", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Thick yogurt drizzled with honey.",
    ingredients: [
      { name: "Greek yogurt", quantity: "150 g" },
      { name: "Honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon yogurt into a cup; drizzle honey."],
  },
  {
    id: "s-protein-smoothie", name: "Berry Protein Smoothie", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Frozen berries blended with yogurt and oats.",
    ingredients: [
      { name: "Frozen berries", quantity: "150 g" },
      { name: "Greek yogurt", quantity: "150 g" },
      { name: "Rolled oats", quantity: "30 g" },
    ],
    steps: ["Blend everything until smooth."],
  },

  // ===== Batch 2 — curated, high-protein & high-fiber =====

  // ---- Breakfasts ----
  {
    id: "b-egg-muffins", name: "Spinach & Feta Egg Muffins", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Baked egg muffins with spinach and feta — meal-prep friendly.",
    ingredients: [
      { name: "eggs", quantity: "4" },
      { name: "spinach", quantity: "80 g" },
      { name: "feta", quantity: "40 g" },
      { name: "cherry tomatoes", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Whisk eggs with chopped spinach, feta and tomatoes.", "Pour into a muffin tin; bake at 190°C for 18 minutes."],
  },
  {
    id: "b-protein-oats", name: "Overnight Protein Oats with Berries", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Make-ahead oats with Greek yogurt and mixed berries.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "Greek yogurt", quantity: "150 g" },
      { name: "milk", quantity: "120 ml" },
      { name: "mixed berries", quantity: "100 g" },
      { name: "chia seeds", quantity: "1 tbsp" },
    ],
    steps: ["Stir oats, yogurt, milk and chia together.", "Chill overnight; top with berries."],
  },
  {
    id: "b-cottage-pancakes", name: "Cottage Cheese Pancakes with Blueberries", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Fluffy high-protein pancakes with blueberries.",
    ingredients: [
      { name: "cottage cheese", quantity: "120 g" },
      { name: "rolled oats", quantity: "50 g" },
      { name: "eggs", quantity: "2" },
      { name: "blueberries", quantity: "80 g" },
    ],
    steps: ["Blend cottage cheese, oats and eggs into a batter.", "Cook small pancakes 2 min per side; top with blueberries."],
  },
  {
    id: "b-salmon-eggs", name: "Smoked Salmon Scrambled Eggs", type: "breakfast",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 10, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Soft scrambled eggs folded with smoked salmon on rye.",
    ingredients: [
      { name: "eggs", quantity: "3" },
      { name: "smoked salmon", quantity: "60 g" },
      { name: "rye bread", quantity: "1 slice" },
      { name: "chives", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Softly scramble the eggs.", "Fold in salmon and chives; serve on toasted rye."],
  },
  {
    id: "b-chickpea-omelette", name: "Savory Chickpea Flour Omelette", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Protein-rich vegan omelette from chickpea flour with veggies.",
    ingredients: [
      { name: "chickpea flour", quantity: "70 g" },
      { name: "bell pepper", quantity: "1/2" },
      { name: "spinach", quantity: "40 g" },
      { name: "turmeric", quantity: "1 tsp" },
    ],
    steps: ["Whisk chickpea flour with water, turmeric and salt into a batter.", "Pour into a pan, add veggies; cook 3 min per side."],
  },
  {
    id: "b-turkey-hash", name: "Turkey Sausage & Sweet Potato Hash", type: "breakfast",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Skillet hash of turkey sausage, sweet potato and peppers.",
    ingredients: [
      { name: "turkey sausage", quantity: "120 g" },
      { name: "sweet potato", quantity: "1 small" },
      { name: "bell pepper", quantity: "1" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Sauté diced sweet potato until tender.", "Add crumbled sausage and peppers; cook through."],
  },
  {
    id: "b-pb-shake-bowl", name: "Peanut Butter Banana Shake Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Thick protein shake bowl with banana and peanut butter.",
    ingredients: [
      { name: "Greek yogurt", quantity: "150 g" },
      { name: "banana", quantity: "1" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "peanut butter", quantity: "1 tbsp" },
    ],
    steps: ["Blend yogurt, banana and protein powder.", "Pour into a bowl; swirl in peanut butter."],
  },
  {
    id: "b-tofu-burrito", name: "Tofu & Black Bean Breakfast Burrito", type: "breakfast",
    cuisine: "mexican", mainProtein: "tofu",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Turmeric tofu scramble with black beans in a wrap.",
    ingredients: [
      { name: "firm tofu", quantity: "120 g" },
      { name: "black beans", quantity: "80 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "salsa", quantity: "2 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Scramble crumbled tofu with turmeric; warm the beans.", "Fill the wrap with tofu, beans and salsa; roll."],
  },
  {
    id: "b-yogurt-bark", name: "Greek Yogurt Bark with Almonds", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Frozen yogurt bark studded with raspberries and almonds.",
    ingredients: [
      { name: "Greek yogurt", quantity: "200 g" },
      { name: "raspberries", quantity: "80 g" },
      { name: "almonds", quantity: "20 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spread sweetened yogurt on a tray; scatter raspberries and almonds.", "Freeze 2 hours; break into pieces."],
  },
  {
    id: "b-quinoa-bowl", name: "Quinoa Breakfast Bowl with Egg & Avocado", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Warm quinoa topped with a soft egg and avocado.",
    ingredients: [
      { name: "quinoa", quantity: "60 g dry" },
      { name: "eggs", quantity: "2" },
      { name: "avocado", quantity: "1/2" },
      { name: "cherry tomatoes", quantity: "60 g" },
    ],
    steps: ["Cook the quinoa.", "Top with a fried egg, sliced avocado and tomatoes."],
  },

  // ---- Lunches ----
  {
    id: "l-farro-tabbouleh", name: "Grilled Chicken & Quinoa Tabbouleh", type: "lunch",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Herby quinoa tabbouleh with sliced grilled chicken.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "parsley", quantity: "30 g" },
      { name: "cucumber", quantity: "1/2" },
      { name: "lemon", quantity: "1/2" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook quinoa; toss with chopped parsley, cucumber and lemon.", "Grill the chicken and slice over the top."],
  },
  {
    id: "l-salmon-poke", name: "Salmon Poke Bowl with Edamame", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: [],
    description: "Fresh salmon over rice with edamame and cucumber.",
    ingredients: [
      { name: "salmon fillet", quantity: "140 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "edamame", quantity: "80 g" },
      { name: "cucumber", quantity: "1/2" },
      { name: "soy sauce", quantity: "1 tbsp" },
    ],
    steps: ["Cook the rice and cool slightly.", "Top with cubed salmon, edamame, cucumber and soy."],
  },
  {
    /**
     * Added so a photograph has a dish to belong to. `RECIPE_IMAGES` is an exact per-dish map, and
     * the two existing poke bowls are salmon and tofu — mapping a picture of chicken and egg to
     * either of them is the stand-in failure the map exists to prevent, so the recipe comes first
     * and the photograph second, never the other way round.
     *
     * Twelve ingredients, which is more than most here and is the point: it is a loaded bowl and
     * the photograph shows every one of them. Each is already curated to an FDC id — no ingredient
     * was auto-matched to USDA, which is unsafe (it produced `salmon fillet -> Salmonberries`).
     * Not `gluten_free`: soy sauce contains wheat.
     */
    id: "l-chicken-egg-poke", name: "Chicken & Egg Poke Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: [],
    description: "Grilled chicken and a jammy egg over rice with edamame, corn, avocado and slaw.",
    ingredients: [
      { name: "chicken breast", quantity: "120 g" },
      { name: "eggs", quantity: "1 piece" },
      { name: "brown rice", quantity: "55 g dry" },
      { name: "edamame", quantity: "60 g" },
      { name: "carrot", quantity: "50 g" },
      { name: "cabbage", quantity: "40 g" },
      { name: "bean sprouts", quantity: "30 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "corn", quantity: "50 g" },
      { name: "cherry tomatoes", quantity: "60 g" },
      { name: "sesame seeds", quantity: "1 tsp" },
      { name: "soy sauce", quantity: "1 tbsp" },
    ],
    steps: [
      "Cook the rice and let it cool slightly; grill the chicken and slice it.",
      "Boil the egg 6-7 minutes for a jammy yolk and halve it.",
      "Top the rice with everything, keeping each topping in its own drift, and dress with soy.",
    ],
  },
  {
    id: "l-buddha-bowl", name: "Lentil & Roasted Veg Buddha Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Roasted vegetables and lentils with tahini drizzle.",
    ingredients: [
      { name: "lentils", quantity: "150 g cooked" },
      { name: "sweet potato", quantity: "1 small" },
      { name: "broccoli", quantity: "100 g" },
      { name: "tahini", quantity: "1 tbsp" },
    ],
    steps: ["Roast sweet potato and broccoli at 200°C for 25 min.", "Serve over lentils; drizzle with tahini."],
  },
  {
    id: "l-turkey-power-wrap", name: "Turkey & Hummus Power Wrap", type: "lunch",
    cuisine: "mediterranean", mainProtein: "turkey",
    timeMinutes: 10, approxCost: 2,
    dietTags: [],
    description: "Turkey, hummus and greens rolled in a whole-wheat wrap.",
    ingredients: [
      { name: "turkey breast", quantity: "130 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "hummus", quantity: "40 g" },
      { name: "mixed greens", quantity: "40 g" },
    ],
    steps: ["Spread hummus on the wrap.", "Layer turkey and greens; roll and slice."],
  },
  {
    id: "l-shrimp-burrito", name: "Shrimp & Black Bean Burrito Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "shrimp",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Chili-lime shrimp over rice with black beans and corn.",
    ingredients: [
      { name: "shrimp", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "black beans", quantity: "80 g" },
      { name: "corn", quantity: "60 g" },
      { name: "lime", quantity: "1/2" },
    ],
    steps: ["Cook rice; sauté shrimp with chili and lime.", "Build the bowl with beans and corn."],
  },
  {
    id: "l-tuna-bean-salad", name: "Tuna & White Bean Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Protein-packed tuna and cannellini bean salad.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "cannellini beans", quantity: "120 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "red onion", quantity: "1/4" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Drain tuna and beans.", "Toss with tomatoes, onion and olive oil."],
  },
  {
    id: "l-tofu-banh-mi", name: "Tofu Banh Mi Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Glazed tofu with pickled carrot over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "carrot", quantity: "1" },
      { name: "soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Pan-fry tofu and glaze with soy.", "Serve over rice with quick-pickled carrot."],
  },
  {
    id: "l-chicken-shawarma", name: "Chicken Shawarma Bowl with Tahini", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced chicken over rice with chickpeas and tahini.",
    ingredients: [
      { name: "chicken thigh", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "chickpeas", quantity: "80 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "shawarma spice", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice; sear spiced chicken.", "Serve over rice with chickpeas and tahini."],
  },
  {
    id: "l-beef-broccoli", name: "Beef & Broccoli Brown Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "beef",
    timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Classic beef and broccoli in soy-ginger over rice.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice.", "Stir-fry beef and broccoli with the sauce; serve over rice."],
  },
  {
    id: "l-chickpea-spinach-curry", name: "Chickpea & Spinach Curry with Rice", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Comforting chickpea and spinach curry over rice.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "spinach", quantity: "80 g" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "curry powder", quantity: "1 tbsp" },
    ],
    steps: ["Simmer chickpeas, tomato and curry powder 15 min.", "Stir in spinach; serve over rice."],
  },

  // ---- Dinners ----
  {
    id: "d-cod-quinoa", name: "Baked Cod with Lemon Quinoa & Asparagus", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Flaky baked cod with lemony quinoa and asparagus.",
    ingredients: [
      { name: "cod fillet", quantity: "170 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "asparagus", quantity: "150 g" },
      { name: "lemon", quantity: "1/2" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Bake cod and asparagus at 200°C for 15 min.", "Serve over lemon-dressed quinoa."],
  },
  {
    id: "d-turkey-meatballs", name: "Turkey Meatballs with Whole-Wheat Pasta", type: "dinner",
    cuisine: "italian", mainProtein: "turkey",
    timeMinutes: 30, approxCost: 2,
    dietTags: [],
    description: "Lean turkey meatballs in tomato sauce over whole-wheat pasta.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "whole-wheat pasta", quantity: "80 g dry" },
      { name: "tomato sauce", quantity: "150 g" },
      { name: "parmesan", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roll and bake turkey meatballs 15 min.", "Simmer in sauce; serve over pasta with parmesan."],
  },
  {
    id: "d-sheet-fajitas", name: "Sheet-Pan Chicken Fajitas", type: "dinner",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "One-pan chicken and peppers with warm tortillas.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "bell peppers", quantity: "2" },
      { name: "corn tortillas", quantity: "2" },
      { name: "black beans", quantity: "60 g" },
      { name: "fajita spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast spiced chicken and peppers on a sheet 20 min.", "Serve in tortillas with beans."],
  },
  {
    id: "d-lentil-bolognese", name: "Lentil Bolognese over Whole-Wheat Spaghetti", type: "dinner",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Rich lentil ragu over whole-wheat spaghetti.",
    ingredients: [
      { name: "lentils", quantity: "150 g cooked" },
      { name: "whole-wheat spaghetti", quantity: "80 g dry" },
      { name: "chopped tomatoes", quantity: "1 can" },
      { name: "onion", quantity: "1/2" },
    ],
    steps: ["Simmer lentils, onion and tomatoes 20 min.", "Serve over cooked spaghetti."],
  },
  {
    id: "d-teriyaki-salmon", name: "Teriyaki Salmon with Broccoli & Rice", type: "dinner",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Glazed salmon with steamed broccoli over rice.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Bake salmon glazed with teriyaki 12 min.", "Serve with steamed broccoli and rice."],
  },
  {
    id: "d-beef-chili", name: "Beef & Bean Chili with Sweet Potato", type: "dinner",
    cuisine: "american", mainProtein: "beef",
    timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Hearty chili with lean beef, beans and sweet potato.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "kidney beans", quantity: "120 g" },
      { name: "sweet potato", quantity: "1 small" },
      { name: "chopped tomatoes", quantity: "1 can" },
      { name: "chili powder", quantity: "1 tbsp" },
    ],
    steps: ["Brown beef; add sweet potato, beans, tomatoes and chili.", "Simmer 25 min until thick."],
  },
  {
    id: "d-tofu-katsu", name: "Baked Tofu Katsu with Cabbage Slaw", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crispy baked tofu cutlet with a crunchy slaw and rice.",
    ingredients: [
      { name: "firm tofu", quantity: "160 g" },
      { name: "panko", quantity: "40 g" },
      { name: "cabbage", quantity: "100 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Coat tofu slabs in panko; bake at 210°C for 20 min.", "Serve with slaw and rice."],
  },
  {
    id: "d-chickpea-tagine", name: "Moroccan Chickpea & Vegetable Tagine", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian"], // NOT gluten_free: it is served over couscous (wheat)
    description: "Fragrant chickpea and vegetable tagine over couscous.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "carrot", quantity: "1" },
      { name: "zucchini", quantity: "1" },
      { name: "couscous", quantity: "60 g dry" },
      { name: "ras el hanout", quantity: "1 tbsp" },
    ],
    steps: ["Simmer chickpeas and vegetables with spice 20 min.", "Serve over couscous."],
  },
  {
    id: "d-pork-brussels", name: "Pork Tenderloin with Brussels & Rice", type: "dinner",
    cuisine: "american", mainProtein: "pork",
    timeMinutes: 30, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Roast pork with caramelized Brussels sprouts and brown rice.",
    ingredients: [
      { name: "pork tenderloin", quantity: "160 g" },
      { name: "Brussels sprouts", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast pork and Brussels at 200°C for 20 min.", "Serve with cooked brown rice."],
  },
  {
    id: "d-chicken-souvlaki", name: "Grilled Chicken Souvlaki with Greek Salad", type: "dinner",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Lemon-oregano chicken skewers with a crisp Greek salad.",
    ingredients: [
      { name: "chicken breast", quantity: "170 g" },
      { name: "cucumber", quantity: "1/2" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "feta", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Grill lemon-oregano chicken skewers.", "Toss cucumber, tomatoes and feta; serve alongside."],
  },

  // ===== Batch 3 — curated, high-protein & high-fiber =====

  // ---- Breakfasts ----
  {
    id: "b-mushroom-frittata", name: "Mushroom & Goat Cheese Frittata", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Oven frittata with mushrooms, spinach and goat cheese.",
    ingredients: [
      { name: "eggs", quantity: "4" },
      { name: "mushrooms", quantity: "100 g" },
      { name: "spinach", quantity: "50 g" },
      { name: "goat cheese", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Sauté mushrooms and spinach.", "Add whisked eggs and goat cheese; bake at 190°C for 12 min."],
  },
  {
    id: "b-apple-porridge", name: "Apple Cinnamon Protein Porridge", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Creamy oats with grated apple, cinnamon and protein.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "milk", quantity: "250 ml" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "apple", quantity: "1" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Simmer oats in milk with grated apple and cinnamon.", "Stir in protein powder off the heat."],
  },
  {
    id: "b-huevos-rancheros", name: "Huevos Rancheros", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Fried eggs over black beans and salsa on a corn tortilla.",
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "black beans", quantity: "100 g" },
      { name: "corn tortillas", quantity: "2" },
      { name: "salsa", quantity: "3 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Warm beans and tortillas.", "Top with fried eggs and salsa."],
  },
  {
    id: "b-tofu-kale-toast", name: "Scrambled Tofu & Kale Toast", type: "breakfast",
    cuisine: "american", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Turmeric tofu scramble with kale on whole-grain toast.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "kale", quantity: "50 g" },
      { name: "whole-grain toast", quantity: "1 slice" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Scramble crumbled tofu with turmeric and kale.", "Serve on toasted bread."],
  },
  {
    id: "b-salmon-breakfast-bowl", name: "Savory Salmon & Avocado Breakfast Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 12, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Rice bowl with flaked salmon, avocado and sesame.",
    ingredients: [
      { name: "salmon fillet", quantity: "120 g" },
      { name: "brown rice", quantity: "60 g dry" },
      { name: "avocado", quantity: "1/2" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Cook rice; pan-sear the salmon.", "Top with avocado and sesame."],
  },
  {
    id: "b-banana-muffins", name: "Banana Walnut Protein Muffins", type: "breakfast",
    cuisine: "american", mainProtein: "dairy", servings: 3, // a muffin-tin batch (~6 muffins, 2 per serving)
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Oat-based banana muffins boosted with protein and walnuts.",
    ingredients: [
      { name: "oat flour", quantity: "80 g" },
      { name: "banana", quantity: "2" },
      { name: "eggs", quantity: "2" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "walnuts", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Mash bananas; mix with all ingredients.", "Bake in a muffin tin at 180°C for 18 min."],
  },
  {
    id: "b-menemen", name: "Turkish Menemen", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Soft eggs cooked in a spiced pepper and tomato base.",
    ingredients: [
      { name: "eggs", quantity: "3" },
      { name: "bell pepper", quantity: "1" },
      { name: "tomatoes", quantity: "2" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften peppers and tomatoes in oil.", "Add eggs; stir gently until just set."],
  },
  {
    id: "b-edamame-egg-bowl", name: "Edamame & Egg Breakfast Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Soft-boiled eggs over rice with edamame and soy.",
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "brown rice", quantity: "60 g dry" },
      { name: "edamame", quantity: "80 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice; soft-boil the eggs.", "Top with edamame and a splash of soy."],
  },
  {
    id: "b-pumpkin-muesli", name: "Pumpkin Seed Muesli with Yogurt", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Toasted muesli with pumpkin seeds over Greek yogurt.",
    ingredients: [
      { name: "Greek yogurt", quantity: "180 g" },
      { name: "muesli", quantity: "40 g" },
      { name: "pumpkin seeds", quantity: "15 g" },
      { name: "berries", quantity: "80 g" },
    ],
    steps: ["Spoon yogurt into a bowl.", "Top with muesli, seeds and berries."],
  },

  // ---- Lunches ----
  {
    id: "l-chicken-caesar-wrap", name: "Grilled Chicken Caesar Wrap", type: "lunch",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 2,
    dietTags: [],
    description: "Grilled chicken, romaine and light Caesar in a wrap.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "romaine", quantity: "60 g" },
      { name: "light Caesar dressing", quantity: "1 tbsp" },
      { name: "parmesan", quantity: "10 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Grill and slice the chicken.", "Toss with romaine, dressing and parmesan; wrap."],
  },
  {
    id: "l-miso-soba", name: "Miso Salmon Soba Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Miso-glazed salmon over soba noodles with greens.",
    ingredients: [
      { name: "salmon fillet", quantity: "140 g" },
      { name: "soba noodles", quantity: "80 g dry" },
      { name: "pak choi", quantity: "100 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook soba; glaze and bake salmon with miso.", "Serve over noodles with wilted greens."],
  },
  {
    id: "l-falafel-plate", name: "Falafel & Tabbouleh Plate", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Baked falafel with bulgur tabbouleh and tahini.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "bulgur", quantity: "60 g dry" },
      { name: "parsley", quantity: "30 g" },
      { name: "tahini", quantity: "1 tbsp" },
    ],
    steps: ["Blend chickpeas into patties; bake 20 min.", "Serve with tabbouleh and tahini."],
  },
  {
    id: "l-stuffed-peppers", name: "Turkey & Quinoa Stuffed Peppers", type: "lunch",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Bell peppers stuffed with turkey, quinoa and tomato.",
    ingredients: [
      { name: "ground turkey", quantity: "140 g" },
      { name: "quinoa", quantity: "60 g dry" },
      { name: "bell peppers", quantity: "2" },
      { name: "tomato sauce", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Brown turkey; mix with cooked quinoa and sauce.", "Stuff peppers; bake at 190°C for 20 min."],
  },
  {
    id: "l-thai-peanut-chicken", name: "Thai Peanut Chicken Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Chicken and crunchy veg with peanut sauce over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "carrot", quantity: "1" },
      { name: "peanut butter", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice; sauté chicken and carrot.", "Toss with a thinned peanut sauce; serve over rice."],
  },
  {
    id: "l-med-tuna-quinoa", name: "Mediterranean Tuna Quinoa Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Quinoa salad with tuna, olives and cherry tomatoes.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olives", quantity: "30 g" },
      { name: "lemon", quantity: "1/2" },
    ],
    steps: ["Cook and cool the quinoa.", "Fold in tuna, tomatoes, olives and lemon."],
  },
  {
    id: "l-sweet-potato-tacos", name: "Black Bean & Sweet Potato Tacos", type: "lunch",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Roasted sweet potato and black bean tacos with slaw.",
    ingredients: [
      { name: "sweet potato", quantity: "1" },
      { name: "black beans", quantity: "120 g" },
      { name: "corn tortillas", quantity: "3" },
      { name: "cabbage", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast diced sweet potato with spices.", "Fill tortillas with beans, potato and slaw."],
  },
  {
    id: "l-beef-kofta-bulgur", name: "Beef Kofta & Bulgur Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "beef",
    timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Spiced beef kofta over bulgur with cucumber-yogurt.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "bulgur", quantity: "70 g dry" },
      { name: "cucumber", quantity: "1/2" },
      { name: "yogurt", quantity: "2 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Shape spiced beef into kofta; grill.", "Serve over bulgur with cucumber-yogurt."],
  },
  {
    id: "l-egg-avocado-salad", name: "Egg & Avocado Protein Salad", type: "lunch",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Hearty salad of egg, avocado, chickpeas and greens.",
    ingredients: [
      { name: "eggs", quantity: "3" },
      { name: "avocado", quantity: "1/2" },
      { name: "chickpeas", quantity: "80 g" },
      { name: "mixed greens", quantity: "60 g" },
    ],
    steps: ["Boil the eggs.", "Toss with avocado, chickpeas and greens."],
  },
  {
    id: "l-tempeh-teriyaki", name: "Tempeh Teriyaki Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Caramelized tempeh with broccoli over rice.",
    ingredients: [
      { name: "tempeh", quantity: "140 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "broccoli", quantity: "120 g" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice; pan-fry tempeh and glaze with teriyaki.", "Serve with steamed broccoli."],
  },

  // ---- Dinners ----
  {
    id: "d-chicken-parm", name: "Baked Chicken Parmesan with Zucchini", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 30, approxCost: 2,
    dietTags: [],
    description: "Lighter baked chicken parm with roasted zucchini.",
    ingredients: [
      { name: "chicken breast", quantity: "170 g" },
      { name: "tomato sauce", quantity: "120 g" },
      { name: "mozzarella", quantity: "40 g" },
      { name: "zucchini", quantity: "1" },
      { name: "panko", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Coat chicken in panko; bake 15 min.", "Top with sauce and mozzarella; bake 8 min with zucchini."],
  },
  {
    id: "d-garlic-shrimp-quinoa", name: "Garlic Shrimp & Quinoa with Spinach", type: "dinner",
    cuisine: "mediterranean", mainProtein: "shrimp",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Garlicky shrimp over quinoa with wilted spinach.",
    ingredients: [
      { name: "shrimp", quantity: "150 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "spinach", quantity: "80 g" },
      { name: "garlic", quantity: "3 cloves" },
    ],
    steps: ["Cook quinoa.", "Sauté shrimp with garlic; fold in spinach and serve over quinoa."],
  },
  {
    id: "d-turkey-taco-skillet", name: "Turkey Taco Skillet with Beans", type: "dinner",
    cuisine: "mexican", mainProtein: "turkey",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "One-pan turkey taco filling with beans, corn and rice.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "corn", quantity: "60 g" },
      { name: "brown rice", quantity: "60 g dry" },
      { name: "taco spice", quantity: "1 tbsp" },
    ],
    steps: ["Brown turkey with taco spice.", "Add beans, corn and cooked rice; simmer to combine."],
  },
  {
    id: "d-miso-cod", name: "Miso-Glazed Cod with Bok Choy & Rice", type: "dinner",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Sweet-savory miso cod with bok choy over rice.",
    ingredients: [
      { name: "cod fillet", quantity: "170 g" },
      { name: "bok choy", quantity: "120 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Glaze cod with miso; bake 12 min.", "Serve with steamed bok choy and rice."],
  },
  {
    id: "d-red-lentil-dahl", name: "Red Lentil Dahl with Brown Rice", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Silky spiced red lentil dahl over brown rice.",
    ingredients: [
      { name: "red lentils", quantity: "120 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
      { name: "curry powder", quantity: "1 tbsp" },
    ],
    steps: ["Simmer lentils with tomato and spice 20 min.", "Serve over brown rice."],
  },
  {
    id: "d-steak-sweet-fries", name: "Steak with Sweet Potato Fries & Broccoli", type: "dinner",
    cuisine: "american", mainProtein: "beef",
    timeMinutes: 30, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Lean steak with oven sweet potato fries and broccoli.",
    ingredients: [
      { name: "lean steak", quantity: "150 g" },
      { name: "sweet potato", quantity: "1" },
      { name: "broccoli", quantity: "150 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast sweet potato fries 25 min.", "Sear the steak; steam broccoli; rest and slice."],
  },
  {
    id: "d-tofu-pad-thai", name: "Tofu Pad Thai", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Rice noodles with tofu, bean sprouts and peanuts.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "rice noodles", quantity: "80 g dry" },
      { name: "bean sprouts", quantity: "80 g" },
      { name: "peanuts", quantity: "15 g" },
      { name: "tamarind sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Soak noodles; stir-fry tofu.", "Toss with noodles, sprouts and sauce; top with peanuts."],
  },
  {
    id: "d-harissa-salmon", name: "Harissa Salmon Traybake with Chickpeas", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "fish",
    timeMinutes: 30, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Spicy harissa salmon roasted with chickpeas and peppers.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "chickpeas", quantity: "120 g" },
      { name: "bell pepper", quantity: "1" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toss chickpeas and peppers with harissa; roast 15 min.", "Add salmon; roast 12 min more."],
  },
  {
    id: "d-chicken-veg-stirfry", name: "Chicken & Vegetable Stir-Fry with Rice", type: "dinner",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Quick chicken stir-fry with mixed vegetables over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "mixed stir-fry veg", quantity: "160 g" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook rice.", "Stir-fry chicken and veg with sauce; serve over rice."],
  },
  {
    id: "d-stuffed-portobello", name: "Stuffed Portobello with Quinoa & Feta", type: "dinner",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Roasted portobello caps stuffed with quinoa, spinach and feta.",
    ingredients: [
      { name: "portobello mushrooms", quantity: "2 large" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "spinach", quantity: "60 g" },
      { name: "feta", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook quinoa; mix with wilted spinach and feta.", "Fill mushrooms; roast at 200°C for 18 min."],
  },

  // ===== Batch 4 — curated, high-protein & high-fiber =====

  // ---- Breakfasts ----
  {
    id: "b-egg-bean-quesadilla", name: "Cheesy Egg & Black Bean Quesadilla", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Griddled quesadilla with scrambled egg, beans and cheese.",
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "black beans", quantity: "80 g" },
      { name: "whole-wheat tortilla", quantity: "1" },
      { name: "cheddar", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Scramble eggs; mash beans.", "Fill tortilla with egg, beans and cheese; griddle until crisp."],
  },
  {
    id: "b-protein-french-toast", name: "Protein French Toast with Berries", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Egg-and-protein soaked toast topped with berries.",
    ingredients: [
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "eggs", quantity: "2" },
      { name: "milk", quantity: "60 ml" },
      { name: "mixed berries", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soak bread in egg-milk mix.", "Pan-fry until golden; top with berries."],
  },
  {
    id: "b-trout-bagel", name: "Smoked Trout & Cream Cheese Bagel", type: "breakfast",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 8, approxCost: 3,
    dietTags: [],
    description: "Wholegrain bagel with smoked trout and light cream cheese.",
    ingredients: [
      { name: "wholegrain bagel", quantity: "1" },
      { name: "smoked trout", quantity: "80 g" },
      { name: "light cream cheese", quantity: "2 tbsp" },
      { name: "cucumber", quantity: "1/2" },
    ],
    steps: ["Toast and spread the bagel.", "Layer trout and cucumber."],
  },
  {
    id: "b-sweet-potato-skillet", name: "Sweet Potato & Egg Breakfast Skillet", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Skillet of sweet potato, peppers and baked eggs.",
    ingredients: [
      { name: "sweet potato", quantity: "1 small" },
      { name: "eggs", quantity: "2" },
      { name: "bell pepper", quantity: "1" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Sauté diced sweet potato and pepper.", "Crack in eggs; cover and cook until set."],
  },
  {
    id: "b-blueberry-cottage", name: "Blueberry Cottage Cheese Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "High-protein cottage cheese with blueberries and seeds.",
    ingredients: [
      { name: "cottage cheese", quantity: "200 g" },
      { name: "blueberries", quantity: "80 g" },
      { name: "pumpkin seeds", quantity: "15 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon cottage cheese into a bowl.", "Top with blueberries, seeds and honey."],
  },
  {
    id: "b-zucchini-fritters", name: "Zucchini & Feta Egg Fritters", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 18, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Pan-fried zucchini and feta fritters bound with egg.",
    ingredients: [
      { name: "zucchini", quantity: "1" },
      { name: "eggs", quantity: "2" },
      { name: "feta", quantity: "40 g" },
      { name: "chickpea flour", quantity: "2 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Grate and squeeze zucchini; mix with egg, feta and flour.", "Fry spoonfuls until golden."],
  },
  {
    id: "b-ab-banana-toast", name: "Almond Butter & Banana Protein Toast", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Toast with almond butter, banana and a yogurt side.",
    ingredients: [
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "almond butter", quantity: "1 tbsp" },
      { name: "banana", quantity: "1" },
      { name: "Greek yogurt", quantity: "100 g" },
    ],
    steps: ["Spread almond butter on toast; add banana.", "Serve with a side of yogurt."],
  },
  {
    id: "b-tofu-breakfast-tacos", name: "Chorizo-Style Tofu Breakfast Tacos", type: "breakfast",
    cuisine: "mexican", mainProtein: "tofu",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced tofu crumble with beans in corn tortillas.",
    ingredients: [
      { name: "firm tofu", quantity: "140 g" },
      { name: "corn tortillas", quantity: "2" },
      { name: "black beans", quantity: "60 g" },
      { name: "smoked paprika", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Fry crumbled tofu with paprika and spices.", "Fill tortillas with tofu and beans."],
  },
  {
    id: "b-matcha-chia", name: "Matcha Chia Protein Pudding", type: "breakfast",
    cuisine: "asian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Chia pudding whisked with matcha and vanilla protein.",
    ingredients: [
      { name: "chia seeds", quantity: "3 tbsp" },
      { name: "milk", quantity: "220 ml" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "matcha", quantity: "1 tsp" },
    ],
    steps: ["Whisk chia, milk, protein and matcha.", "Chill until set; top with fruit."],
  },
  {
    id: "b-eggwhite-wrap", name: "Egg White & Veggie Breakfast Wrap", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Fluffy egg whites with peppers and spinach in a wrap.",
    ingredients: [
      { name: "egg whites", quantity: "5" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "bell pepper", quantity: "1/2" },
      { name: "spinach", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Scramble egg whites with peppers and spinach.", "Fill the wrap and roll."],
  },
  {
    id: "b-ricotta-toast", name: "Ricotta & Honey Toast with Walnuts", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Creamy ricotta on toast with honey and walnuts.",
    ingredients: [
      { name: "sourdough bread", quantity: "2 slices" },
      { name: "ricotta", quantity: "100 g" },
      { name: "walnuts", quantity: "20 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Toast the bread; spread ricotta.", "Top with walnuts and a drizzle of honey."],
  },
  {
    id: "b-kimchi-tofu", name: "Kimchi Tofu Scramble Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Savory tofu scramble with kimchi over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "kimchi", quantity: "60 g" },
      { name: "brown rice", quantity: "60 g dry" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Scramble tofu in sesame oil.", "Serve over rice with kimchi."],
  },
  {
    id: "b-baked-oatmeal", name: "Baked Oatmeal with Apple & Pecan", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Warm baked oats with apple, cinnamon and pecans.",
    ingredients: [
      { name: "rolled oats", quantity: "70 g" },
      { name: "milk", quantity: "200 ml" },
      { name: "egg", quantity: "1" },
      { name: "apple", quantity: "1" },
      { name: "pecans", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Mix oats, milk, egg and apple.", "Bake at 180°C for 25 min; top with pecans."],
  },
  {
    id: "b-lentil-egg-skillet", name: "Lentil & Egg Breakfast Skillet", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 18, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Spiced lentils topped with baked eggs.",
    ingredients: [
      { name: "lentils", quantity: "120 g cooked" },
      { name: "eggs", quantity: "2" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
      { name: "cumin", quantity: "1 tsp" },
    ],
    steps: ["Simmer lentils with tomato and cumin.", "Make wells; crack in eggs and cook until set."],
  },
  {
    id: "b-protein-waffles", name: "Berry Protein Waffles", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Oat-protein waffles topped with berries and yogurt.",
    ingredients: [
      { name: "oat flour", quantity: "70 g" },
      { name: "egg", quantity: "1" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "mixed berries", quantity: "80 g" },
    ],
    steps: ["Whisk a batter of oat flour, egg and protein.", "Cook in a waffle iron; top with berries."],
  },

  // ---- Lunches ----
  {
    id: "l-chicken-fajita-quinoa", name: "Chicken Fajita Quinoa Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Fajita chicken and peppers over quinoa with beans.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "bell peppers", quantity: "1" },
      { name: "black beans", quantity: "70 g" },
      { name: "fajita spice", quantity: "1 tbsp" },
    ],
    steps: ["Cook quinoa; sauté spiced chicken and peppers.", "Assemble with beans."],
  },
  {
    id: "l-poached-salmon-lentil", name: "Poached Salmon & Green Lentil Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Flaked poached salmon over a lemony green lentil salad.",
    ingredients: [
      { name: "salmon fillet", quantity: "140 g" },
      { name: "green lentils", quantity: "150 g cooked" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "lemon", quantity: "1/2" },
    ],
    steps: ["Gently poach the salmon.", "Flake over lentils dressed with lemon and tomatoes."],
  },
  {
    id: "l-sesame-chicken-edamame", name: "Sesame Chicken & Edamame Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: [],
    description: "Sesame chicken with edamame over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "edamame", quantity: "80 g" },
      { name: "sesame-soy sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook rice; sauté chicken with sesame-soy.", "Serve with edamame."],
  },
  {
    id: "l-cauli-chickpea-wrap", name: "Roasted Cauliflower & Chickpea Shawarma Wrap", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Spiced roasted cauliflower and chickpeas in a wrap with tahini.",
    ingredients: [
      { name: "cauliflower", quantity: "150 g" },
      { name: "chickpeas", quantity: "120 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "tahini", quantity: "1 tbsp" },
    ],
    steps: ["Roast spiced cauliflower and chickpeas 20 min.", "Fill wrap; drizzle with tahini."],
  },
  {
    id: "l-turkey-cobb", name: "Turkey Cobb Salad", type: "lunch",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Turkey, egg, avocado and greens with a light dressing.",
    ingredients: [
      { name: "turkey breast", quantity: "130 g" },
      { name: "egg", quantity: "1" },
      { name: "avocado", quantity: "1/2" },
      { name: "mixed greens", quantity: "80 g" },
    ],
    steps: ["Arrange greens; top with sliced turkey, egg and avocado.", "Dress lightly."],
  },
  {
    id: "l-spicy-tuna-bowl", name: "Spicy Tuna & Avocado Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 12, approxCost: 2,
    dietTags: [],
    description: "Tuna with sriracha-yogurt and avocado over rice.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "avocado", quantity: "1/2" },
      { name: "sriracha", quantity: "1 tsp" },
    ],
    steps: ["Cook rice; mix tuna with sriracha and a little yogurt.", "Top with avocado."],
  },
  {
    id: "l-white-bean-chicken-soup", name: "White Bean & Kale Soup with Chicken", type: "lunch",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Brothy soup with chicken, white beans and kale.",
    ingredients: [
      { name: "chicken breast", quantity: "130 g" },
      { name: "cannellini beans", quantity: "120 g" },
      { name: "kale", quantity: "60 g" },
      { name: "carrot", quantity: "1" },
    ],
    steps: ["Simmer chicken, beans and carrot in stock 20 min.", "Add kale until wilted."],
  },
  {
    id: "l-greek-chicken-orzo", name: "Greek Chicken & Orzo Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Lemon-oregano chicken over orzo with cucumber and feta.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "orzo", quantity: "70 g dry" },
      { name: "cucumber", quantity: "1/2" },
      { name: "feta", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook orzo; grill lemon-oregano chicken.", "Combine with cucumber and feta."],
  },
  {
    id: "l-smoky-bean-quinoa", name: "Smoky Black Bean & Corn Quinoa Salad", type: "lunch",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Zesty quinoa salad with black beans, corn and lime.",
    ingredients: [
      { name: "quinoa", quantity: "80 g dry" },
      { name: "black beans", quantity: "120 g" },
      { name: "corn", quantity: "80 g" },
      { name: "lime", quantity: "1" },
    ],
    steps: ["Cook and cool quinoa.", "Fold in beans, corn, lime and smoked paprika."],
  },
  {
    id: "l-prawn-mango-noodle", name: "Prawn & Mango Rice Noodle Salad", type: "lunch",
    cuisine: "asian", mainProtein: "shrimp",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Cool rice noodles with prawns, mango and herbs.",
    ingredients: [
      { name: "prawns", quantity: "130 g" },
      { name: "rice noodles", quantity: "70 g dry" },
      { name: "mango", quantity: "80 g" },
      { name: "lime", quantity: "1/2" },
    ],
    steps: ["Soak noodles; poach prawns.", "Toss with mango, herbs and lime dressing."],
  },
  {
    id: "l-roast-beef-wrap", name: "Roast Beef & Horseradish Wrap", type: "lunch",
    cuisine: "american", mainProtein: "beef",
    timeMinutes: 8, approxCost: 3,
    dietTags: [],
    description: "Lean roast beef with horseradish and rocket in a wrap.",
    ingredients: [
      { name: "lean roast beef", quantity: "120 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "rocket", quantity: "40 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "horseradish", quantity: "1 tsp" },
    ],
    steps: ["Spread horseradish on the wrap.", "Layer beef and rocket; roll and slice."],
  },
  {
    id: "l-halloumi-grain-bowl", name: "Halloumi & Chickpea Grain Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Grilled halloumi with chickpeas and roasted veg over grains.",
    ingredients: [
      { name: "halloumi", quantity: "80 g" },
      { name: "chickpeas", quantity: "100 g" },
      { name: "quinoa", quantity: "60 g dry" },
      { name: "roasted peppers", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Grill halloumi; warm chickpeas.", "Serve over quinoa with peppers."],
  },
  {
    id: "l-chicken-tikka-wrap", name: "Chicken Tikka Wrap with Yogurt Slaw", type: "lunch",
    cuisine: "indian", mainProtein: "chicken",
    timeMinutes: 22, approxCost: 2,
    dietTags: [],
    description: "Tikka-spiced chicken with a yogurt slaw in a wrap.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "cabbage", quantity: "60 g" },
      { name: "yogurt", quantity: "2 tbsp" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Sear tikka-spiced chicken.", "Fill wrap with chicken and yogurt slaw."],
  },
  {
    id: "l-lentil-feta-tabbouleh", name: "Lentil & Feta Tabbouleh", type: "lunch",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Herby bulgur tabbouleh with lentils and feta.",
    ingredients: [
      { name: "lentils", quantity: "120 g cooked" },
      { name: "bulgur", quantity: "50 g dry" },
      { name: "parsley", quantity: "30 g" },
      { name: "feta", quantity: "30 g" },
    ],
    steps: ["Cook bulgur; combine with lentils and parsley.", "Crumble feta on top."],
  },
  {
    id: "l-ginger-beef-cups", name: "Ginger Beef Lettuce Cups", type: "lunch",
    cuisine: "asian", mainProtein: "beef",
    timeMinutes: 18, approxCost: 3,
    dietTags: [],
    description: "Ginger-soy beef in lettuce cups with a side of rice.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "lettuce", quantity: "6 leaves" },
      { name: "brown rice", quantity: "50 g dry" },
      { name: "ginger-soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Stir-fry beef with ginger-soy.", "Spoon into lettuce cups; serve with rice."],
  },
  {
    id: "l-mackerel-beetroot", name: "Smoked Mackerel & Beetroot Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Omega-rich mackerel with beetroot and lentils.",
    ingredients: [
      { name: "smoked mackerel", quantity: "100 g" },
      { name: "cooked beetroot", quantity: "100 g" },
      { name: "green lentils", quantity: "100 g cooked" },
      { name: "mixed greens", quantity: "40 g" },
    ],
    steps: ["Flake mackerel over greens and lentils.", "Add beetroot; dress lightly."],
  },
  {
    id: "l-buffalo-chicken-bowl", name: "Buffalo Chicken & Chickpea Bowl", type: "lunch",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Buffalo-spiced chicken with chickpeas and slaw over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "chickpeas", quantity: "100 g" },
      { name: "brown rice", quantity: "60 g dry" },
      { name: "buffalo sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook rice; toss seared chicken in buffalo sauce.", "Serve with chickpeas and slaw."],
  },

  // ---- Dinners ----
  {
    id: "d-lemon-herb-chicken", name: "Lemon-Herb Chicken with Green Beans & Potatoes", type: "dinner",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Roast chicken with baby potatoes and green beans.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "lemon", quantity: "1/2" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast potatoes 20 min.", "Add chicken and beans; roast 15 min with lemon."],
  },
  {
    id: "d-shrimp-zoodle-scampi", name: "Shrimp & Zucchini Noodle Scampi", type: "dinner",
    cuisine: "italian", mainProtein: "shrimp",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Garlic-butter shrimp over zucchini noodles.",
    ingredients: [
      { name: "shrimp", quantity: "160 g" },
      { name: "zucchini", quantity: "2" },
      { name: "garlic", quantity: "3 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "butter", quantity: "1 tbsp" },
    ],
    steps: ["Spiralize zucchini.", "Sauté shrimp with garlic; toss with zoodles."],
  },
  {
    id: "d-turkey-meatball-bowl", name: "Turkey & Spinach Meatball Bowl", type: "dinner",
    cuisine: "mediterranean", mainProtein: "turkey",
    timeMinutes: 28, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Turkey-spinach meatballs over quinoa with tomato.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "spinach", quantity: "50 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "tomato sauce", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Bake turkey-spinach meatballs 15 min.", "Simmer in sauce; serve over quinoa."],
  },
  {
    id: "d-black-bean-enchilada", name: "Black Bean Enchilada Bake", type: "dinner",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 35, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Baked enchiladas filled with black beans and cheese.",
    ingredients: [
      { name: "black beans", quantity: "150 g" },
      { name: "corn tortillas", quantity: "3" },
      { name: "enchilada sauce", quantity: "150 g" },
      { name: "cheddar", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Fill and roll tortillas with beans.", "Top with sauce and cheese; bake 20 min."],
  },
  {
    id: "d-ginger-tofu-bokchoy", name: "Ginger-Soy Baked Tofu with Bok Choy & Rice", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Baked ginger-soy tofu with bok choy over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "160 g" },
      { name: "bok choy", quantity: "120 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "ginger-soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Bake glazed tofu 22 min.", "Serve with steamed bok choy and rice."],
  },
  {
    id: "d-cajun-salmon", name: "Cajun Salmon with Dirty Rice & Beans", type: "dinner",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Cajun-spiced salmon over rice with kidney beans.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "kidney beans", quantity: "100 g" },
      { name: "cajun spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Pan-sear cajun salmon.", "Stir beans through cooked rice; plate together."],
  },
  {
    id: "d-beef-kebabs-couscous", name: "Beef & Vegetable Kebabs with Couscous", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "beef",
    timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Grilled beef and pepper kebabs over couscous.",
    ingredients: [
      { name: "lean beef", quantity: "140 g" },
      { name: "bell peppers", quantity: "1" },
      { name: "red onion", quantity: "1/2" },
      { name: "couscous", quantity: "60 g dry" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Thread beef and veg; grill.", "Serve over fluffed couscous."],
  },
  {
    id: "d-chicken-tikka-masala", name: "Chicken Tikka Masala with Brown Rice", type: "dinner",
    cuisine: "indian", mainProtein: "chicken",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Creamy tomato tikka masala with chicken over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "tikka masala sauce", quantity: "150 g" },
      { name: "peas", quantity: "60 g" },
    ],
    steps: ["Simmer chicken in masala sauce 15 min.", "Stir in peas; serve over rice."],
  },
  {
    id: "d-cod-bean-stew", name: "Cod & Smoky Bean Stew", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Cod poached in a smoky tomato and white bean stew.",
    ingredients: [
      { name: "cod fillet", quantity: "170 g" },
      { name: "cannellini beans", quantity: "150 g" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
      { name: "smoked paprika", quantity: "1 tsp" },
    ],
    steps: ["Simmer beans, tomato and paprika.", "Nestle in cod; poach 10 min."],
  },
  {
    id: "d-tempeh-peanut-noodles", name: "Tempeh & Broccoli Peanut Noodles", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Tempeh and broccoli tossed in peanut sauce with noodles.",
    ingredients: [
      { name: "tempeh", quantity: "140 g" },
      { name: "rice noodles", quantity: "80 g dry" },
      { name: "broccoli", quantity: "120 g" },
      { name: "peanut butter", quantity: "1 tbsp" },
    ],
    steps: ["Cook noodles; pan-fry tempeh and broccoli.", "Toss with peanut sauce."],
  },
  {
    id: "d-stuffed-sweet-potato", name: "Stuffed Sweet Potato with Turkey Chili", type: "dinner",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Baked sweet potato loaded with lean turkey chili.",
    ingredients: [
      { name: "sweet potato", quantity: "1 large" },
      { name: "ground turkey", quantity: "130 g" },
      { name: "kidney beans", quantity: "80 g" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Bake sweet potato until soft.", "Simmer turkey chili; spoon over the split potato."],
  },
  {
    id: "d-pesto-chicken-penne", name: "Pesto Chicken with Whole-Wheat Penne & Peas", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "Pesto chicken tossed with whole-wheat penne and peas.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "whole-wheat penne", quantity: "80 g dry" },
      { name: "peas", quantity: "80 g" },
      { name: "pesto", quantity: "1 tbsp" },
    ],
    steps: ["Cook penne with peas.", "Toss with sliced pesto chicken."],
  },
  {
    id: "d-falafel-bowl", name: "Baked Falafel Bowl with Roasted Veg & Tahini", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Baked falafel over grains with roasted vegetables and tahini.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "quinoa", quantity: "60 g dry" },
      { name: "roasted vegetables", quantity: "150 g" },
      { name: "tahini", quantity: "1 tbsp" },
    ],
    steps: ["Bake falafel patties 20 min.", "Serve over quinoa with roasted veg and tahini."],
  },
  {
    id: "d-garlic-shrimp-farro", name: "Garlic Butter Shrimp with Rice & Asparagus", type: "dinner",
    cuisine: "mediterranean", mainProtein: "shrimp",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Garlicky shrimp with brown rice and asparagus.",
    ingredients: [
      { name: "shrimp", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "asparagus", quantity: "120 g" },
      { name: "garlic", quantity: "3 cloves" },
    ],
    steps: ["Cook brown rice.", "Sauté shrimp with garlic; add asparagus and combine."],
  },
  {
    id: "d-sausage-bean-traybake", name: "Pork Sausage, Peppers & White Bean Traybake", type: "dinner",
    cuisine: "italian", mainProtein: "pork",
    timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "One-tray lean pork sausage with peppers and white beans.",
    ingredients: [
      { name: "lean pork sausage", quantity: "140 g" },
      { name: "cannellini beans", quantity: "150 g" },
      { name: "bell peppers", quantity: "2" },
      { name: "red onion", quantity: "1" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toss sausage, peppers and onion on a tray; roast 25 min.", "Stir in beans; roast 8 min more."],
  },

  // ---- Snacks ----
  {
    id: "s-roasted-chickpeas", name: "Crunchy Roasted Chickpeas", type: "snack",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Crispy spiced roasted chickpeas.",
    ingredients: [
      { name: "chickpeas", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "paprika", quantity: "1 tsp" },
    ],
    steps: ["Toss chickpeas with oil and paprika.", "Roast at 200°C for 25 min until crisp."],
  },
  {
    id: "s-tuna-cucumber-boats", name: "Tuna Cucumber Boats", type: "snack",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Cucumber halves loaded with lemony tuna.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "cucumber", quantity: "1" },
      { name: "Greek yogurt", quantity: "1 tbsp" },
    ],
    steps: ["Mix tuna with yogurt and lemon.", "Spoon into halved, hollowed cucumber."],
  },
  {
    id: "s-protein-balls", name: "Chocolate Peanut Protein Balls", type: "snack",
    cuisine: "american", mainProtein: "dairy", servings: 2, // a tray of balls (~6 balls, 3 per serving)
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "No-bake oat, peanut and protein bites.",
    ingredients: [
      { name: "rolled oats", quantity: "40 g" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "protein powder", quantity: "1/2 scoop" },
      { name: "cocoa", quantity: "1 tsp" },
    ],
    steps: ["Mix everything into a dough.", "Roll into balls; chill 15 min."],
  },

  // Keto snacks. Without these, a keto user on 4 meals/day silently received only 3: no snack
  // recipe carried the keto tag, the slot found no candidate, and the meal was quietly dropped.
  {
    id: "s-keto-eggs-avocado", name: "Boiled Eggs & Avocado", type: "snack",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["keto", "vegetarian", "gluten_free"],
    description: "Jammy boiled eggs with avocado and olive oil.",
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "avocado", quantity: "1/2" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Boil the eggs 7 min.", "Halve the avocado; drizzle with oil."],
  },
  {
    id: "s-keto-cheese-almonds", name: "Cheddar & Almonds", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 2, approxCost: 2,
    dietTags: ["keto", "vegetarian", "gluten_free"],
    description: "Sharp cheddar with toasted almonds.",
    ingredients: [
      { name: "cheddar", quantity: "40 g" },
      { name: "almonds", quantity: "25 g" },
    ],
    steps: ["Cube the cheddar.", "Toast the almonds briefly."],
  },

  // ---- Treats (treatOnly: never auto-selected; only via an explicit request) ----
  {
    id: "t-pizza", name: "Pepperoni & Mozzarella Pizza", type: "dinner",
    cuisine: "italian", mainProtein: "dairy", treatOnly: true,
    timeMinutes: 20, approxCost: 2,
    dietTags: [],
    description: "Proper cheat-day pizza — crisp base, tomato, mozzarella.",
    ingredients: [
      { name: "pizza base", quantity: "150 g" },
      { name: "tomato sauce", quantity: "80 g" },
      { name: "mozzarella", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Heat the oven as hot as it goes.", "Top the base with sauce and mozzarella.", "Bake 10-12 min until blistered."],
  },
  {
    id: "t-cheeseburger", name: "Cheeseburger & Fries", type: "dinner",
    cuisine: "american", mainProtein: "beef", treatOnly: true,
    timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "Beef patty, melted cheddar, soft bun and oven fries.",
    ingredients: [
      { name: "lean ground beef", quantity: "150 g" },
      { name: "burger bun", quantity: "1" },
      { name: "cheddar", quantity: "30 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast the potato fries 20 min.", "Sear the patty 3 min a side; melt cheddar on top.", "Build the burger."],
  },
  {
    id: "t-mac-cheese", name: "Baked Mac and Cheese", type: "dinner",
    cuisine: "american", mainProtein: "dairy", treatOnly: true,
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Molten cheddar sauce, baked until bubbling.",
    ingredients: [
      { name: "whole-wheat pasta", quantity: "90 g dry" },
      { name: "cheddar", quantity: "70 g" },
      { name: "milk", quantity: "200 ml" },
      { name: "butter", quantity: "1 tbsp" },
    ],
    steps: ["Boil the pasta.", "Melt butter, milk and cheddar into a sauce.", "Combine and bake 15 min."],
  },
  {
    id: "t-fried-chicken", name: "Crispy Fried Chicken", type: "dinner",
    cuisine: "american", mainProtein: "chicken", treatOnly: true,
    timeMinutes: 30, approxCost: 2,
    dietTags: [],
    description: "Buttermilk-style crunch, unapologetically fried.",
    ingredients: [
      { name: "chicken thigh", quantity: "200 g" },
      { name: "panko", quantity: "60 g" },
      { name: "eggs", quantity: "1" },
      { name: "olive oil", quantity: "2 tbsp" },
    ],
    steps: ["Egg-wash then coat the chicken in panko.", "Shallow-fry until deep golden and cooked through."],
  },
  {
    id: "t-nachos", name: "Loaded Cheesy Nachos", type: "dinner",
    cuisine: "mexican", mainProtein: "dairy", treatOnly: true,
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Tortilla chips buried under cheddar, beans and salsa.",
    ingredients: [
      { name: "corn tortillas", quantity: "4 pieces" },
      { name: "cheddar", quantity: "60 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cut and bake the tortillas into chips.", "Layer with beans and cheddar; bake until melted.", "Spoon over salsa."],
  },
  {
    id: "t-ice-cream", name: "Chocolate Ice Cream Sundae", type: "snack",
    cuisine: "american", mainProtein: "dairy", treatOnly: true,
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Ice cream, chocolate sauce, done.",
    ingredients: [
      { name: "ice cream", quantity: "150 g" },
      { name: "cocoa", quantity: "1 tbsp" },
      { name: "peanuts", quantity: "15 g" },
    ],
    steps: ["Scoop the ice cream.", "Dust with cocoa and scatter peanuts."],
  },
  {
    id: "b-tofu-edamame-scramble", name: "Tofu & Edamame Scramble Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Turmeric tofu scrambled with edamame and spinach.",
    ingredients: [
      { name: "firm tofu", quantity: "250 g" },
      { name: "edamame", quantity: "100 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "sesame oil", quantity: "1 tsp" },
      { name: "turmeric", quantity: "1 tsp" },
    ],
    steps: ["Crumble and fry the tofu with turmeric.", "Fold through edamame and spinach until wilted."],
  },
  {
    id: "b-vegan-protein-oats", name: "Peanut Butter & Seed Oats", type: "breakfast",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Oats with peanut butter, pumpkin seeds and chia.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "peanut butter", quantity: "2 tbsp" },
      { name: "pumpkin seeds", quantity: "20 g" },
      { name: "chia seeds", quantity: "1 tbsp" },
    ],
    steps: ["Cook the oats.", "Stir in the peanut butter; top with seeds and chia."],
  },
  {
    id: "l-tofu-poke", name: "Tofu Poke Bowl with Edamame", type: "lunch",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Marinated tofu, edamame and cucumber over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "220 g" },
      { name: "edamame", quantity: "100 g" },
      { name: "brown rice", quantity: "50 g dry" },
      { name: "cucumber", quantity: "1/2 piece" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Cook the rice.", "Marinate tofu in soy and sesame; top with edamame and cucumber."],
  },
  {
    id: "l-tempeh-quinoa-bowl", name: "Tempeh & Quinoa Protein Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "tofu",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Seared tempeh over quinoa with broccoli and tahini.",
    ingredients: [
      { name: "tempeh", quantity: "160 g" },
      { name: "quinoa", quantity: "60 g dry" },
      { name: "broccoli", quantity: "120 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Cook the quinoa; steam the broccoli.", "Sear the tempeh; drizzle with tahini."],
  },
  {
    id: "d-red-lentil-tofu-curry", name: "Red Lentil & Tofu Curry", type: "dinner",
    cuisine: "indian", mainProtein: "tofu",
    timeMinutes: 28, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Red lentils simmered with tofu, tomatoes and spinach.",
    ingredients: [
      { name: "red lentils", quantity: "90 g dry" },
      { name: "firm tofu", quantity: "200 g" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
      { name: "spinach", quantity: "60 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Fry the curry powder; add lentils and tomatoes.", "Simmer, then fold in tofu and spinach."],
  },
  {
    id: "d-tempeh-soba", name: "Tempeh & Broccoli Soba Bowl", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Seared tempeh and broccoli tossed through soba noodles.",
    ingredients: [
      { name: "tempeh", quantity: "180 g" },
      { name: "soba noodles", quantity: "70 g dry" },
      { name: "broccoli", quantity: "140 g" },
      { name: "soy-ginger sauce", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook the soba; blanch the broccoli.", "Stir-fry tempeh with the sauce; toss everything together."],
  },
  {
    id: "s-edamame-seeds", name: "Edamame & Pumpkin Seeds", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Steamed edamame with toasted pumpkin seeds.",
    ingredients: [
      { name: "edamame", quantity: "120 g" },
      { name: "pumpkin seeds", quantity: "20 g" },
    ],
    steps: ["Steam the edamame.", "Scatter over the pumpkin seeds."],
  },
  {
    id: "b-tofu-protein-smoothie", name: "Berry Tofu Breakfast Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "tofu",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Silken tofu blended with berries, almond butter and chia.",
    ingredients: [
      { name: "firm tofu", quantity: "260 g" },
      { name: "mixed berries", quantity: "100 g" },
      { name: "almond butter", quantity: "1 tbsp" },
      { name: "chia seeds", quantity: "1 tbsp" },
    ],
    steps: ["Blend the tofu with half the berries and the almond butter.", "Top with the rest and the chia."],
  },
  {
    // The library's whey "protein powder" is fine for a vegetarian, but a vegan couldn't reach for
    // a scoop of anything: there was no plant protein in the USDA table, which capped how much
    // protein a vegan breakfast could carry. Soy protein powder (fdcId 173181, B12-free so it
    // never masks the one deficiency vegans actually have) fixes that, and this is the dish that
    // uses it.
    id: "b-soy-protein-shake-bowl", name: "Vegan Berry Protein Shake Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "tofu",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "A thick soy-protein shake bowl with banana, berries, almond butter and chia.",
    ingredients: [
      { name: "soy protein powder", quantity: "1 scoop" },
      { name: "banana", quantity: "1" },
      { name: "mixed berries", quantity: "100 g" },
      { name: "almond butter", quantity: "1 tbsp" },
      { name: "chia seeds", quantity: "1 tbsp" },
    ],
    steps: ["Blend the soy protein powder, banana, half the berries and the almond butter with a little water.", "Pour into a bowl; top with the rest of the berries and the chia."],
  },
  {
    id: "l-tempeh-edamame-salad", name: "Tempeh & Edamame Power Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "tofu",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Seared tempeh and edamame over greens.",
    ingredients: [
      { name: "tempeh", quantity: "150 g" },
      { name: "edamame", quantity: "100 g" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Sear the tempeh until golden.", "Toss with edamame, greens and tomatoes."],
  },
  {
    id: "d-tempeh-bolognese", name: "Tempeh Bolognese", type: "dinner",
    cuisine: "italian", mainProtein: "tofu",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crumbled tempeh simmered in tomato sauce over spaghetti.",
    ingredients: [
      { name: "tempeh", quantity: "190 g" },
      { name: "whole-wheat spaghetti", quantity: "70 g dry" },
      { name: "tomato sauce", quantity: "150 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook the spaghetti.", "Crumble and brown the tempeh; simmer in the sauce."],
  },
  {
    id: "b-keto-salmon-avocado", name: "Smoked Salmon & Avocado Plate", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 5, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Smoked salmon with avocado, cream cheese and rocket.",
    ingredients: [
      { name: "smoked salmon", quantity: "100 g" },
      { name: "avocado", quantity: "1 piece" },
      { name: "cream cheese", quantity: "30 g" },
      { name: "rocket", quantity: "30 g" },
    ],
    steps: ["Slice the avocado.", "Plate with the salmon, cream cheese and rocket."],
  },
  {
    id: "b-keto-halloumi-egg", name: "Halloumi & Egg Skillet", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["keto", "vegetarian", "gluten_free"],
    description: "Seared halloumi with eggs and wilted spinach.",
    ingredients: [
      { name: "halloumi", quantity: "80 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "spinach", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Sear the halloumi until golden.", "Fry the eggs alongside; wilt the spinach."],
  },
  {
    id: "b-keto-cottage-walnut", name: "Cottage Cheese & Walnut Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["keto", "vegetarian", "gluten_free"],
    description: "Cottage cheese with walnuts and chia.",
    ingredients: [
      { name: "cottage cheese", quantity: "220 g" },
      { name: "walnuts", quantity: "25 g" },
      { name: "chia seeds", quantity: "1 tsp" },
    ],
    steps: ["Spoon the cottage cheese into a bowl.", "Top with walnuts and chia."],
  },
  {
    id: "b-keto-mushroom-cheddar", name: "Mushroom & Cheddar Omelette", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["keto", "vegetarian", "gluten_free"],
    description: "Three-egg omelette with mushrooms and cheddar.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "mushrooms", quantity: "100 g" },
      { name: "cheddar", quantity: "30 g" },
      { name: "butter", quantity: "1 tsp" },
    ],
    steps: ["Fry the mushrooms in butter.", "Pour over the eggs; fold with the cheddar."],
  },
  {
    id: "l-keto-tuna-avocado", name: "Tuna & Avocado Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Flaked tuna with avocado over greens.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "avocado", quantity: "1 piece" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Flake the tuna over the greens.", "Add avocado; dress with olive oil."],
  },
  {
    id: "l-keto-chicken-caesar", name: "Chicken Caesar, No Croutons", type: "lunch",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Grilled chicken over romaine with parmesan.",
    ingredients: [
      { name: "chicken breast", quantity: "170 g" },
      { name: "romaine", quantity: "80 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "light caesar dressing", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Grill and slice the chicken.", "Toss the romaine with dressing; top with parmesan."],
  },
  {
    id: "l-keto-steak-rocket", name: "Steak & Rocket Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "beef",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Seared steak over rocket with cherry tomatoes.",
    ingredients: [
      { name: "lean steak", quantity: "190 g" },
      { name: "rocket", quantity: "50 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olives", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Sear the steak; rest and slice.", "Toss rocket and tomatoes in olive oil."],
  },
  {
    id: "l-keto-mackerel-cucumber", name: "Smoked Mackerel & Cucumber Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Smoked mackerel with cucumber and olives.",
    ingredients: [
      { name: "smoked mackerel", quantity: "120 g" },
      { name: "cucumber", quantity: "1 piece" },
      { name: "olives", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Flake the mackerel.", "Toss with cucumber, olives and oil."],
  },
  {
    id: "l-keto-halloumi-zucchini", name: "Halloumi & Zucchini Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["keto", "vegetarian", "gluten_free"],
    description: "Grilled halloumi and zucchini with olives.",
    ingredients: [
      { name: "halloumi", quantity: "110 g" },
      { name: "zucchini", quantity: "1 piece" },
      { name: "olives", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Grill the halloumi and zucchini.", "Scatter olives; dress with oil."],
  },
  {
    id: "l-keto-shrimp-lettuce", name: "Shrimp & Avocado Lettuce Cups", type: "lunch",
    cuisine: "asian", mainProtein: "shrimp",
    timeMinutes: 12, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Garlic shrimp and avocado in crisp lettuce.",
    ingredients: [
      { name: "shrimp", quantity: "160 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "romaine", quantity: "60 g" },
      { name: "lime", quantity: "1/2 piece" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Sear the shrimp with garlic.", "Spoon into lettuce cups with avocado and lime."],
  },
  {
    id: "d-keto-salmon-asparagus", name: "Garlic Butter Salmon with Asparagus", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Pan-seared salmon with asparagus in garlic butter.",
    ingredients: [
      { name: "salmon fillet", quantity: "170 g" },
      { name: "asparagus", quantity: "160 g" },
      { name: "butter", quantity: "1 tbsp" },
      { name: "garlic", quantity: "2 cloves" },
    ],
    steps: ["Sear the salmon skin-side down.", "Toss the asparagus in garlic butter."],
  },
  {
    id: "d-keto-chicken-cauliflower", name: "Chicken Thigh & Cauliflower Bake", type: "dinner",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Roast chicken thigh over cauliflower with parmesan.",
    ingredients: [
      { name: "chicken thigh", quantity: "180 g" },
      { name: "cauliflower", quantity: "200 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast the chicken and cauliflower 25 min.", "Scatter parmesan and return briefly."],
  },
  {
    id: "d-keto-beef-mushroom", name: "Beef & Mushroom Skillet", type: "dinner",
    cuisine: "american", mainProtein: "beef",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Seared beef with buttery mushrooms and spinach.",
    ingredients: [
      { name: "lean beef", quantity: "210 g" },
      { name: "mushrooms", quantity: "150 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "butter", quantity: "1 tbsp" },
      { name: "walnuts", quantity: "10 g" },
    ],
    steps: ["Sear the beef; set aside.", "Fry mushrooms in butter, wilt spinach, return the beef."],
  },
  {
    id: "d-keto-cod-green-beans", name: "Cod with Brown Butter & Green Beans", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Pan-fried cod with brown butter almonds and green beans.",
    ingredients: [
      { name: "cod fillet", quantity: "190 g" },
      { name: "green beans", quantity: "150 g" },
      { name: "butter", quantity: "1 tbsp" },
      { name: "almonds", quantity: "15 g" },
    ],
    steps: ["Pan-fry the cod.", "Brown the butter with almonds; pour over the beans."],
  },
  {
    id: "d-keto-pork-cabbage", name: "Pork & Cabbage Stir-Fry", type: "dinner",
    cuisine: "asian", mainProtein: "pork",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Pork tenderloin stir-fried with cabbage and sesame.",
    ingredients: [
      { name: "pork tenderloin", quantity: "180 g" },
      { name: "cabbage", quantity: "200 g" },
      { name: "sesame oil", quantity: "1 tbsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Stir-fry the pork until browned.", "Add cabbage; finish with sesame."],
  },
  {
    id: "b-med-yogurt-walnut", name: "Greek Yogurt with Walnuts & Honey", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["mediterranean", "vegetarian", "gluten_free"],
    description: "Thick yogurt with walnuts and a drizzle of honey.",
    ingredients: [
      { name: "greek yogurt", quantity: "220 g" },
      { name: "walnuts", quantity: "25 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon the yogurt into a bowl.", "Top with walnuts and honey."],
  },
  {
    id: "b-med-feta-tomato-eggs", name: "Feta & Tomato Egg Scramble", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["mediterranean", "vegetarian", "gluten_free"],
    description: "Soft eggs scrambled with feta and cherry tomatoes.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "feta", quantity: "40 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soften the tomatoes in oil.", "Scramble in the eggs; fold through the feta."],
  },
  {
    id: "b-med-ricotta-berry", name: "Ricotta & Berry Bowl", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["mediterranean", "vegetarian", "gluten_free"],
    description: "Whipped ricotta with berries and almonds.",
    ingredients: [
      { name: "ricotta", quantity: "180 g" },
      { name: "mixed berries", quantity: "100 g" },
      { name: "almonds", quantity: "20 g" },
    ],
    steps: ["Whip the ricotta.", "Top with berries and almonds."],
  },

  // =========================================================================
  // EXPANSION — written against the pool-size gaps in `npm run export:recipes`
  // (the "Gaps" sheet). Before this block: 4 filters were EMPTY (Indian,
  // Italian, Mexican and Middle-Eastern snacks) and 18 more sat under 7, which
  // is the size at which a single week is FORCED to repeat a dish.
  //
  // Two rules held throughout, both from WORKPLAN.md Phase 2:
  //  1. Only ingredients already curated in NUTRIENT_TABLE are used, so every
  //     macro traces to a real FDC id. Auto-matching new ingredients to USDA is
  //     unsafe (salmon fillet -> "Salmonberries") and is not done here.
  //  2. Macros are NOT written. They are derived from these quantities. Each
  //     dish was sized against its slot floor (breakfast 250 / lunch 340 /
  //     dinner 380 / snack 90 kcal) so nothing lands as an implausible meal.
  // =========================================================================

  // ---- Snacks: the collapsed dimension (was 9 total, the floor of nearly
  // every filter, and empty for four cuisines) ----
  {
    id: "s-masala-chickpea-cups", name: "Masala Chickpea Cups", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Warm spiced chickpeas with lemon and coriander.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "tikka spice", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Warm the chickpeas with the spice and oil.", "Finish with a squeeze of lemon."],
  },
  {
    id: "s-curried-lentil-dip", name: "Curried Lentil Dip", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Creamy spiced lentils with carrot sticks.",
    ingredients: [
      { name: "lentils", quantity: "150 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "carrot", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Mash the lentils with curry powder and oil.", "Serve with carrot sticks."],
  },
  {
    id: "s-spiced-yogurt-cucumber", name: "Cumin Yogurt & Cucumber", type: "snack",
    cuisine: "indian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Cool raita-style yogurt with toasted cumin.",
    ingredients: [
      { name: "greek yogurt", quantity: "170 g" },
      { name: "cucumber", quantity: "80 g" },
      { name: "cumin", quantity: "1 tsp" },
    ],
    steps: ["Toast the cumin briefly.", "Stir through yogurt with the diced cucumber."],
  },
  {
    id: "s-caprese-skewers", name: "Caprese Skewers", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Mozzarella, tomato and basil on sticks.",
    ingredients: [
      { name: "mozzarella", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "parsley", quantity: "5 g" },
    ],
    steps: ["Thread mozzarella and tomatoes onto skewers.", "Drizzle with oil and herbs."],
  },
  {
    id: "s-ricotta-honey-toast", name: "Ricotta & Honey Toast", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Whipped ricotta on toast with honey.",
    ingredients: [
      { name: "ricotta", quantity: "100 g" },
      { name: "sourdough bread", quantity: "1 slice" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Toast the bread.", "Spread ricotta and drizzle honey."],
  },
  {
    id: "s-parmesan-white-beans", name: "Parmesan White Beans", type: "snack",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Warm cannellini beans with parmesan and olive oil.",
    ingredients: [
      { name: "cannellini beans", quantity: "150 g" },
      { name: "parmesan", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "parsley", quantity: "5 g" },
    ],
    steps: ["Warm the beans through.", "Toss with parmesan, oil and parsley."],
  },
  {
    id: "s-black-bean-salsa-cups", name: "Black Bean & Salsa Cups", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Black beans with salsa, lime and corn.",
    ingredients: [
      { name: "black beans", quantity: "150 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "corn", quantity: "50 g" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Stir the beans through the salsa and corn.", "Finish with lime."],
  },
  {
    id: "s-guacamole-crudites", name: "Guacamole & Crudités", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Smashed avocado with lime, peppers to dip.",
    ingredients: [
      { name: "avocado", quantity: "1/2 piece" },
      { name: "lime", quantity: "1/4 piece" },
      { name: "bell pepper", quantity: "80 g" },
      { name: "black beans", quantity: "60 g" },
    ],
    steps: ["Smash the avocado with lime.", "Fold in beans; serve with pepper strips."],
  },
  {
    id: "s-chili-lime-corn", name: "Chili Lime Street Corn", type: "snack",
    cuisine: "mexican", mainProtein: "dairy",
    timeMinutes: 7, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Charred corn with lime, chili and feta.",
    ingredients: [
      { name: "corn", quantity: "140 g" },
      { name: "feta", quantity: "25 g" },
      { name: "chili powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Char the corn in a dry pan.", "Toss with chili, lime and crumbled feta."],
  },
  {
    id: "s-hummus-veg-plate", name: "Hummus & Veg Plate", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Hummus with cucumber and pepper batons.",
    ingredients: [
      { name: "hummus", quantity: "80 g" },
      { name: "cucumber", quantity: "80 g" },
      { name: "bell pepper", quantity: "80 g" },
    ],
    steps: ["Spoon out the hummus.", "Cut the vegetables into batons and dip."],
  },
  {
    id: "s-labneh-style-yogurt", name: "Za'atar Yogurt Bowl", type: "snack",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Thick yogurt with olive oil, spice and olives.",
    ingredients: [
      { name: "greek yogurt", quantity: "180 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "shawarma spice", quantity: "1 tsp" },
      { name: "olives", quantity: "20 g" },
    ],
    steps: ["Spoon the yogurt into a bowl.", "Swirl with oil, spice and olives."],
  },
  {
    id: "s-spiced-nut-mix", name: "Ras el Hanout Nut Mix", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Warm spiced almonds and pumpkin seeds.",
    ingredients: [
      { name: "almonds", quantity: "25 g" },
      { name: "pumpkin seeds", quantity: "20 g" },
      { name: "ras el hanout", quantity: "1 tsp" },
    ],
    steps: ["Toast the nuts and seeds.", "Toss with the spice while warm."],
  },
  {
    id: "s-edamame-sesame", name: "Sesame Edamame", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Steamed edamame with toasted sesame.",
    ingredients: [
      { name: "edamame", quantity: "180 g" },
      { name: "sesame seeds", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Steam the edamame.", "Toss with sesame oil and seeds."],
  },
  {
    id: "s-miso-tofu-bites", name: "Miso Tofu Bites", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Pan-crisped tofu cubes glazed with miso.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Crisp the tofu in the oil.", "Glaze with miso and scatter sesame."],
  },
  {
    id: "s-kimchi-rice-cakes", name: "Kimchi Tofu Scramble Cup", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Crumbled tofu with kimchi and spring onion.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "kimchi", quantity: "60 g" },
      { name: "chives", quantity: "10 g" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Crumble and fry the tofu.", "Fold through kimchi and chives."],
  },
  {
    id: "s-cottage-cheese-peach", name: "Cottage Cheese & Berries", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "High-protein cottage cheese with berries.",
    ingredients: [
      { name: "cottage cheese", quantity: "200 g" },
      { name: "mixed berries", quantity: "80 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon the cottage cheese into a bowl.", "Top with berries and honey."],
  },
  {
    id: "s-pb-apple-slices", name: "Peanut Butter Apple Slices", type: "snack",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Crisp apple with peanut butter and cinnamon.",
    ingredients: [
      { name: "apple", quantity: "1 piece" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Slice the apple.", "Spread with peanut butter and dust with cinnamon."],
  },
  {
    id: "s-turkey-cheese-rollups", name: "Turkey & Cheese Roll-Ups", type: "snack",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Sliced turkey rolled with cheddar and cucumber.",
    ingredients: [
      { name: "turkey breast", quantity: "120 g" },
      { name: "cheddar", quantity: "30 g" },
      { name: "cucumber", quantity: "60 g" },
    ],
    steps: ["Lay out the turkey slices.", "Roll around cheddar and cucumber batons."],
  },
  {
    id: "s-keto-egg-avocado", name: "Egg & Avocado Cups", type: "snack",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["keto", "gluten_free", "vegetarian"],
    description: "Boiled eggs with smashed avocado and paprika.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "smoked paprika", quantity: "1 tsp" },
    ],
    steps: ["Boil the eggs and halve them.", "Top with smashed avocado and paprika."],
  },
  {
    id: "s-keto-halloumi-bites", name: "Crispy Halloumi Bites", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 7, approxCost: 2,
    dietTags: ["keto", "gluten_free", "vegetarian", "mediterranean"],
    description: "Pan-fried halloumi with lemon.",
    ingredients: [
      { name: "halloumi", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Fry the halloumi until golden.", "Squeeze over lemon."],
  },
  {
    id: "s-vegan-choc-chia", name: "Cocoa Chia Pudding", type: "snack",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Chia soaked with cocoa and banana.",
    ingredients: [
      { name: "chia seeds", quantity: "30 g" },
      { name: "cocoa", quantity: "1 tbsp" },
      { name: "banana", quantity: "1 piece" },
    ],
    steps: ["Stir the chia and cocoa into water; rest 10 min.", "Top with sliced banana."],
  },
  {
    id: "s-vegan-trail-mix", name: "Walnut & Berry Trail Mix", type: "snack",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 2, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Walnuts, pumpkin seeds and dried berries.",
    ingredients: [
      { name: "walnuts", quantity: "20 g" },
      { name: "pumpkin seeds", quantity: "20 g" },
      { name: "blueberries", quantity: "60 g" },
    ],
    steps: ["Combine everything in a pot."],
  },
  {
    id: "s-med-tuna-olive", name: "Tuna & Olive Pot", type: "snack",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Flaked tuna with olives, tomato and lemon.",
    ingredients: [
      { name: "canned tuna", quantity: "100 g" },
      { name: "olives", quantity: "25 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Flake the tuna.", "Toss with olives, tomatoes and lemon."],
  },
  {
    id: "s-med-white-bean-tahini", name: "White Bean & Tahini Dip", type: "snack",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Smooth cannellini beans whipped with tahini.",
    ingredients: [
      { name: "cannellini beans", quantity: "150 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "cucumber", quantity: "70 g" },
    ],
    steps: ["Blend the beans with tahini and lemon.", "Serve with cucumber batons."],
  },
  {
    id: "s-gf-smoked-salmon-cucumber", name: "Smoked Salmon Cucumber Rounds", type: "snack",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 5, approxCost: 3,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Cucumber rounds topped with smoked salmon and cream cheese.",
    ingredients: [
      { name: "smoked salmon", quantity: "80 g" },
      { name: "light cream cheese", quantity: "40 g" },
      { name: "cucumber", quantity: "100 g" },
    ],
    steps: ["Slice the cucumber into rounds.", "Top with cream cheese and salmon."],
  },
  {
    id: "s-protein-oat-bites", name: "No-Bake Protein Oat Bites", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Oats rolled with peanut butter and protein powder.",
    ingredients: [
      { name: "rolled oats", quantity: "40 g" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Mix everything into a stiff dough.", "Roll into bites and chill."],
  },

  // ---- Indian: 7 recipes total across all slots before this ----
  {
    id: "b-indian-masala-omelette", name: "Masala Omelette", type: "breakfast",
    cuisine: "indian", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "keto"],
    description: "Three-egg omelette with onion, chilli and turmeric.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "onion", quantity: "50 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Fry the onion with turmeric.", "Pour in the eggs and cook until set."],
  },
  {
    id: "b-indian-chickpea-pancake", name: "Chickpea Flour Pancake", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Savoury besan pancake with onion and spices.",
    ingredients: [
      { name: "chickpea flour", quantity: "80 g" },
      { name: "onion", quantity: "60 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "spinach", quantity: "40 g" },
    ],
    steps: ["Whisk the flour with water and spices.", "Fry with onion and spinach until set."],
  },
  {
    id: "b-indian-spiced-oats", name: "Savoury Spiced Oats", type: "breakfast",
    cuisine: "indian", mainProtein: "dairy",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Oats simmered with curry spice and peas.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "milk", quantity: "200 ml" },
      { name: "peas", quantity: "60 g" },
      { name: "curry powder", quantity: "1 tsp" },
    ],
    steps: ["Simmer the oats in milk.", "Stir through peas and curry powder."],
  },
  {
    id: "l-indian-chana-bowl", name: "Chana Masala Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced chickpeas in tomato with brown rice.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "brown rice", quantity: "60 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Simmer the chickpeas with tomato and spice.", "Serve over cooked rice."],
  },
  {
    // "Chicken Tikka Wrap with Yogurt Slaw" already exists — a rice bowl, not a second wrap.
    id: "l-indian-egg-curry-bowl", name: "Egg Curry Rice Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "eggs",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Boiled eggs in a spiced tomato sauce over rice.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "brown rice", quantity: "60 g" },
      { name: "onion", quantity: "50 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Simmer onion, tomato and spice into a sauce.", "Halve the boiled eggs into it; serve over rice."],
  },
  {
    id: "l-indian-dal-spinach", name: "Spinach Dal", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Red lentils simmered with spinach and turmeric.",
    ingredients: [
      { name: "red lentils", quantity: "80 g" },
      { name: "spinach", quantity: "100 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "onion", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Simmer the lentils until soft.", "Wilt in the spinach with the spices."],
  },
  {
    id: "l-indian-tandoori-salad", name: "Tandoori Chicken Salad", type: "lunch",
    cuisine: "indian", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced grilled chicken over crunchy salad.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "mixed greens", quantity: "70 g" },
      { name: "cucumber", quantity: "70 g" },
      { name: "greek yogurt", quantity: "60 g" },
      { name: "chickpeas", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Grill the spiced chicken.", "Slice over salad with chickpeas and a yogurt drizzle."],
  },
  {
    id: "d-indian-tikka-salmon", name: "Tikka Spiced Salmon", type: "dinner",
    cuisine: "indian", mainProtein: "fish",
    timeMinutes: 22, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Roasted spiced salmon with rice and greens.",
    ingredients: [
      { name: "salmon fillet", quantity: "160 g" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "brown rice", quantity: "60 g" },
      { name: "green beans", quantity: "100 g" },
    ],
    steps: ["Rub the salmon with spice and roast.", "Serve with rice and beans."],
  },
  {
    id: "d-indian-paneer-style-tofu", name: "Tikka Masala Tofu", type: "dinner",
    cuisine: "indian", mainProtein: "tofu",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crisped tofu in a spiced tomato sauce with rice.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "tikka masala sauce", quantity: "150 g" },
      { name: "brown rice", quantity: "60 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Crisp the tofu in oil.", "Simmer in the sauce; wilt in spinach. Serve with rice."],
  },
  {
    id: "d-indian-keema-turkey", name: "Turkey Keema with Peas", type: "dinner",
    cuisine: "indian", mainProtein: "turkey",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced minced turkey with peas and rice.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "peas", quantity: "80 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "onion", quantity: "60 g" },
      { name: "brown rice", quantity: "55 g" },
    ],
    steps: ["Brown the turkey with onion and spice.", "Stir in peas; serve over rice."],
  },
  {
    // A LENTIL dhal, not a third chickpea curry — "Chickpea Curry" and "Chickpea Spinach Curry"
    // both already exist in this slot. Different legume, different texture, still vegan.
    id: "d-indian-cauliflower-dhal", name: "Cauliflower & Red Lentil Dhal", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 28, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Soft red lentils with roasted cauliflower and warm spice.",
    ingredients: [
      { name: "red lentils", quantity: "85 g" },
      { name: "cauliflower", quantity: "180 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "onion", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Simmer the lentils with onion and spice until collapsing.", "Fold through roasted cauliflower."],
  },

  // ---- Italian: breakfast and lunch were 1 each ----
  {
    id: "b-italian-ricotta-toast", name: "Ricotta & Tomato Toast", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 7, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Whipped ricotta on sourdough with tomatoes.",
    ingredients: [
      { name: "ricotta", quantity: "120 g" },
      { name: "sourdough bread", quantity: "2 slices" },
      { name: "cherry tomatoes", quantity: "90 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the sourdough.", "Spread ricotta, top with tomatoes and oil."],
  },
  {
    id: "b-italian-frittata-slice", name: "Courgette Frittata", type: "breakfast",
    cuisine: "italian", mainProtein: "eggs",
    timeMinutes: 18, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "keto", "mediterranean"],
    description: "Baked eggs with courgette and parmesan.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "zucchini", quantity: "100 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soften the courgette.", "Add beaten eggs and parmesan; bake until set."],
  },
  {
    id: "b-italian-espresso-yogurt", name: "Cocoa Yogurt Cup", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Greek yogurt with cocoa, honey and walnuts.",
    ingredients: [
      { name: "greek yogurt", quantity: "220 g" },
      { name: "cocoa", quantity: "1 tbsp" },
      { name: "walnuts", quantity: "20 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Stir the cocoa through the yogurt.", "Top with walnuts and honey."],
  },
  {
    id: "l-italian-caprese-panini", name: "Caprese Panini", type: "lunch",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Mozzarella, tomato and pesto pressed in sourdough.",
    ingredients: [
      { name: "sourdough bread", quantity: "2 slices" },
      { name: "mozzarella", quantity: "80 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "pesto", quantity: "1 tbsp" },
    ],
    steps: ["Layer the filling between the bread.", "Press in a hot pan until melted."],
  },
  {
    id: "l-italian-tuna-bean-salad", name: "Tuscan Tuna & Bean Salad", type: "lunch",
    cuisine: "italian", mainProtein: "fish",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Cannellini beans with tuna, red onion and lemon.",
    ingredients: [
      { name: "canned tuna", quantity: "120 g" },
      { name: "cannellini beans", quantity: "180 g" },
      { name: "red onion", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Flake the tuna over the beans.", "Dress with onion, oil and lemon."],
  },
  {
    id: "l-italian-minestrone", name: "Minestrone with Beans", type: "lunch",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Vegetable and bean soup with small pasta.",
    ingredients: [
      { name: "cannellini beans", quantity: "180 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "mixed veg", quantity: "120 g" },
      { name: "orzo", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Simmer the vegetables and tomato.", "Add beans and orzo; cook until tender."],
  },
  {
    id: "l-italian-caesar-chicken", name: "Chicken Caesar Bowl", type: "lunch",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 18, approxCost: 2,
    dietTags: [],
    description: "Grilled chicken over romaine with parmesan.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "romaine", quantity: "90 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "light caesar dressing", quantity: "2 tbsp" },
      { name: "sourdough bread", quantity: "1 slice" },
    ],
    steps: ["Grill and slice the chicken.", "Toss the leaves with dressing; add croutons."],
  },
  {
    id: "d-italian-chicken-parm-style", name: "Herb Chicken with Orzo", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "Pan-roasted chicken with tomato orzo.",
    ingredients: [
      { name: "chicken breast", quantity: "170 g" },
      { name: "orzo", quantity: "70 g" },
      { name: "tomato sauce", quantity: "120 g" },
      { name: "parmesan", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Sear the chicken through.", "Cook the orzo in tomato sauce; plate with parmesan."],
  },
  {
    id: "d-italian-mushroom-risotto-style", name: "Mushroom Barley Risotto", type: "dinner",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Creamy bulgur risotto with mushrooms and parmesan.",
    ingredients: [
      { name: "bulgur", quantity: "70 g" },
      { name: "mushrooms", quantity: "150 g" },
      { name: "parmesan", quantity: "25 g" },
      { name: "onion", quantity: "50 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften onion and mushrooms.", "Stir in the bulgur with stock until creamy."],
  },
  {
    id: "d-italian-puttanesca", name: "Tuna Puttanesca", type: "dinner",
    cuisine: "italian", mainProtein: "fish",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Whole-wheat spaghetti with tuna, olives and tomato.",
    ingredients: [
      { name: "whole-wheat spaghetti", quantity: "75 g" },
      { name: "canned tuna", quantity: "120 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "olives", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook the pasta.", "Simmer tuna, tomato and olives; toss together."],
  },

  // ---- Mexican: breakfast, lunch and dinner all under 6 ----
  {
    id: "b-mexican-breakfast-burrito", name: "Breakfast Egg Burrito", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 14, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Scrambled eggs with beans and salsa in a tortilla.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "whole-wheat tortilla", quantity: "1 piece" },
      { name: "black beans", quantity: "80 g" },
      { name: "salsa", quantity: "40 g" },
    ],
    steps: ["Scramble the eggs.", "Fill the tortilla with eggs, beans and salsa; roll."],
  },
  {
    // A HASH, deliberately — "Huevos Rancheros" already exists, and four of the six Mexican
    // breakfasts are already wrapped in a tortilla. Depth means a different dish, not a
    // different name for the same one.
    id: "b-mexican-sweet-potato-hash", name: "Mexican Sweet Potato Hash", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Crisped sweet potato with black beans, peppers and a fried egg.",
    ingredients: [
      { name: "sweet potato", quantity: "160 g" },
      { name: "black beans", quantity: "90 g" },
      { name: "bell pepper", quantity: "70 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "smoked paprika", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Crisp the diced sweet potato with pepper and paprika.", "Stir in beans; top with fried eggs."],
  },
  {
    id: "b-mexican-avocado-toast", name: "Chilli Avocado Toast", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Smashed avocado on toast with a fried egg and chilli.",
    ingredients: [
      { name: "avocado", quantity: "1/2 piece" },
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "eggs", quantity: "1 piece" },
      { name: "chili powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Toast the bread and smash the avocado on it.", "Top with a fried egg and chilli."],
  },
  {
    id: "l-mexican-burrito-bowl", name: "Chicken Burrito Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced chicken with rice, beans, corn and salsa.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "brown rice", quantity: "55 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "corn", quantity: "60 g" },
      { name: "salsa", quantity: "50 g" },
      { name: "taco spice", quantity: "1 tsp" },
    ],
    steps: ["Cook the chicken with taco spice.", "Build the bowl with rice, beans, corn, salsa."],
  },
  {
    id: "l-mexican-black-bean-soup", name: "Black Bean Soup", type: "lunch",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 22, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Smoky black bean soup with lime.",
    ingredients: [
      { name: "black beans", quantity: "220 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "onion", quantity: "60 g" },
      { name: "smoked paprika", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Soften the onion, add beans and tomato.", "Simmer and blend part-smooth; finish with lime."],
  },
  {
    id: "l-mexican-fajita-wrap", name: "Beef Fajita Wrap", type: "lunch",
    cuisine: "mexican", mainProtein: "beef",
    timeMinutes: 18, approxCost: 2,
    dietTags: [],
    description: "Seared beef strips with peppers in a tortilla.",
    ingredients: [
      { name: "beef strips", quantity: "150 g" },
      { name: "whole-wheat tortilla", quantity: "1 piece" },
      { name: "bell peppers", quantity: "100 g" },
      { name: "fajita spice", quantity: "1 tbsp" },
      { name: "salsa", quantity: "40 g" },
    ],
    steps: ["Sear the beef with peppers and spice.", "Roll into the tortilla with salsa."],
  },
  {
    id: "d-mexican-fish-tacos", name: "Cod Fish Tacos", type: "dinner",
    cuisine: "mexican", mainProtein: "fish",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced cod in corn tortillas with cabbage slaw.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "corn tortillas", quantity: "3 pieces" },
      { name: "cabbage", quantity: "80 g" },
      { name: "salsa", quantity: "50 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Pan-fry the spiced cod.", "Fill the tortillas with fish, slaw and salsa."],
  },
  {
    id: "d-mexican-enchilada-bake", name: "Turkey Enchilada Bake", type: "dinner",
    cuisine: "mexican", mainProtein: "turkey",
    timeMinutes: 30, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Minced turkey baked with corn tortillas and sauce.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "corn tortillas", quantity: "2 pieces" },
      { name: "enchilada sauce", quantity: "150 g" },
      { name: "black beans", quantity: "90 g" },
      { name: "cheddar", quantity: "25 g" },
    ],
    steps: ["Brown the turkey and mix with beans and sauce.", "Layer with tortillas, top with cheese, bake."],
  },
  {
    id: "d-mexican-stuffed-peppers", name: "Bean Stuffed Peppers", type: "dinner",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 32, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Peppers filled with spiced beans, rice and corn.",
    ingredients: [
      { name: "bell peppers", quantity: "200 g" },
      { name: "black beans", quantity: "180 g" },
      { name: "brown rice", quantity: "55 g" },
      { name: "corn", quantity: "70 g" },
      { name: "taco spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Mix the filling with spice.", "Stuff the peppers and bake until soft."],
  },

  // ---- Middle Eastern: breakfast 3, lunch 5, dinner 4 ----
  {
    // "Shakshuka" already exists — a harissa respelling is the same dish. A cold plate instead.
    id: "b-me-feta-cucumber-plate", name: "Feta & Cucumber Breakfast Plate", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 7, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Feta with cucumber, olives, tomato and warm bread.",
    ingredients: [
      { name: "feta", quantity: "80 g" },
      { name: "cucumber", quantity: "90 g" },
      { name: "cherry tomatoes", quantity: "90 g" },
      { name: "olives", quantity: "25 g" },
      { name: "whole-grain bread", quantity: "1 slice" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Slice the feta, cucumber and tomatoes onto a plate.", "Add olives, oil and warm bread."],
  },
  {
    id: "b-me-tahini-banana-toast", name: "Tahini Banana Toast", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Tahini and banana on toasted rye with honey.",
    ingredients: [
      { name: "rye bread", quantity: "2 slices" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "banana", quantity: "1 piece" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Toast the rye.", "Spread tahini, add banana and honey."],
  },
  {
    id: "b-me-foul-style-beans", name: "Spiced Breakfast Beans", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Warm cumin beans with lemon and flatbread.",
    ingredients: [
      { name: "cannellini beans", quantity: "200 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "whole-grain bread", quantity: "1 slice" },
    ],
    steps: ["Warm the beans with cumin and oil.", "Finish with lemon; serve with bread."],
  },
  {
    id: "l-me-falafel-style-bowl", name: "Spiced Chickpea Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Crisped spiced chickpeas over bulgur with tahini.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "shawarma spice", quantity: "1 tbsp" },
      { name: "cucumber", quantity: "70 g" },
    ],
    steps: ["Crisp the chickpeas with spice.", "Serve over bulgur with tahini and cucumber."],
  },
  {
    id: "l-me-chicken-shawarma-wrap", name: "Chicken Shawarma Wrap", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: [],
    description: "Shawarma-spiced chicken with garlic yogurt in a wrap.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "whole-wheat wrap", quantity: "1 piece" },
      { name: "greek yogurt", quantity: "60 g" },
      { name: "shawarma spice", quantity: "1 tbsp" },
      { name: "tomatoes", quantity: "60 g" },
    ],
    steps: ["Cook the spiced chicken.", "Wrap with yogurt and tomato."],
  },
  {
    id: "l-me-tabbouleh-halloumi", name: "Tabbouleh with Halloumi", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Herb bulgur salad with grilled halloumi.",
    ingredients: [
      { name: "bulgur", quantity: "60 g" },
      { name: "parsley", quantity: "25 g" },
      { name: "halloumi", quantity: "80 g" },
      { name: "cherry tomatoes", quantity: "90 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Soak the bulgur; toss with herbs, tomato, oil and lemon.", "Grill the halloumi and add."],
  },
  {
    id: "d-me-lamb-style-turkey-kofta", name: "Turkey Kofta with Bulgur", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "turkey",
    timeMinutes: 28, approxCost: 2,
    dietTags: [],
    description: "Spiced turkey koftas with bulgur and yogurt.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "shawarma spice", quantity: "1 tbsp" },
      { name: "greek yogurt", quantity: "70 g" },
      { name: "parsley", quantity: "15 g" },
    ],
    steps: ["Shape the spiced turkey into koftas and grill.", "Serve over bulgur with yogurt."],
  },
  {
    id: "d-me-harissa-cod", name: "Harissa Baked Cod", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "fish",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Cod baked with harissa, peppers and chickpeas.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "chickpeas", quantity: "150 g" },
      { name: "bell peppers", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toss chickpeas and peppers with harissa and oil.", "Lay the cod on top and bake."],
  },
  {
    id: "d-me-eggplant-tagine", name: "Aubergine & Chickpea Tagine", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 32, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Slow-spiced aubergine and chickpeas over bulgur.",
    ingredients: [
      { name: "eggplant", quantity: "180 g" },
      { name: "chickpeas", quantity: "180 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "ras el hanout", quantity: "1 tbsp" },
      { name: "bulgur", quantity: "55 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Brown the aubergine, add spice and tomato.", "Simmer with chickpeas; serve over bulgur."],
  },

  // ---- Keto: 7 per slot, under two weeks of variety ----
  {
    id: "b-keto-smoked-salmon-eggs", name: "Smoked Salmon Scramble", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Soft scrambled eggs folded with smoked salmon.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "smoked salmon", quantity: "70 g" },
      { name: "chives", quantity: "8 g" },
      { name: "butter", quantity: "1 tsp" },
    ],
    steps: ["Scramble the eggs gently in butter.", "Fold through salmon and chives."],
  },
  {
    id: "b-keto-cottage-avocado", name: "Cottage Cheese & Avocado Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["keto", "gluten_free", "vegetarian"],
    description: "Cottage cheese with avocado, seeds and paprika.",
    ingredients: [
      { name: "cottage cheese", quantity: "240 g" },
      { name: "avocado", quantity: "50 g" },
      { name: "pumpkin seeds", quantity: "10 g" },
      { name: "smoked paprika", quantity: "1 tsp" },
    ],
    steps: ["Spoon the cottage cheese into a bowl.", "Top with avocado, seeds and paprika."],
  },
  {
    id: "b-keto-mushroom-halloumi", name: "Halloumi & Mushroom Plate", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["keto", "gluten_free", "vegetarian", "mediterranean"],
    description: "Fried halloumi with garlic mushrooms and rocket.",
    ingredients: [
      { name: "halloumi", quantity: "90 g" },
      { name: "mushrooms", quantity: "120 g" },
      { name: "rocket", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Fry the halloumi and mushrooms.", "Serve over rocket."],
  },
  {
    // EGG-led on purpose: "Tuna & Avocado Salad" already exists, and keto lunch had three fish
    // dishes and no egg dish at all. A second tuna-and-avocado bowl is fake variety — a user
    // filtering keto lunch would see two names for one meal.
    id: "l-keto-egg-salad-cups", name: "Egg Salad Lettuce Cups", type: "lunch",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["keto", "gluten_free", "vegetarian"],
    description: "Chopped egg salad spooned into crisp lettuce cups.",
    ingredients: [
      { name: "eggs", quantity: "4 pieces" },
      { name: "greek yogurt", quantity: "60 g" },
      { name: "romaine", quantity: "80 g" },
      { name: "chives", quantity: "10 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Boil and chop the eggs.", "Fold through yogurt, oil and chives; spoon into lettuce."],
  },
  {
    // "Chicken Caesar, No Croutons" already exists — this is a DIFFERENT dish (warm, pork-led),
    // not a renamed Caesar. Keto lunch had one beef and no warm plate.
    id: "l-keto-pork-cabbage-plate", name: "Pork & Fennel Cabbage Plate", type: "lunch",
    cuisine: "mediterranean", mainProtein: "pork",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Seared pork with buttery cabbage and mustard greens.",
    ingredients: [
      { name: "pork tenderloin", quantity: "180 g" },
      { name: "cabbage", quantity: "150 g" },
      { name: "butter", quantity: "1 tbsp" },
      { name: "rocket", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Sear the pork and rest it.", "Wilt the cabbage in butter; plate with rocket."],
  },
  // NB: no "Steak & Rocket" lunch here — `l-keto-steak-rocket` already exists above. A second
  // near-identical steak-over-rocket dish would add an id collision and no variety, which is the
  // opposite of why this block exists. Keto lunch depth comes from genuinely different dishes.
  // Likewise no butter-salmon-and-asparagus dinner — `d-keto-salmon-asparagus` already exists.
  {
    id: "d-keto-chicken-thigh-greens", name: "Crispy Chicken Thighs & Greens", type: "dinner",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 28, approxCost: 2,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Roast chicken thighs with garlic greens.",
    ingredients: [
      { name: "chicken thigh", quantity: "200 g" },
      { name: "kale", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "almonds", quantity: "15 g" },
    ],
    steps: ["Roast the thighs until crisp.", "Wilt the kale with garlic; scatter almonds."],
  },
  {
    id: "d-keto-beef-broccoli", name: "Keto Beef & Broccoli", type: "dinner",
    cuisine: "asian", mainProtein: "beef",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Seared beef strips with broccoli and sesame.",
    ingredients: [
      { name: "beef strips", quantity: "180 g" },
      { name: "broccoli", quantity: "180 g" },
      { name: "sesame oil", quantity: "1 tbsp" },
      { name: "sesame seeds", quantity: "1 tbsp" },
      { name: "garlic", quantity: "2 cloves" },
    ],
    steps: ["Sear the beef hard and set aside.", "Stir-fry the broccoli; return the beef with sesame."],
  },

  // ---- Vegan: 11-13 per slot ----
  {
    id: "b-vegan-tofu-scramble-bowl", name: "Turmeric Tofu Scramble Bowl", type: "breakfast",
    cuisine: "american", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Golden tofu scramble with spinach and avocado.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Crumble and fry the tofu with turmeric.", "Wilt in spinach; serve with avocado."],
  },
  {
    id: "b-vegan-pb-oat-jar", name: "Overnight Peanut Oats", type: "breakfast",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Oats soaked with peanut butter, chia and banana.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "chia seeds", quantity: "1 tbsp" },
      { name: "banana", quantity: "1 piece" },
    ],
    steps: ["Stir everything together with water.", "Chill overnight."],
  },
  {
    id: "b-vegan-protein-shake-oats", name: "Soy Protein Berry Oats", type: "breakfast",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Oats blended with soy protein and berries.",
    ingredients: [
      { name: "rolled oats", quantity: "50 g" },
      { name: "soy protein powder", quantity: "1 scoop" },
      { name: "frozen berries", quantity: "120 g" },
      { name: "almond butter", quantity: "1 tbsp" },
    ],
    steps: ["Blend the oats, protein and berries.", "Swirl in almond butter."],
  },
  {
    id: "l-vegan-tempeh-bowl", name: "Tempeh Grain Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Glazed tempeh over quinoa with greens.",
    ingredients: [
      { name: "tempeh", quantity: "150 g" },
      { name: "quinoa", quantity: "60 g" },
      { name: "bok choy", quantity: "100 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Glaze and crisp the tempeh.", "Serve over quinoa with wilted greens."],
  },
  {
    id: "l-vegan-lentil-salad", name: "Lentil & Beetroot Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Green lentils with beetroot, walnuts and rocket.",
    ingredients: [
      { name: "green lentils", quantity: "200 g" },
      { name: "cooked beetroot", quantity: "100 g" },
      { name: "walnuts", quantity: "25 g" },
      { name: "rocket", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toss the lentils with beetroot and rocket.", "Add walnuts and dress with oil."],
  },
  {
    id: "l-vegan-hummus-quinoa-wrap", name: "Hummus & Quinoa Wrap", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Quinoa, hummus and salad rolled in a wrap.",
    ingredients: [
      { name: "whole-wheat wrap", quantity: "1 piece" },
      { name: "hummus", quantity: "70 g" },
      { name: "quinoa", quantity: "50 g" },
      { name: "spinach", quantity: "40 g" },
      { name: "roasted peppers", quantity: "60 g" },
    ],
    steps: ["Spread hummus over the wrap.", "Fill with quinoa, spinach and peppers; roll."],
  },
  {
    id: "d-vegan-peanut-tofu-noodles", name: "Peanut Tofu Noodles", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Rice noodles with crisped tofu in peanut sauce.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "rice noodles", quantity: "70 g" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "mixed stir-fry veg", quantity: "120 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
    ],
    steps: ["Crisp the tofu.", "Toss noodles and veg through the peanut-soy sauce."],
  },
  {
    id: "d-vegan-chickpea-spinach-curry", name: "Chickpea Spinach Curry", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Chickpeas and spinach in a spiced tomato sauce.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "spinach", quantity: "100 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "brown rice", quantity: "55 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Simmer chickpeas with tomato and spice.", "Wilt in spinach; serve with rice."],
  },
  {
    id: "d-vegan-lentil-bolognese", name: "Lentil Bolognese", type: "dinner",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Rich lentil ragu over whole-wheat spaghetti.",
    ingredients: [
      { name: "green lentils", quantity: "200 g" },
      { name: "whole-wheat spaghetti", quantity: "70 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "carrot", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften the carrot, add lentils and tomato.", "Simmer to a ragu; serve over pasta."],
  },

  // ---- Mediterranean + American depth ----
  {
    id: "b-med-shakshuka-feta", name: "Feta Baked Eggs", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean", "keto"],
    description: "Eggs baked with feta, spinach and tomato.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "feta", quantity: "40 g" },
      { name: "spinach", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "90 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Wilt the spinach with tomatoes.", "Add eggs and feta; bake until just set."],
  },
  {
    id: "l-med-salmon-quinoa-salad", name: "Salmon Quinoa Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Flaked salmon over quinoa with cucumber and lemon.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "quinoa", quantity: "60 g" },
      { name: "cucumber", quantity: "80 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Cook the salmon and flake it.", "Toss with quinoa, cucumber, olives and dressing."],
  },
  {
    id: "d-med-baked-cod-potatoes", name: "Baked Cod & Baby Potatoes", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 30, approxCost: 3,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Cod roasted with baby potatoes, tomatoes and olives.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "baby potatoes", quantity: "180 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast the potatoes until nearly done.", "Add cod, tomatoes and olives; finish roasting."],
  },
  {
    id: "l-american-turkey-club-bowl", name: "Turkey Club Bowl", type: "lunch",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Sliced turkey with egg, avocado and leaves.",
    ingredients: [
      { name: "turkey breast", quantity: "150 g" },
      { name: "eggs", quantity: "1 piece" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "romaine", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
    ],
    steps: ["Boil the egg and halve it.", "Build the bowl and dress lightly."],
  },
  {
    id: "d-american-turkey-chili", name: "Turkey & Bean Chilli", type: "dinner",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 30, approxCost: 1,
    dietTags: ["gluten_free"],
    description: "Minced turkey simmered with beans and smoky spice.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "kidney beans", quantity: "150 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "chili powder", quantity: "1 tbsp" },
      { name: "brown rice", quantity: "50 g" },
    ],
    steps: ["Brown the turkey with spice.", "Add beans and tomato; simmer. Serve with rice."],
  },
  {
    id: "d-american-sheetpan-chicken", name: "Sheet-Pan Chicken & Veg", type: "dinner",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 32, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Roast chicken with sweet potato and broccoli.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "sweet potato", quantity: "180 g" },
      { name: "broccoli", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "smoked paprika", quantity: "1 tsp" },
    ],
    steps: ["Toss everything with oil and paprika.", "Roast on one tray until cooked through."],
  },
  {
    id: "l-asian-miso-salmon-rice", name: "Miso Salmon Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 22, approxCost: 3,
    dietTags: [],
    description: "Miso-glazed salmon over rice with greens.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "brown rice", quantity: "60 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "pak choi", quantity: "100 g" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Glaze the salmon with miso and grill.", "Serve over rice with wilted greens."],
  },
  {
    id: "b-asian-congee-style-oats", name: "Savoury Sesame Oats", type: "breakfast",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Savoury oats with a soft egg and sesame.",
    ingredients: [
      { name: "rolled oats", quantity: "55 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "sesame oil", quantity: "1 tsp" },
      { name: "chives", quantity: "10 g" },
      { name: "soy sauce", quantity: "1 tsp" },
    ],
    steps: ["Simmer the oats in water until creamy.", "Top with soft eggs, sesame oil and chives."],
  },
  {
    id: "d-asian-tofu-stirfry-noodles", name: "Ginger Tofu Stir-Fry", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Tofu and vegetables in ginger-soy over soba.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "soba noodles", quantity: "70 g" },
      { name: "mixed stir-fry veg", quantity: "150 g" },
      { name: "ginger-soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Crisp the tofu; stir-fry the veg.", "Toss with noodles and sauce."],
  },

  // ---- Batch 2: lift every remaining CRITICAL cell (under 7 = a week is forced
  // to repeat a dish) to at least 7. Cuisine snacks and breakfasts were the
  // stragglers after batch 1. ----
  {
    id: "s-indian-spiced-popcorn-chana", name: "Chaat-Spiced Chickpeas", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Crunchy chickpeas with tangy spice and lime.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "chili powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Dry-roast the chickpeas until crisp.", "Toss with spices and lime."],
  },
  {
    id: "s-indian-mango-lassi-bowl", name: "Mango Lassi Bowl", type: "snack",
    cuisine: "indian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Thick yogurt blended with mango and cardamom spice.",
    ingredients: [
      { name: "greek yogurt", quantity: "180 g" },
      { name: "mango", quantity: "120 g" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Blend the yogurt with mango.", "Dust with spice."],
  },
  {
    id: "s-indian-paneer-style-tofu-bites", name: "Tandoori Tofu Bites", type: "snack",
    cuisine: "indian", mainProtein: "tofu",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Tofu cubes roasted in tandoori spice.",
    ingredients: [
      { name: "firm tofu", quantity: "160 g" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Toss the tofu in spice and oil.", "Roast until edges crisp; finish with lemon."],
  },
  {
    id: "s-italian-tomato-bruschetta", name: "Tomato Bruschetta", type: "snack",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Toasted sourdough with garlic tomatoes and basil.",
    ingredients: [
      { name: "sourdough bread", quantity: "1 slice" },
      { name: "cherry tomatoes", quantity: "120 g" },
      { name: "garlic", quantity: "1 clove" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "parsley", quantity: "5 g" },
    ],
    steps: ["Toast and rub the bread with garlic.", "Top with dressed tomatoes."],
  },
  {
    id: "s-italian-antipasto-cup", name: "Antipasto Cup", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "keto", "mediterranean"],
    description: "Mozzarella with olives, peppers and oil.",
    ingredients: [
      { name: "mozzarella", quantity: "80 g" },
      { name: "olives", quantity: "30 g" },
      { name: "roasted peppers", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Combine everything in a cup."],
  },
  {
    id: "s-italian-pesto-beans", name: "Pesto Bean Pot", type: "snack",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Cannellini beans stirred through pesto.",
    ingredients: [
      { name: "cannellini beans", quantity: "160 g" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "cherry tomatoes", quantity: "70 g" },
    ],
    steps: ["Stir the beans through the pesto.", "Add halved tomatoes."],
  },
  {
    id: "s-mexican-queso-style-beans", name: "Spiced Refried Bean Cup", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Mashed spiced beans topped with cheddar.",
    ingredients: [
      { name: "black beans", quantity: "160 g" },
      { name: "taco spice", quantity: "1 tsp" },
      { name: "cheddar", quantity: "20 g" },
      { name: "salsa", quantity: "40 g" },
    ],
    steps: ["Mash and warm the beans with spice.", "Top with cheddar and salsa."],
  },
  {
    id: "s-mexican-elote-cottage", name: "Corn & Cottage Cheese Cup", type: "snack",
    cuisine: "mexican", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Sweetcorn with cottage cheese, lime and chilli.",
    ingredients: [
      { name: "cottage cheese", quantity: "180 g" },
      { name: "corn", quantity: "90 g" },
      { name: "chili powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Stir the corn through the cottage cheese.", "Season with chilli and lime."],
  },
  {
    // NOT another avocado-and-egg cup — "Egg & Avocado Cups" already exists above and a
    // word-reordered name is the same dish twice. Cheese-led instead.
    id: "s-mexican-queso-pepper-cup", name: "Chilli Cheese Pepper Cup", type: "snack",
    cuisine: "mexican", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "keto"],
    description: "Pepper strips with melted cheddar, salsa and lime.",
    ingredients: [
      { name: "cheddar", quantity: "50 g" },
      { name: "bell peppers", quantity: "120 g" },
      { name: "salsa", quantity: "40 g" },
      { name: "chili powder", quantity: "1 tsp" },
    ],
    steps: ["Melt the cheddar over the pepper strips.", "Top with salsa and chilli."],
  },
  {
    id: "s-me-muhammara-style-dip", name: "Roast Pepper & Walnut Dip", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Roasted peppers blended with walnuts and spice.",
    ingredients: [
      { name: "roasted peppers", quantity: "120 g" },
      { name: "walnuts", quantity: "30 g" },
      { name: "harissa", quantity: "1 tsp" },
      { name: "cucumber", quantity: "70 g" },
    ],
    steps: ["Blend peppers, walnuts and harissa.", "Serve with cucumber batons."],
  },
  {
    id: "s-me-tahini-yogurt-dip", name: "Tahini Yogurt Dip", type: "snack",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Yogurt whipped with tahini, lemon and cumin.",
    ingredients: [
      { name: "greek yogurt", quantity: "170 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "bell pepper", quantity: "70 g" },
    ],
    steps: ["Whisk the yogurt with tahini and cumin.", "Serve with pepper strips."],
  },
  {
    id: "s-me-spiced-lentil-cup", name: "Cumin Lentil Cup", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Warm lentils with cumin, lemon and parsley.",
    ingredients: [
      { name: "green lentils", quantity: "170 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "parsley", quantity: "10 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Warm the lentils with cumin and oil.", "Finish with parsley and lemon."],
  },
  {
    id: "s-asian-seaweed-edamame-rice", name: "Soy Edamame Rice Cup", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Edamame with rice, soy and sesame.",
    ingredients: [
      { name: "edamame", quantity: "140 g" },
      { name: "cooked rice", quantity: "100 g" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Warm the rice and edamame.", "Season with soy and sesame."],
  },
  {
    id: "s-asian-cucumber-sesame-salad", name: "Smashed Cucumber Salad", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Cucumber with tofu, sesame and chilli.",
    ingredients: [
      { name: "cucumber", quantity: "150 g" },
      { name: "firm tofu", quantity: "120 g" },
      { name: "sesame oil", quantity: "1 tsp" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Smash and salt the cucumber.", "Toss with cubed tofu, sesame and soy."],
  },
  {
    id: "s-asian-miso-soup-tofu", name: "Miso Tofu Broth", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 7, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Light miso broth with tofu and greens.",
    ingredients: [
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "firm tofu", quantity: "140 g" },
      { name: "pak choi", quantity: "80 g" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Whisk the miso into hot water.", "Add tofu and greens; warm through."],
  },
  {
    id: "s-med-feta-melon-mint", name: "Feta & Tomato Plate", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "keto", "mediterranean"],
    description: "Feta with tomatoes, olives and oregano.",
    ingredients: [
      { name: "feta", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "110 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Cube the feta.", "Plate with tomatoes, olives and oil."],
  },
  {
    id: "s-med-almond-yogurt-cup", name: "Almond Yogurt Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Greek yogurt with toasted almonds and honey.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "almonds", quantity: "20 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Toast the almonds.", "Scatter over yogurt with honey."],
  },
  {
    id: "s-keto-parmesan-olives", name: "Parmesan & Olive Plate", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["keto", "gluten_free", "vegetarian", "mediterranean"],
    description: "Shaved parmesan with olives and almonds.",
    ingredients: [
      { name: "parmesan", quantity: "40 g" },
      { name: "olives", quantity: "40 g" },
      { name: "almonds", quantity: "20 g" },
    ],
    steps: ["Arrange everything on a plate."],
  },
  {
    id: "s-keto-tuna-avocado-cup", name: "Tuna Avocado Cup", type: "snack",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Tuna folded through avocado with lemon.",
    ingredients: [
      { name: "canned tuna", quantity: "100 g" },
      { name: "avocado", quantity: "70 g" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "chives", quantity: "8 g" },
    ],
    steps: ["Mash the avocado with lemon.", "Fold through the flaked tuna and chives."],
  },
  {
    id: "b-indian-yogurt-seed-bowl", name: "Spiced Yogurt Seed Bowl", type: "breakfast",
    cuisine: "indian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Greek yogurt with mango, seeds and warm spice.",
    ingredients: [
      { name: "greek yogurt", quantity: "220 g" },
      { name: "mango", quantity: "120 g" },
      { name: "pumpkin seeds", quantity: "20 g" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Spoon the yogurt into a bowl.", "Top with mango, seeds and spice."],
  },
  {
    id: "b-indian-lentil-breakfast-bowl", name: "Breakfast Dal Bowl", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 18, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Soft spiced lentils topped with spinach.",
    ingredients: [
      { name: "red lentils", quantity: "70 g" },
      { name: "spinach", quantity: "70 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Simmer the lentils with spice.", "Wilt in the spinach."],
  },
  {
    id: "b-italian-parmesan-eggs", name: "Parmesan Baked Eggs", type: "breakfast",
    cuisine: "italian", mainProtein: "eggs",
    timeMinutes: 14, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "keto", "mediterranean"],
    description: "Eggs baked with parmesan, tomato and rocket.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "parmesan", quantity: "25 g" },
      { name: "cherry tomatoes", quantity: "90 g" },
      { name: "rocket", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Bake the eggs with tomatoes and parmesan.", "Serve over rocket."],
  },
  {
    id: "b-italian-oat-cocoa-pot", name: "Cocoa Hazelnut Oats", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Creamy cocoa oats with walnuts and banana.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "milk", quantity: "220 ml" },
      { name: "cocoa", quantity: "1 tbsp" },
      { name: "walnuts", quantity: "20 g" },
      { name: "banana", quantity: "1 piece" },
    ],
    steps: ["Simmer the oats with milk and cocoa.", "Top with walnuts and banana."],
  },
  {
    id: "b-asian-tofu-rice-bowl", name: "Soy Tofu Rice Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 14, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Warm rice with soy tofu and greens.",
    ingredients: [
      { name: "firm tofu", quantity: "170 g" },
      { name: "cooked rice", quantity: "150 g" },
      { name: "pak choi", quantity: "80 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Crisp the tofu and wilt the greens.", "Serve over warm rice with soy."],
  },
  {
    id: "b-me-egg-hummus-plate", name: "Egg & Hummus Plate", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Boiled eggs with hummus, tomato and bread.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "hummus", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "whole-grain bread", quantity: "1 slice" },
    ],
    steps: ["Boil and halve the eggs.", "Plate with hummus, tomato and bread."],
  },

  // ---- Batch 3: the last seven cells sitting at exactly 6. One dish each
  // clears every CRITICAL, so no filter forces a repeat inside one week. ----
  {
    id: "b-indian-besan-spinach-toast", name: "Spiced Chickpea Toast", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Chickpea batter griddled with spinach, on toast.",
    ingredients: [
      { name: "chickpea flour", quantity: "60 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "whole-grain bread", quantity: "1 slice" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Whisk the flour with water, spice and spinach.", "Griddle and serve on toast."],
  },
  {
    id: "l-indian-rajma-bowl", name: "Rajma Bean Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 22, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced kidney beans over brown rice.",
    ingredients: [
      { name: "kidney beans", quantity: "200 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "brown rice", quantity: "60 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "onion", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Fry onion with spice; add tomato and beans.", "Simmer and serve over rice."],
  },
  {
    id: "s-indian-cucumber-chaat", name: "Cucumber Chaat Cup", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Cucumber and chickpeas with tangy chaat spice.",
    ingredients: [
      { name: "cucumber", quantity: "120 g" },
      { name: "chickpeas", quantity: "130 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
      { name: "parsley", quantity: "8 g" },
    ],
    steps: ["Dice the cucumber and mix with chickpeas.", "Season with cumin, lime and herbs."],
  },
  {
    id: "b-italian-mozzarella-tomato-toast", name: "Mozzarella Tomato Toast", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Melted mozzarella on sourdough with tomatoes.",
    ingredients: [
      { name: "sourdough bread", quantity: "2 slices" },
      { name: "mozzarella", quantity: "80 g" },
      { name: "cherry tomatoes", quantity: "90 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the bread and melt the mozzarella on top.", "Finish with tomatoes and oil."],
  },
  {
    // Italian lunch sat at 6 after the de-duplication pass, and 6 means a week of Italian
    // lunches must repeat a dish. Turkey + breaded: the one protein and method the other six
    // don't use (2x chicken, tuna, caprese, minestrone, orzo).
    id: "l-italian-turkey-milanese", name: "Turkey Milanese Salad", type: "lunch",
    cuisine: "italian", mainProtein: "turkey",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Crisp breaded turkey over rocket with parmesan and lemon.",
    ingredients: [
      { name: "turkey breast", quantity: "170 g" },
      { name: "panko", quantity: "30 g" },
      { name: "rocket", quantity: "50 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Coat the turkey in panko and pan-fry until golden.", "Slice over rocket with parmesan and lemon."],
  },
  {
    id: "l-italian-orzo-pesto-salad", name: "Pesto Orzo Salad", type: "lunch",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Orzo tossed with pesto, mozzarella and tomatoes.",
    ingredients: [
      { name: "orzo", quantity: "70 g" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "mozzarella", quantity: "80 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "rocket", quantity: "30 g" },
    ],
    steps: ["Cook and cool the orzo.", "Toss with pesto, mozzarella, tomatoes and rocket."],
  },
  {
    id: "s-mexican-jalapeno-bean-dip", name: "Smoky Bean Dip", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Blended black beans with smoked paprika and lime.",
    ingredients: [
      { name: "black beans", quantity: "160 g" },
      { name: "smoked paprika", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
      { name: "bell pepper", quantity: "80 g" },
    ],
    steps: ["Blend the beans with paprika and lime.", "Serve with pepper strips."],
  },
  {
    id: "s-me-olive-chickpea-cup", name: "Olive & Chickpea Cup", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Chickpeas with olives, lemon and za'atar spice.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "olives", quantity: "30 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Toss the chickpeas with olives and spice.", "Finish with lemon."],
  },

  // ---- Batch 4: weeknight-fast dinners, high-protein snacks, and the thin cells ----
  //
  // Measured against the library rather than guessed at. Three gaps, in the order they hurt:
  //
  //  1. NOT ONE dinner cooked in 15 minutes or less — 0 of 72, median 28 min. "Simple" is a
  //     hard constraint for a weeknight, and the engine's own maxCookTime filter had nothing
  //     to hand a user who says "20 minutes tonight" for the meal that matters most. Twelve
  //     dinners below, every one <=15 min and <=6 ingredients.
  //  2. Snacks carried protein 4 times in 56. A snack that is 250 kcal of carbohydrate is the
  //     one the rebalancer cannot use when a day is short on protein. Seven below at 27-43 g.
  //  3. The thin cells: pork (5 dishes), shrimp (7), eggs outside breakfast (3 lunches, 0
  //     dinners), chicken and beef snacks (0 each), and the cuisines pinned at the 7-floor
  //     (mexican, middle_eastern, italian, indian, asian breakfast).
  //
  // Every ingredient is one already curated to an FDC id — a new ingredient without a real
  // USDA record would be a fabricated nutrient value, which is the thing this engine exists
  // to prevent. So the variety here comes from combination, not from inventing food.

  // -- Fast dinners: <=15 minutes, real food --
  {
    id: "d-fast-shrimp-orzo", name: "Garlic Shrimp & Tomato Orzo", type: "dinner",
    cuisine: "italian", mainProtein: "shrimp",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Sweet garlic shrimp tossed through orzo with burst tomatoes and rocket.",
    ingredients: [
      { name: "shrimp", quantity: "180 g" },
      { name: "orzo", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "120 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "rocket", quantity: "30 g" },
    ],
    steps: [
      "Boil the orzo.",
      "Meanwhile sear the shrimp with garlic and oil, adding the tomatoes until they burst.",
      "Toss everything with the drained orzo and the rocket.",
    ],
  },
  {
    id: "d-fast-prawn-tacos", name: "Chilli-Lime Prawn Tacos", type: "dinner",
    cuisine: "mexican", mainProtein: "shrimp",
    timeMinutes: 12, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Charred prawns in corn tortillas with crunchy cabbage, salsa and avocado.",
    ingredients: [
      { name: "prawns", quantity: "160 g" },
      { name: "corn tortillas", quantity: "3 pieces" },
      { name: "cabbage", quantity: "80 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "lime", quantity: "1/2 piece" },
    ],
    steps: [
      "Sear the prawns hard for two minutes a side.",
      "Warm the tortillas.",
      "Fill with cabbage, prawns, salsa and avocado, and squeeze over the lime.",
    ],
  },
  {
    id: "d-fast-miso-salmon-bokchoy", name: "Miso Salmon & Bok Choy Bowl", type: "dinner",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: [],
    description: "Miso-glazed salmon over rice with quick-wilted bok choy and sesame.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "bok choy", quantity: "150 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: [
      "Rub the salmon with miso and pan-fry skin-side down.",
      "Wilt the bok choy alongside in the same pan.",
      "Serve over the rice with sesame seeds.",
    ],
  },
  {
    id: "d-fast-pork-green-beans", name: "Ginger Pork & Green Bean Stir-Fry", type: "dinner",
    cuisine: "asian", mainProtein: "pork",
    timeMinutes: 15, approxCost: 2,
    dietTags: [],
    description: "Fast ginger-soy pork with snappy green beans over rice.",
    ingredients: [
      { name: "pork tenderloin", quantity: "180 g" },
      { name: "green beans", quantity: "150 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
      { name: "garlic", quantity: "2 cloves" },
    ],
    steps: [
      "Slice the pork thin and stir-fry hot with the garlic.",
      "Add the beans and the sauce and cook two minutes more.",
      "Spoon over the rice.",
    ],
  },
  {
    id: "d-fast-harissa-chickpea", name: "Harissa Chickpea & Spinach Skillet", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "One pan of smoky harissa chickpeas and spinach, mopped up with bread.",
    ingredients: [
      { name: "chickpeas", quantity: "1 can" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "spinach", quantity: "120 g" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "whole-grain bread", quantity: "1 slice" },
    ],
    steps: [
      "Warm the harissa in the oil, then add the chickpeas and tomatoes.",
      "Simmer five minutes and stir the spinach through to wilt.",
      "Serve with the bread.",
    ],
  },
  {
    id: "d-fast-lemon-parm-chicken", name: "Lemon Parmesan Chicken & Asparagus", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Pan-seared chicken with asparagus, parmesan and a hit of lemon.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "asparagus", quantity: "150 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "parmesan", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/2 piece" },
    ],
    steps: [
      "Halve the potatoes and boil until tender.",
      "Sear the chicken in the oil, adding the asparagus for the last three minutes.",
      "Finish with parmesan and lemon.",
    ],
  },
  {
    id: "d-fast-tandoori-cod", name: "Tandoori Cod with Cucumber Salad", type: "dinner",
    cuisine: "indian", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Yogurt-spiced cod with a cooling cucumber salad and rice.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "greek yogurt", quantity: "80 g" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "cucumber", quantity: "150 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: [
      "Coat the cod in half the yogurt with the spice and pan-fry or grill it.",
      "Toss the cucumber with the rest of the yogurt and the lemon.",
      "Serve with the rice.",
    ],
  },
  {
    id: "d-fast-egg-fried-rice", name: "Egg Fried Rice with Peas & Edamame", type: "dinner",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "The fast one: eggs, peas and edamame folded through sesame rice.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "cooked rice", quantity: "200 g" },
      { name: "peas", quantity: "80 g" },
      { name: "edamame", quantity: "80 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: [
      "Scramble the eggs in the sesame oil and set aside.",
      "Fry the rice hard with the peas and edamame.",
      "Fold the egg back through with the soy sauce.",
    ],
  },
  {
    id: "d-fast-chipotle-turkey-sweet-potato", name: "Smoky Turkey & Sweet Potato Skillet", type: "dinner",
    cuisine: "mexican", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced turkey mince with sweet potato and black beans, all in one pan.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "sweet potato", quantity: "200 g" },
      { name: "black beans", quantity: "120 g" },
      { name: "taco spice", quantity: "1 tbsp" },
      { name: "salsa", quantity: "60 g" },
    ],
    steps: [
      "Dice the sweet potato small and pan-fry covered until tender.",
      "Push aside, brown the turkey with the spice.",
      "Stir in the beans and salsa and heat through.",
    ],
  },
  {
    id: "d-fast-tikka-prawn-peas", name: "Tikka Prawns with Pea Rice", type: "dinner",
    cuisine: "indian", mainProtein: "shrimp",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Prawns simmered in tikka sauce with spinach, over pea rice.",
    ingredients: [
      { name: "prawns", quantity: "180 g" },
      { name: "tikka masala sauce", quantity: "150 g" },
      { name: "peas", quantity: "100 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "spinach", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: [
      "Warm the sauce, add the prawns and cook three minutes.",
      "Wilt the spinach through.",
      "Stir the peas into the hot rice and serve underneath.",
    ],
  },
  {
    id: "d-fast-pesto-cod-broccoli", name: "Pesto Baked Cod with Broccoli", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Cod under a pesto-parmesan crust with charred broccoli.",
    ingredients: [
      { name: "cod fillet", quantity: "200 g" },
      { name: "pesto", quantity: "2 tbsp" },
      { name: "broccoli", quantity: "200 g" },
      { name: "parmesan", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: [
      "Spread the pesto over the cod and top with parmesan.",
      "Grill or bake hot for 10-12 minutes.",
      "Char the broccoli in the oil alongside.",
    ],
  },
  {
    id: "d-fast-pork-apple-slaw", name: "Pork & Apple Slaw Bowl", type: "dinner",
    cuisine: "american", mainProtein: "pork",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Seared pork with a crunchy apple-cabbage slaw and baby potatoes.",
    ingredients: [
      { name: "pork tenderloin", quantity: "180 g" },
      { name: "cabbage", quantity: "120 g" },
      { name: "apple", quantity: "1/2 piece" },
      { name: "greek yogurt", quantity: "60 g" },
      { name: "baby potatoes", quantity: "180 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: [
      "Boil the halved potatoes.",
      "Sear the sliced pork in the oil, 3-4 minutes a side.",
      "Shred the cabbage and apple and dress with the yogurt.",
    ],
  },

  // -- High-protein snacks: the ones the day-solver can actually use --
  {
    id: "s-hp-ricotta-pepper", name: "Whipped Ricotta & Pepper Cup", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Ricotta whipped with parmesan, scooped up with sweet pepper strips.",
    ingredients: [
      { name: "ricotta", quantity: "180 g" },
      { name: "parmesan", quantity: "25 g" },
      { name: "bell pepper", quantity: "100 g" },
    ],
    steps: ["Beat the ricotta with the parmesan until smooth.", "Serve with pepper strips."],
  },
  {
    id: "s-hp-tuna-white-bean", name: "Tuna & White Bean Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Tuna forked through cannellini beans with lemon and parsley.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "cannellini beans", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "parsley", quantity: "1 tbsp" },
    ],
    steps: ["Fork the tuna through the beans.", "Dress with oil, lemon and parsley."],
  },
  {
    id: "s-hp-turkey-hummus-rolls", name: "Turkey & Hummus Roll-Ups", type: "snack",
    cuisine: "middle_eastern", mainProtein: "turkey",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Turkey slices rolled around hummus with crisp pepper and lettuce.",
    ingredients: [
      { name: "turkey breast", quantity: "120 g" },
      { name: "hummus", quantity: "2 tbsp" },
      { name: "bell pepper", quantity: "100 g" },
      { name: "lettuce", quantity: "4 leaves" },
    ],
    steps: ["Spread the turkey with hummus.", "Roll around pepper strips and lettuce."],
  },
  {
    id: "s-hp-peanut-tofu-bites", name: "Peanut Tofu Bites", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 6, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Crisp tofu cubes tossed in a peanut-sriracha glaze with sesame.",
    ingredients: [
      { name: "firm tofu", quantity: "250 g" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "sriracha", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: [
      "Cube and pan-crisp the tofu.",
      "Loosen the peanut butter with the soy and sriracha and toss the tofu through.",
      "Scatter with sesame seeds.",
    ],
  },
  {
    id: "s-hp-smoked-trout-rye", name: "Smoked Trout Rye Bites", type: "snack",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 4, approxCost: 3,
    dietTags: [],
    description: "Smoked trout on rye with soft cheese and cucumber.",
    ingredients: [
      { name: "smoked trout", quantity: "100 g" },
      { name: "rye bread", quantity: "1 slice" },
      { name: "light cream cheese", quantity: "40 g" },
      { name: "cucumber", quantity: "60 g" },
    ],
    steps: ["Spread the rye with the cheese and cut into squares.", "Top with trout and cucumber."],
  },
  {
    id: "s-hp-chicken-avocado-cup", name: "Chicken & Avocado Cup", type: "snack",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Shredded chicken with avocado, tomato and lime.",
    ingredients: [
      { name: "chicken breast", quantity: "130 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "cherry tomatoes", quantity: "60 g" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Shred the cooked chicken.", "Fold through diced avocado and tomato, and finish with lime."],
  },
  {
    id: "s-hp-roast-beef-horseradish", name: "Roast Beef & Horseradish Rounds", type: "snack",
    cuisine: "american", mainProtein: "beef",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Cucumber rounds with roast beef and a horseradish cream.",
    ingredients: [
      { name: "lean roast beef", quantity: "120 g" },
      { name: "cucumber", quantity: "150 g" },
      { name: "light cream cheese", quantity: "30 g" },
      { name: "horseradish", quantity: "15 g" },
    ],
    steps: [
      "Slice the cucumber into thick rounds.",
      "Mix the cheese with the horseradish, spoon on, and top with folded beef.",
    ],
  },

  // -- The thin cells: asian breakfast, italian/mexican/middle-eastern lunch, keto lunch, eggs at lunch --
  {
    id: "b-asian-miso-oats-egg", name: "Savoury Miso Oats with Egg", type: "breakfast",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Oats cooked savoury in miso broth, topped with a soft egg and sesame.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "eggs", quantity: "1 piece" },
      { name: "spinach", quantity: "60 g" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: [
      "Simmer the oats in water with the miso stirred through.",
      "Wilt the spinach in at the end.",
      "Top with a soft-boiled or fried egg and the sesame seeds.",
    ],
  },
  {
    id: "l-italian-caprese-chicken-bulgur", name: "Caprese Chicken Bulgur Bowl", type: "lunch",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Chicken, mozzarella and tomato over pesto-dressed bulgur.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "mozzarella", quantity: "60 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "rocket", quantity: "30 g" },
    ],
    steps: [
      "Soak the bulgur in boiling water for 10 minutes.",
      "Griddle the chicken and slice it.",
      "Toss the bulgur with pesto and build the bowl with tomato, mozzarella and rocket.",
    ],
  },
  {
    id: "l-me-shawarma-halloumi-bulgur", name: "Shawarma Halloumi Bulgur Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Spiced griddled halloumi over bulgur with cucumber and tomato.",
    ingredients: [
      { name: "halloumi", quantity: "100 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "tomatoes", quantity: "100 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: [
      "Soak the bulgur in boiling water for 10 minutes.",
      "Dust the halloumi with the spice and griddle until golden both sides.",
      "Serve over the bulgur with chopped cucumber, tomato and lemon.",
    ],
  },
  {
    id: "l-keto-chicken-feta-olive", name: "Chicken, Feta & Olive Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 10, approxCost: 3,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Chicken over greens with feta, olives and a generous olive oil dressing.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "feta", quantity: "50 g" },
      { name: "olives", quantity: "30 g" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: [
      "Griddle and slice the chicken.",
      "Build the salad and crumble the feta over.",
      "Dress with the oil.",
    ],
  },
  {
    id: "l-mexican-tempeh-burrito-bowl", name: "Tempeh & Black Bean Burrito Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced tempeh crumbles with black beans, rice, salsa and lime.",
    ingredients: [
      { name: "tempeh", quantity: "120 g" },
      { name: "black beans", quantity: "120 g" },
      { name: "cooked rice", quantity: "150 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "taco spice", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: [
      "Crumble and fry the tempeh with the spice until browned.",
      "Warm the beans through.",
      "Build over the rice with salsa and lime.",
    ],
  },
  {
    id: "l-me-turkish-eggs", name: "Turkish Eggs over Garlic Yogurt", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Soft eggs on thick yogurt with paprika oil and bread to dip.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "greek yogurt", quantity: "150 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "whole-grain bread", quantity: "1 slice" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "paprika", quantity: "1 tsp" },
    ],
    steps: [
      "Spread the yogurt across a shallow bowl.",
      "Poach or soft-fry the eggs and set them on top with the wilted spinach.",
      "Warm the paprika in the oil and spoon it over. Serve with the bread.",
    ],
  },

  // ---- Batch 5: the cells still at the floor after batch 4 ----
  //
  // Batch 4 fixed the two structural holes (no fast dinners, no protein in the snack tier).
  // This one goes after what the grid still shows thin: indian at 7 in three of four slots,
  // italian / mexican / middle-eastern breakfast all at 7, pork at 7 dishes total, eggs at
  // dinner at 1, keto lunch and dinner at 10 each — the diets a filtered week runs out of
  // first. Same rule as before: only ingredients already curated to an FDC id.

  // -- Indian: 7 at breakfast, lunch and snack --
  {
    id: "b-indian-turmeric-rice-peanut", name: "Turmeric Rice & Peanut Bowl", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Poha-style turmeric rice with peanuts, peas and lime.",
    ingredients: [
      { name: "cooked rice", quantity: "180 g" },
      { name: "peanuts", quantity: "30 g" },
      { name: "peas", quantity: "80 g" },
      { name: "onion", quantity: "60 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: [
      "Soften the onion, then stir in the turmeric.",
      "Add the rice and peas and heat through, tossing.",
      "Fold in the peanuts and finish with lime.",
    ],
  },
  {
    id: "l-indian-lentil-raita-bowl", name: "Lentil & Cucumber Raita Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Cumin lentils under a cool cucumber raita.",
    ingredients: [
      { name: "green lentils", quantity: "200 g" },
      { name: "greek yogurt", quantity: "120 g" },
      { name: "cucumber", quantity: "120 g" },
      { name: "spinach", quantity: "60 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: [
      "Warm the lentils with the cumin in the oil and wilt the spinach through.",
      "Grate the cucumber into the yogurt.",
      "Spoon the raita over the lentils.",
    ],
  },
  {
    id: "s-indian-curried-egg-cups", name: "Curried Egg Cups", type: "snack",
    cuisine: "indian", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "keto"],
    description: "Boiled eggs folded through curried yogurt with cucumber.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "greek yogurt", quantity: "60 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "cucumber", quantity: "80 g" },
    ],
    steps: ["Chop the boiled eggs.", "Fold through the yogurt and curry powder, and serve with cucumber."],
  },

  // -- The 7-floor breakfasts: italian, mexican, middle eastern --
  {
    id: "b-italian-ricotta-walnut-oats", name: "Ricotta & Walnut Oats", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Creamy oats stirred with ricotta, walnuts, honey and blueberries.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "ricotta", quantity: "100 g" },
      { name: "walnuts", quantity: "20 g" },
      { name: "blueberries", quantity: "60 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: [
      "Cook the oats.",
      "Stir the ricotta through off the heat.",
      "Top with walnuts, blueberries and honey.",
    ],
  },
  {
    id: "b-mexican-chilaquiles-eggs", name: "Chilaquiles-Style Egg Skillet", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Crisped tortilla with salsa, black beans, eggs and avocado.",
    ingredients: [
      { name: "corn tortillas", quantity: "2 pieces" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "black beans", quantity: "80 g" },
      { name: "salsa", quantity: "80 g" },
      { name: "avocado", quantity: "1/4 piece" },
    ],
    steps: [
      "Tear and crisp the tortillas in a dry pan.",
      "Add the salsa and beans and let it bubble.",
      "Fry the eggs on top and finish with avocado.",
    ],
  },
  {
    id: "b-me-tahini-berry-yogurt", name: "Tahini & Berry Yogurt Bowl", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Thick yogurt swirled with tahini and honey, berries and pumpkin seeds.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "mixed berries", quantity: "100 g" },
      { name: "pumpkin seeds", quantity: "1 tbsp" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Swirl the tahini and honey through the yogurt.", "Top with berries and pumpkin seeds."],
  },

  // -- More weeknight-fast dinners, incl. the second egg dinner and a keto one --
  {
    id: "d-fast-sesame-chicken-soba", name: "Sesame Chicken & Broccoli Soba", type: "dinner",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 18, approxCost: 2,
    dietTags: [],
    description: "Soba noodles tossed with sesame chicken and crisp broccoli.",
    ingredients: [
      { name: "chicken breast", quantity: "170 g" },
      { name: "soba noodles", quantity: "70 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "sesame-soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: [
      "Boil the soba, adding the broccoli for the last two minutes.",
      "Stir-fry the sliced chicken in the sesame oil.",
      "Toss everything with the sauce.",
    ],
  },
  {
    id: "d-fast-lemon-cod-white-beans", name: "Lemon Cod with White Beans", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Pan-roasted cod over garlicky white beans and spinach.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "cannellini beans", quantity: "180 g" },
      { name: "spinach", quantity: "100 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/2 piece" },
    ],
    steps: [
      "Warm the beans with the garlic in the oil and wilt the spinach through.",
      "Pan-roast the cod 4 minutes a side.",
      "Set it on the beans and squeeze the lemon over.",
    ],
  },
  {
    id: "d-fast-creamy-garlic-chicken", name: "Creamy Garlic Chicken & Mushrooms", type: "dinner",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Chicken thighs in a garlic cream sauce with mushrooms and spinach.",
    ingredients: [
      { name: "chicken thigh", quantity: "200 g" },
      { name: "mushrooms", quantity: "150 g" },
      { name: "spinach", quantity: "150 g" },
      { name: "light cream cheese", quantity: "60 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: [
      "Brown the chicken in the oil and set aside.",
      "Cook the mushrooms and garlic, then melt the cheese in with a splash of water.",
      "Return the chicken, wilt the spinach through, and simmer to finish.",
    ],
  },
  {
    id: "d-fast-potato-pepper-tortilla", name: "Potato & Pepper Tortilla", type: "dinner",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "A thick Spanish-style omelette of potato, pepper and onion.",
    ingredients: [
      { name: "eggs", quantity: "4 pieces" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "bell pepper", quantity: "100 g" },
      { name: "onion", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: [
      "Slice the potato thin and soften it with the onion and pepper in the oil.",
      "Pour the beaten eggs over and cook gently until almost set.",
      "Flip or finish under the grill, then rest before slicing.",
    ],
  },
  {
    id: "d-fast-halloumi-chickpea-traybake", name: "Harissa Halloumi & Chickpea Tray", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Harissa-roasted chickpeas and peppers under griddled halloumi.",
    ingredients: [
      { name: "halloumi", quantity: "100 g" },
      { name: "chickpeas", quantity: "1 can" },
      { name: "roasted peppers", quantity: "100 g" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "spinach", quantity: "80 g" },
    ],
    steps: [
      "Toss the chickpeas and peppers with the harissa and roast hot for 12 minutes.",
      "Griddle the halloumi until golden.",
      "Stir the spinach through the hot chickpeas and top with the halloumi.",
    ],
  },

  // -- Keto lunch, pork lunch, italian lunch --
  {
    id: "l-keto-prawn-avocado-feta", name: "Prawn, Avocado & Feta Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "shrimp",
    timeMinutes: 10, approxCost: 3,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Prawns with avocado, feta and greens in a lemon-olive oil dressing.",
    ingredients: [
      { name: "prawns", quantity: "180 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "feta", quantity: "40 g" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Sear the prawns and cool them slightly.", "Build the salad and dress with oil and lemon."],
  },
  {
    id: "l-asian-pork-larb-bowl", name: "Pork Larb-Style Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "pork",
    timeMinutes: 15, approxCost: 2,
    dietTags: [],
    description: "Hot-and-sour minced pork with crunchy veg over rice.",
    ingredients: [
      { name: "pork tenderloin", quantity: "160 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "mixed stir-fry veg", quantity: "120 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sriracha", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: [
      "Chop the pork fine and fry it hard until browned.",
      "Add the veg for two minutes, then the soy and sriracha.",
      "Spoon over the rice and finish with lime.",
    ],
  },
  {
    id: "l-italian-zucchini-ricotta-pasta", name: "Zucchini & Ricotta Lemon Pasta", type: "lunch",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Penne with softened zucchini, ricotta, parmesan and lemon.",
    ingredients: [
      { name: "whole-wheat penne", quantity: "70 g" },
      { name: "ricotta", quantity: "120 g" },
      { name: "zucchini", quantity: "150 g" },
      { name: "parmesan", quantity: "15 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: [
      "Boil the penne.",
      "Soften the sliced zucchini in the oil.",
      "Toss with the ricotta, parmesan and lemon, loosening with pasta water.",
    ],
  },

  // -- Four more snacks that carry protein --
  {
    id: "s-hp-cottage-olive-tomato", name: "Cottage Cheese, Olive & Tomato Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Cottage cheese with olives, tomato and a thread of olive oil.",
    ingredients: [
      { name: "cottage cheese", quantity: "250 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Spoon the cottage cheese into a cup.", "Top with halved tomatoes, olives and the oil."],
  },
  {
    id: "s-hp-smoked-salmon-egg-cup", name: "Smoked Salmon & Egg Cup", type: "snack",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 5, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Boiled egg with smoked salmon, soft cheese and chives.",
    ingredients: [
      { name: "smoked salmon", quantity: "80 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "light cream cheese", quantity: "30 g" },
      { name: "chives", quantity: "1 tbsp" },
    ],
    steps: ["Quarter the boiled eggs.", "Layer with the salmon and cheese and scatter the chives."],
  },
  {
    id: "s-hp-lentil-feta-cup", name: "Lentil & Feta Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Lentils with crumbled feta and cherry tomatoes.",
    ingredients: [
      { name: "green lentils", quantity: "200 g" },
      { name: "feta", quantity: "50 g" },
      { name: "cherry tomatoes", quantity: "60 g" },
    ],
    steps: ["Fork the lentils with the tomatoes.", "Crumble the feta over."],
  },
  {
    id: "s-hp-edamame-tempeh-cup", name: "Edamame & Tempeh Sesame Cup", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Pan-crisped tempeh with edamame and toasted sesame.",
    ingredients: [
      { name: "tempeh", quantity: "100 g" },
      { name: "edamame", quantity: "100 g" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Cube and crisp the tempeh.", "Toss with the warmed edamame, soy and sesame seeds."],
  },

  // ---- Batch 6: breakfast depth outside American ----
  //
  // American breakfast carried 30 dishes; every other cuisine sat at 7-8, so a user who set a
  // cuisine preference got the same handful of mornings on repeat. Six per cuisine here, all
  // <=15 min because breakfast is the meal people have least time for.

  // -- Mediterranean --
  {
    id: "b-med-olive-feta-toast", name: "Feta, Olive & Tomato Toast", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Sourdough under crumbled feta, olives, tomato and good oil.",
    ingredients: [
      { name: "sourdough bread", quantity: "2 slices" },
      { name: "feta", quantity: "50 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the sourdough.", "Crumble the feta over with sliced tomato and olives, then the oil."],
  },
  {
    id: "b-med-white-bean-toast", name: "White Bean & Tomato Toast", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Smashed cannellini beans on toast with tomato and rocket.",
    ingredients: [
      { name: "cannellini beans", quantity: "150 g" },
      { name: "sourdough bread", quantity: "1 slice" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "rocket", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Warm and roughly smash the beans with the oil.", "Pile onto the toast with tomato and rocket."],
  },
  {
    id: "b-med-zucchini-feta-eggs", name: "Zucchini & Feta Scramble", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Soft eggs scrambled with zucchini and salty feta.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "zucchini", quantity: "120 g" },
      { name: "feta", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soften the grated zucchini in the oil.", "Add the beaten eggs and scramble softly, folding in the feta."],
  },
  {
    id: "b-med-yogurt-raspberry-granola", name: "Raspberry & Pumpkin Seed Yogurt", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Thick yogurt with raspberries, granola and pumpkin seeds.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "raspberries", quantity: "80 g" },
      { name: "granola", quantity: "20 g" },
      { name: "pumpkin seeds", quantity: "1 tbsp" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon the yogurt into a bowl.", "Top with raspberries, granola, seeds and honey."],
  },
  {
    id: "b-med-tuna-egg-plate", name: "Tuna & Egg Breakfast Plate", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "A savoury plate of tuna, boiled egg, tomato and olives.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olives", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Boil the eggs and halve them.", "Plate with the drained tuna, tomatoes and olives, and dress with oil."],
  },
  {
    id: "b-med-spinach-ricotta-omelette", name: "Spinach & Ricotta Omelette", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Folded omelette with wilted spinach and creamy ricotta.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "ricotta", quantity: "80 g" },
      { name: "spinach", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Wilt the spinach in the oil.", "Pour the beaten eggs over, dot with ricotta, and fold once set."],
  },

  // -- Asian --
  {
    id: "b-asian-soy-egg-rice", name: "Soy Egg & Rice Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Warm rice with a jammy soy egg, spinach and sesame.",
    ingredients: [
      { name: "cooked rice", quantity: "180 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "spinach", quantity: "60 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Warm the rice and wilt the spinach into it.", "Top with soft-boiled eggs, soy and sesame."],
  },
  {
    id: "b-asian-edamame-avocado-toast", name: "Edamame & Avocado Toast", type: "breakfast",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Smashed edamame and avocado on toast with sesame and chilli.",
    ingredients: [
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "edamame", quantity: "100 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "sesame seeds", quantity: "1 tsp" },
      { name: "sriracha", quantity: "1 tsp" },
    ],
    steps: ["Toast the bread.", "Smash the edamame with the avocado, spread thickly, and finish with sesame and sriracha."],
  },
  {
    id: "b-asian-matcha-yogurt-bowl", name: "Matcha Yogurt & Granola Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Matcha-whisked yogurt with granola, blueberries and chia.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "matcha", quantity: "1 tsp" },
      { name: "granola", quantity: "30 g" },
      { name: "blueberries", quantity: "60 g" },
      { name: "chia seeds", quantity: "1 tbsp" },
    ],
    steps: ["Whisk the matcha into the yogurt.", "Top with granola, blueberries and chia."],
  },
  {
    id: "b-asian-kimchi-egg-rice", name: "Kimchi & Egg Rice Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Fried rice with kimchi, bean sprouts and a fried egg.",
    ingredients: [
      { name: "cooked rice", quantity: "180 g" },
      { name: "kimchi", quantity: "80 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "bean sprouts", quantity: "60 g" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Fry the rice with the kimchi and sprouts in the sesame oil.", "Top with fried eggs."],
  },
  {
    id: "b-asian-miso-tofu-noodle-soup", name: "Miso Tofu Noodle Soup", type: "breakfast",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "A savoury morning bowl of miso broth, soba, tofu and greens.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "soba noodles", quantity: "60 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "bok choy", quantity: "100 g" },
      { name: "bean sprouts", quantity: "60 g" },
    ],
    steps: [
      "Boil the soba and drain.",
      "Whisk the miso into hot water, add the tofu, bok choy and sprouts to warm through.",
      "Pour over the noodles.",
    ],
  },
  {
    id: "b-asian-sesame-banana-yogurt", name: "Sesame & Banana Yogurt Oats", type: "breakfast",
    cuisine: "asian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Yogurt and oats with banana, toasted sesame and honey.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "rolled oats", quantity: "30 g" },
      { name: "banana", quantity: "1 piece" },
      { name: "sesame seeds", quantity: "1 tbsp" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Stir the oats into the yogurt.", "Top with sliced banana, sesame seeds and honey."],
  },

  // -- Mexican --
  {
    id: "b-mexican-black-bean-eggs", name: "Black Bean & Egg Skillet", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Spiced black beans with eggs cracked in and salsa spooned over.",
    ingredients: [
      { name: "black beans", quantity: "150 g" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "salsa", quantity: "60 g" },
      { name: "taco spice", quantity: "1 tsp" },
      { name: "avocado", quantity: "1/4 piece" },
    ],
    steps: [
      "Warm the beans with the spice.",
      "Make two wells, crack in the eggs, cover and cook until set.",
      "Spoon the salsa over and add the avocado.",
    ],
  },
  {
    id: "b-mexican-corn-tortilla-scramble", name: "Tortilla & Pepper Scramble", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Eggs scrambled through crisped tortilla strips with pepper and corn.",
    ingredients: [
      { name: "corn tortillas", quantity: "2 pieces" },
      { name: "eggs", quantity: "3 pieces" },
      { name: "bell pepper", quantity: "100 g" },
      { name: "corn", quantity: "80 g" },
      { name: "salsa", quantity: "50 g" },
    ],
    steps: ["Crisp the sliced tortillas with the pepper.", "Add the corn and beaten eggs and scramble.", "Serve with salsa."],
  },
  {
    id: "b-mexican-refried-bean-toast", name: "Smoky Bean & Avocado Toast", type: "breakfast",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Smashed smoky beans on toast with avocado and lime.",
    ingredients: [
      { name: "black beans", quantity: "150 g" },
      { name: "whole-grain bread", quantity: "1 slice" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "smoked paprika", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Smash the beans with the paprika and warm through.", "Spread on the toast and top with avocado and lime."],
  },
  {
    id: "b-mexican-quinoa-breakfast-bowl", name: "Quinoa & Black Bean Breakfast Bowl", type: "breakfast",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Warm quinoa with black beans, corn, salsa and avocado.",
    ingredients: [
      { name: "quinoa", quantity: "50 g" },
      { name: "black beans", quantity: "120 g" },
      { name: "corn", quantity: "70 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "avocado", quantity: "1/4 piece" },
    ],
    steps: ["Cook the quinoa.", "Fold through the beans and corn to warm.", "Top with salsa and avocado."],
  },
  {
    id: "b-mexican-cottage-chilli-toast", name: "Chilli Cottage Cheese Toast", type: "breakfast",
    cuisine: "mexican", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Cottage cheese on toast with salsa, corn and chilli.",
    ingredients: [
      { name: "cottage cheese", quantity: "180 g" },
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "salsa", quantity: "60 g" },
      { name: "corn", quantity: "60 g" },
      { name: "chili powder", quantity: "1 tsp" },
    ],
    steps: ["Toast the bread.", "Spread with cottage cheese and top with salsa, corn and a dusting of chilli."],
  },
  {
    id: "b-mexican-turkey-hash-peppers", name: "Turkey & Pepper Breakfast Hash", type: "breakfast",
    cuisine: "mexican", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced turkey with sweet potato, peppers and a fried egg.",
    ingredients: [
      { name: "ground turkey", quantity: "120 g" },
      { name: "sweet potato", quantity: "150 g" },
      { name: "bell pepper", quantity: "100 g" },
      { name: "eggs", quantity: "1 piece" },
      { name: "fajita spice", quantity: "1 tsp" },
    ],
    steps: [
      "Dice the sweet potato small and pan-fry covered until tender.",
      "Add the turkey, pepper and spice and brown.",
      "Top with a fried egg.",
    ],
  },

  // -- Italian --
  {
    id: "b-italian-tomato-white-bean-bruschetta", name: "Bean & Tomato Bruschetta", type: "breakfast",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Garlic-rubbed toast with cannellini beans, tomato and basil oil.",
    ingredients: [
      { name: "cannellini beans", quantity: "150 g" },
      { name: "sourdough bread", quantity: "1 slice" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "garlic", quantity: "1 clove" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the bread and rub with the cut garlic.", "Top with the beans and tomatoes and drizzle with oil."],
  },
  {
    id: "b-italian-egg-parmesan-spinach", name: "Baked Eggs with Parmesan & Spinach", type: "breakfast",
    cuisine: "italian", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Eggs baked over wilted spinach under a parmesan crust.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "spinach", quantity: "120 g" },
      { name: "parmesan", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Wilt the spinach in the oil in an ovenproof pan.", "Crack the eggs over, scatter the parmesan, and bake 8 minutes."],
  },
  {
    id: "b-italian-cottage-tomato-basil-toast", name: "Cottage Cheese & Tomato Bruschetta", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Whipped cottage cheese on sourdough with tomatoes and olive oil.",
    ingredients: [
      { name: "cottage cheese", quantity: "200 g" },
      { name: "sourdough bread", quantity: "1 slice" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the sourdough.", "Spread thickly with cottage cheese and top with tomatoes and oil."],
  },
  {
    id: "b-italian-mozzarella-egg-bake", name: "Mozzarella & Tomato Egg Bake", type: "breakfast",
    cuisine: "italian", mainProtein: "eggs",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Eggs baked with mozzarella and tomato, caprese style.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "mozzarella", quantity: "60 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Beat the eggs into an oiled ovenproof pan with the tomatoes.", "Tear the mozzarella over and bake until just set."],
  },
  {
    id: "b-italian-oat-ricotta-berry-pot", name: "Overnight Oats with Ricotta & Berries", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Oats soaked in milk, folded with ricotta and mixed berries.",
    ingredients: [
      { name: "rolled oats", quantity: "50 g" },
      { name: "milk", quantity: "150 ml" },
      { name: "ricotta", quantity: "100 g" },
      { name: "mixed berries", quantity: "80 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Soak the oats in the milk overnight.", "Fold the ricotta through and top with berries and honey."],
  },
  {
    id: "b-italian-pesto-egg-toast", name: "Pesto Egg Toast", type: "breakfast",
    cuisine: "italian", mainProtein: "eggs",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Soft eggs on pesto-spread sourdough with rocket.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "sourdough bread", quantity: "2 slices" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "rocket", quantity: "20 g" },
    ],
    steps: ["Toast the bread and spread with pesto.", "Top with soft-fried eggs and rocket."],
  },

  // -- Middle Eastern --
  {
    id: "b-me-shakshuka-chickpea", name: "Chickpea Shakshuka", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Chickpeas simmered in spiced tomato with peppers — no egg needed.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "bell pepper", quantity: "100 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften the pepper in the oil with the cumin.", "Add the tomatoes and chickpeas and simmer 10 minutes."],
  },
  {
    id: "b-me-labneh-cucumber-toast", name: "Labneh-Style Yogurt & Cucumber Toast", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Thick yogurt on rye with cucumber, olive oil and za'atar spice.",
    ingredients: [
      { name: "greek yogurt", quantity: "180 g" },
      { name: "rye bread", quantity: "2 slices" },
      { name: "cucumber", quantity: "100 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the rye.", "Spread the yogurt thickly, add cucumber, and finish with oil and spice."],
  },
  {
    id: "b-me-zaatar-egg-plate", name: "Spiced Egg & Tomato Plate", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Boiled eggs with tomato, cucumber, olives and spiced oil.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "tomatoes", quantity: "100 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "olives", quantity: "25 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
    ],
    steps: ["Boil and halve the eggs.", "Plate with the chopped salad and olives and dust with the spice."],
  },
  {
    // Honey was in this list under a vegan tag — honey is an animal product, and the diet tag is a
    // hard filter, so that was a lie the engine would have acted on. The banana carries the sweetness.
    id: "b-me-tahini-oat-bowl", name: "Tahini & Banana Oats", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Oats swirled with tahini, banana and cinnamon.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "banana", quantity: "1 piece" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Cook the oats.", "Swirl the tahini through and top with sliced banana and cinnamon."],
  },
  {
    id: "b-me-foul-egg-plate", name: "Spiced Beans & Egg Plate", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Cumin-spiced beans with a boiled egg, lemon and olive oil.",
    ingredients: [
      { name: "cannellini beans", quantity: "180 g" },
      { name: "eggs", quantity: "1 piece" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Warm the beans with the cumin and mash lightly.", "Top with the halved boiled egg, lemon and oil."],
  },
  {
    id: "b-me-halloumi-tomato-plate", name: "Griddled Halloumi & Tomato Plate", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Golden halloumi with tomato, cucumber and a squeeze of lemon.",
    ingredients: [
      { name: "halloumi", quantity: "90 g" },
      { name: "tomatoes", quantity: "100 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "olives", quantity: "20 g" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Griddle the halloumi until golden both sides.", "Plate with the chopped salad, olives and lemon."],
  },

  // -- Indian --
  {
    id: "b-indian-egg-bhurji", name: "Egg Bhurji", type: "breakfast",
    cuisine: "indian", mainProtein: "eggs",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Spiced Indian scrambled eggs with onion, tomato and turmeric.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "onion", quantity: "60 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soften the onion in the oil with the turmeric.", "Add the tomato, then the beaten eggs, and scramble."],
  },
  {
    id: "b-indian-chana-breakfast-bowl", name: "Spiced Chickpea Breakfast Bowl", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Chickpeas tossed with curry spice, tomato, onion and lemon.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "onion", quantity: "50 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Warm the chickpeas with the spice and onion.", "Fold in the tomato and finish with lemon."],
  },
  {
    id: "b-indian-oats-upma", name: "Savoury Oats Upma", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Oats cooked savoury with mixed veg, peanuts and curry spice.",
    ingredients: [
      { name: "rolled oats", quantity: "60 g" },
      { name: "mixed veg", quantity: "120 g" },
      { name: "peanuts", quantity: "20 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Toast the oats in the oil with the spice.", "Add the veg and a splash of water and cook until absorbed.", "Scatter the peanuts over."],
  },
  {
    id: "b-indian-yogurt-mango-seed-bowl", name: "Mango & Pumpkin Seed Yogurt Bowl", type: "breakfast",
    cuisine: "indian", mainProtein: "dairy",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Thick yogurt blended with mango, topped with pumpkin seeds and cinnamon.",
    ingredients: [
      { name: "greek yogurt", quantity: "220 g" },
      { name: "mango", quantity: "1/2 piece" },
      { name: "pumpkin seeds", quantity: "1 tbsp" },
      { name: "cinnamon", quantity: "1 tsp" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Blend or mash the mango into the yogurt.", "Top with seeds, cinnamon and honey."],
  },
  {
    id: "b-indian-masala-tofu-scramble", name: "Masala Tofu Scramble", type: "breakfast",
    cuisine: "indian", mainProtein: "tofu",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Crumbled tofu with turmeric, tomato, onion and spinach.",
    ingredients: [
      { name: "firm tofu", quantity: "220 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "onion", quantity: "60 g" },
      { name: "spinach", quantity: "80 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften the onion in the oil with the turmeric.", "Crumble in the tofu and cook, then add tomato and spinach to wilt."],
  },
  {
    id: "b-indian-lentil-egg-bowl", name: "Dal & Egg Breakfast Bowl", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Cumin dal topped with a boiled egg and spinach.",
    ingredients: [
      { name: "green lentils", quantity: "200 g" },
      { name: "eggs", quantity: "1 piece" },
      { name: "spinach", quantity: "80 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Warm the lentils with the cumin in the oil.", "Wilt the spinach through and top with the halved boiled egg."],
  },

  // ---- Batch 7: lunch depth, six per cuisine ----
  //
  // Lunch is the slot people repeat most and the one a cuisine filter empties fastest — italian
  // and indian sat at 8, mexican at 9. Six per cuisine, spread deliberately across proteins so
  // the diversity cap has somewhere to go.

  // -- Mediterranean --
  {
    id: "l-med-chicken-couscous-salad", name: "Chicken & Couscous Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Griddled chicken over lemony couscous with cucumber and tomato.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "couscous", quantity: "60 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Soak the couscous in boiling water for 5 minutes.", "Griddle and slice the chicken.", "Fork through the salad with oil and lemon."],
  },
  {
    id: "l-med-mackerel-quinoa", name: "Smoked Mackerel & Quinoa Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Peppery mackerel flaked over quinoa with rocket and lemon.",
    ingredients: [
      { name: "smoked mackerel", quantity: "100 g" },
      { name: "quinoa", quantity: "60 g" },
      { name: "rocket", quantity: "40 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Cook and cool the quinoa.", "Flake the mackerel through with the rocket and tomatoes, and finish with lemon."],
  },
  {
    id: "l-med-chickpea-feta-salad", name: "Chickpea & Feta Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Chickpeas with feta, cucumber and tomato in olive oil.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "feta", quantity: "50 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Chop the cucumber and tomato.", "Toss with the chickpeas, crumble the feta over, and dress with oil."],
  },
  {
    id: "l-med-prawn-orzo-salad", name: "Prawn & Orzo Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "shrimp",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Cool orzo salad with seared prawns, tomato and rocket.",
    ingredients: [
      { name: "prawns", quantity: "160 g" },
      { name: "orzo", quantity: "60 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "rocket", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Boil and cool the orzo.", "Sear the prawns.", "Toss everything with oil and lemon."],
  },
  {
    id: "l-med-turkey-bulgur-bowl", name: "Turkey & Bulgur Herb Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Sliced turkey over herby bulgur with tomato and parsley.",
    ingredients: [
      { name: "turkey breast", quantity: "160 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "tomatoes", quantity: "100 g" },
      { name: "parsley", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Griddle and slice the turkey.", "Fork the herbs, oil and lemon through and top."],
  },
  {
    id: "l-med-egg-potato-salad", name: "Egg & Potato Salad Plate", type: "lunch",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Warm potatoes with boiled egg, olives and greens.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Boil the potatoes and eggs together.", "Halve both and plate over the greens with olives and oil."],
  },

  // -- Asian --
  {
    id: "l-asian-chicken-soba-salad", name: "Sesame Chicken Soba Salad", type: "lunch",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 2,
    dietTags: [],
    description: "Cold soba with shredded chicken, cucumber and sesame dressing.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "soba noodles", quantity: "60 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "bean sprouts", quantity: "60 g" },
      { name: "sesame-soy sauce", quantity: "2 tbsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Boil and cool the soba.", "Poach and shred the chicken.", "Toss with the vegetables, sauce and sesame."],
  },
  {
    id: "l-asian-teriyaki-cod-rice", name: "Teriyaki Cod Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: [],
    description: "Glazed cod over rice with steamed broccoli.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
    ],
    steps: ["Pan-fry the cod and glaze with the teriyaki.", "Steam the broccoli.", "Serve over the rice."],
  },
  {
    id: "l-asian-tofu-noodle-salad", name: "Peanut Tofu Noodle Salad", type: "lunch",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Rice noodles with crisp tofu, crunchy veg and peanuts.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "rice noodles", quantity: "60 g" },
      { name: "mixed stir-fry veg", quantity: "120 g" },
      { name: "peanuts", quantity: "20 g" },
      { name: "soy sauce", quantity: "1 tbsp" },
    ],
    steps: ["Soak the noodles.", "Crisp the tofu.", "Toss everything with the soy and scatter the peanuts."],
  },
  {
    id: "l-asian-beef-rice-bowl", name: "Ginger Beef Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "beef",
    timeMinutes: 15, approxCost: 3,
    dietTags: [],
    description: "Seared beef strips with stir-fried veg over rice.",
    ingredients: [
      { name: "beef strips", quantity: "160 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "mixed stir-fry veg", quantity: "130 g" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
    ],
    steps: ["Sear the beef hard and set aside.", "Stir-fry the veg, return the beef with the sauce.", "Spoon over the rice."],
  },
  {
    id: "l-asian-prawn-noodle-bowl", name: "Ginger Prawn Noodle Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "shrimp",
    timeMinutes: 12, approxCost: 3,
    dietTags: [],
    description: "Rice noodles in ginger broth with prawns and bok choy.",
    ingredients: [
      { name: "prawns", quantity: "160 g" },
      { name: "rice noodles", quantity: "60 g" },
      { name: "bok choy", quantity: "120 g" },
      { name: "ginger-soy sauce", quantity: "2 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Soak the noodles.", "Simmer the prawns and bok choy in the sauce loosened with water.", "Pour over the noodles with the sesame oil."],
  },
  {
    id: "l-asian-edamame-quinoa-bowl", name: "Edamame & Quinoa Crunch Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    // Not gluten_free: the sesame-soy dressing is wheat-based. Quinoa and edamame are, the sauce isn't.
    dietTags: ["vegan", "vegetarian"],
    description: "Quinoa with edamame, carrot and cucumber in sesame dressing.",
    ingredients: [
      { name: "quinoa", quantity: "60 g" },
      { name: "edamame", quantity: "120 g" },
      { name: "carrot", quantity: "60 g" },
      { name: "cucumber", quantity: "80 g" },
      { name: "sesame-soy sauce", quantity: "2 tbsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Cook and cool the quinoa.", "Toss with the edamame and julienned veg, then the dressing and seeds."],
  },

  // -- Mexican --
  {
    id: "l-mexican-chipotle-chicken-rice", name: "Smoky Chicken & Bean Rice Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced chicken over rice with black beans and salsa.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "black beans", quantity: "120 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "taco spice", quantity: "1 tsp" },
    ],
    steps: ["Rub the chicken with the spice and griddle.", "Warm the beans and fold into the rice.", "Slice the chicken over and add salsa."],
  },
  {
    id: "l-mexican-turkey-taco-salad", name: "Turkey Taco Salad", type: "lunch",
    cuisine: "mexican", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced turkey over romaine with corn, beans and avocado.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "romaine", quantity: "80 g" },
      { name: "corn", quantity: "80 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "avocado", quantity: "1/4 piece" },
      { name: "taco spice", quantity: "1 tsp" },
    ],
    steps: ["Brown the turkey with the spice.", "Build over the romaine with corn, beans and avocado."],
  },
  {
    id: "l-mexican-shrimp-corn-salad", name: "Shrimp, Corn & Black Bean Salad", type: "lunch",
    cuisine: "mexican", mainProtein: "shrimp",
    timeMinutes: 12, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Charred shrimp with corn, black beans, avocado and lime.",
    ingredients: [
      { name: "shrimp", quantity: "160 g" },
      { name: "corn", quantity: "100 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Char the shrimp and corn in a hot pan.", "Toss with the beans and greens and top with avocado and lime."],
  },
  {
    id: "l-mexican-chickpea-taco-bowl", name: "Chickpea Taco Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced chickpeas with crisped tortilla, salsa and avocado.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "corn tortillas", quantity: "2 pieces" },
      { name: "salsa", quantity: "60 g" },
      { name: "avocado", quantity: "1/4 piece" },
      { name: "taco spice", quantity: "1 tsp" },
    ],
    steps: ["Toss the chickpeas with the spice and pan-roast until crisp.", "Crisp the torn tortillas alongside.", "Build with salsa and avocado."],
  },
  {
    id: "l-mexican-egg-bean-burrito", name: "Egg & Bean Burrito", type: "lunch",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Scrambled eggs and black beans wrapped with salsa and avocado.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "whole-wheat tortilla", quantity: "1 piece" },
      { name: "black beans", quantity: "100 g" },
      { name: "salsa", quantity: "50 g" },
      { name: "avocado", quantity: "1/4 piece" },
    ],
    steps: ["Scramble the eggs.", "Warm the tortilla and fill with beans, egg, salsa and avocado.", "Roll tightly."],
  },
  {
    id: "l-mexican-beef-rice-bowl", name: "Beef & Kidney Bean Rice Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "beef",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced beef mince with kidney beans over rice.",
    ingredients: [
      { name: "lean ground beef", quantity: "150 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "kidney beans", quantity: "120 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "taco spice", quantity: "1 tsp" },
    ],
    steps: ["Brown the beef with the spice.", "Stir in the beans and salsa.", "Spoon over the rice."],
  },

  // -- Italian --
  {
    id: "l-italian-chicken-pesto-pasta", name: "Chicken Pesto Pasta Salad", type: "lunch",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Penne tossed with pesto, chicken, tomato and rocket.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "whole-wheat penne", quantity: "70 g" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "rocket", quantity: "30 g" },
    ],
    steps: ["Boil the penne.", "Griddle and slice the chicken.", "Toss with pesto, tomatoes and rocket."],
  },
  {
    id: "l-italian-tuna-orzo-salad", name: "Tuna & Olive Orzo Salad", type: "lunch",
    cuisine: "italian", mainProtein: "fish",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["mediterranean"],
    description: "Orzo with tuna, olives, tomato and lemon oil.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "orzo", quantity: "60 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olives", quantity: "25 g" },
      { name: "rocket", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Boil and cool the orzo.", "Fork the tuna through with the tomatoes, olives and rocket, then the oil."],
  },
  {
    id: "l-italian-lentil-parmesan-soup", name: "Lentil & Parmesan Soup", type: "lunch",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Thick lentil and tomato soup finished with parmesan.",
    ingredients: [
      { name: "green lentils", quantity: "250 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "carrot", quantity: "80 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften the diced carrot in the oil.", "Add the tomatoes and lentils and simmer 12 minutes.", "Finish with parmesan."],
  },
  {
    id: "l-italian-caprese-bean-salad", name: "Caprese White Bean Salad", type: "lunch",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Cannellini beans with mozzarella, tomato and rocket.",
    ingredients: [
      { name: "cannellini beans", quantity: "180 g" },
      { name: "mozzarella", quantity: "60 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "rocket", quantity: "30 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toss the beans with the tomatoes and rocket.", "Tear the mozzarella over and dress with oil."],
  },
  {
    id: "l-italian-turkey-pesto-wrap", name: "Turkey & Pesto Wrap", type: "lunch",
    cuisine: "italian", mainProtein: "turkey",
    timeMinutes: 8, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Turkey, pesto, rocket and tomato rolled in a wholemeal wrap.",
    ingredients: [
      { name: "turkey breast", quantity: "150 g" },
      { name: "whole-wheat wrap", quantity: "1 piece" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "rocket", quantity: "30 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
    ],
    steps: ["Spread the wrap with pesto.", "Layer the turkey, rocket and tomatoes and roll tightly."],
  },
  {
    id: "l-italian-shrimp-tomato-pasta", name: "Shrimp & Tomato Spaghetti", type: "lunch",
    cuisine: "italian", mainProtein: "shrimp",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Spaghetti with garlicky shrimp in a quick tomato sauce.",
    ingredients: [
      { name: "shrimp", quantity: "170 g" },
      { name: "whole-wheat spaghetti", quantity: "70 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Boil the spaghetti.", "Soften the garlic in the oil, add the tomatoes, then the shrimp for 3 minutes.", "Toss through the pasta."],
  },

  // -- Middle Eastern --
  {
    id: "l-me-chicken-bulgur-bowl", name: "Shawarma Chicken Bulgur Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "chicken",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Spiced chicken over bulgur with cucumber, tomato and lemon.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Rub the chicken with the spice and griddle.", "Build the bowl and finish with lemon."],
  },
  {
    id: "l-me-lentil-tahini-bowl", name: "Lentil & Tahini Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Cumin lentils with wilted spinach under a lemon-tahini drizzle.",
    ingredients: [
      { name: "green lentils", quantity: "220 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "spinach", quantity: "80 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Warm the lentils with the cumin in the oil and wilt the spinach.", "Loosen the tahini with lemon and water and drizzle over."],
  },
  {
    id: "l-me-chickpea-tahini-wrap", name: "Chickpea & Tahini Wrap", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 10, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "mediterranean"],
    description: "Smashed spiced chickpeas with tahini, cucumber and tomato in a wrap.",
    ingredients: [
      { name: "chickpeas", quantity: "200 g" },
      { name: "whole-wheat wrap", quantity: "1 piece" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "cucumber", quantity: "80 g" },
      { name: "tomatoes", quantity: "80 g" },
    ],
    steps: ["Roughly smash the chickpeas with the tahini.", "Spread over the wrap, add the salad, and roll."],
  },
  {
    id: "l-me-turkey-shawarma-bowl", name: "Turkey Shawarma & Hummus Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Spiced turkey over bulgur with hummus and cucumber.",
    ingredients: [
      { name: "turkey breast", quantity: "160 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "hummus", quantity: "2 tbsp" },
      { name: "cucumber", quantity: "100 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Griddle the spiced turkey and slice.", "Spoon the hummus alongside with the cucumber."],
  },
  {
    id: "l-me-egg-hummus-bowl", name: "Egg & Hummus Mezze Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Boiled eggs with hummus, cucumber, tomato and bread.",
    ingredients: [
      { name: "eggs", quantity: "3 pieces" },
      { name: "hummus", quantity: "3 tbsp" },
      { name: "cucumber", quantity: "100 g" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "whole-grain bread", quantity: "1 slice" },
    ],
    steps: ["Boil and halve the eggs.", "Plate with the hummus, chopped salad and toasted bread."],
  },
  {
    id: "l-me-harissa-cod-couscous", name: "Harissa Cod & Couscous", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Harissa-rubbed cod over couscous with roasted peppers.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "couscous", quantity: "60 g" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "roasted peppers", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soak the couscous in boiling water for 5 minutes.", "Rub the cod with harissa and pan-fry.", "Fork the peppers and oil through the couscous."],
  },

  // -- American --
  {
    id: "l-american-chicken-sweet-potato-bowl", name: "Chicken & Sweet Potato Bowl", type: "lunch",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Roast sweet potato with griddled chicken and broccoli.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "sweet potato", quantity: "200 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast the cubed sweet potato in the oil.", "Griddle the chicken and steam the broccoli.", "Build the bowl."],
  },
  {
    id: "l-american-tuna-melt-bowl", name: "Tuna Melt Toasts", type: "lunch",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 10, approxCost: 1,
    dietTags: [],
    description: "Tuna under bubbling cheddar on wholegrain toast with tomato.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "cheddar", quantity: "30 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
    ],
    steps: ["Pile the tuna onto the bread and top with cheddar.", "Grill until bubbling and serve with the tomatoes."],
  },
  {
    id: "l-american-turkey-quinoa-bowl", name: "Turkey & Quinoa Bowl", type: "lunch",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 15, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Sliced turkey with quinoa, green beans and tomato.",
    ingredients: [
      { name: "turkey breast", quantity: "160 g" },
      { name: "quinoa", quantity: "60 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Cook the quinoa.", "Griddle the turkey and steam the beans.", "Toss together with the oil."],
  },
  {
    id: "l-american-bean-chili-bowl", name: "Three-Bean Chili Bowl", type: "lunch",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Kidney beans and corn simmered in spiced tomato over rice.",
    ingredients: [
      { name: "kidney beans", quantity: "200 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "corn", quantity: "80 g" },
      { name: "cooked rice", quantity: "120 g" },
      { name: "chili powder", quantity: "1 tsp" },
    ],
    steps: ["Simmer the tomatoes with the chilli powder.", "Add the beans and corn and cook 10 minutes.", "Spoon over the rice."],
  },
  {
    id: "l-american-salmon-potato-salad", name: "Salmon & Potato Salad", type: "lunch",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Flaked salmon over warm potatoes and green beans.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "mixed greens", quantity: "50 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Boil the potatoes and beans.", "Pan-fry the salmon and flake it.", "Toss everything with the greens and oil."],
  },
  {
    id: "l-american-cottage-chicken-bowl", name: "Chicken & Cottage Cheese Power Bowl", type: "lunch",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 12, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Griddled chicken with cottage cheese, cucumber and tomato.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "cottage cheese", quantity: "150 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "mixed greens", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Griddle and slice the chicken.", "Build over the greens with the cottage cheese and chopped veg, then the oil."],
  },

  // -- Indian --
  {
    id: "l-indian-chicken-tikka-rice", name: "Chicken Tikka Rice Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "chicken",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Chicken simmered in tikka sauce with spinach over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "tikka masala sauce", quantity: "150 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "spinach", quantity: "80 g" },
    ],
    steps: ["Brown the diced chicken.", "Add the sauce and simmer, wilting the spinach through.", "Serve over the rice."],
  },
  {
    id: "l-indian-lentil-rice-bowl", name: "Red Lentil Khichdi Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 20, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Soft-cooked red lentils and rice with curry spice and spinach.",
    ingredients: [
      { name: "red lentils", quantity: "60 g" },
      { name: "cooked rice", quantity: "150 g" },
      { name: "spinach", quantity: "100 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Simmer the lentils until soft.", "Stir in the rice and spice.", "Wilt the spinach through and finish with the oil."],
  },
  {
    id: "l-indian-tandoori-cod-quinoa", name: "Tandoori Cod & Quinoa Salad", type: "lunch",
    cuisine: "indian", mainProtein: "fish",
    timeMinutes: 15, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Yogurt-spiced cod over quinoa with cucumber and greens.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "quinoa", quantity: "50 g" },
      { name: "greek yogurt", quantity: "80 g" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "cucumber", quantity: "100 g" },
      { name: "mixed greens", quantity: "60 g" },
    ],
    steps: ["Cook the quinoa.", "Coat the cod in the yogurt and spice and grill.", "Serve over the quinoa with the salad."],
  },
  {
    id: "l-indian-tikka-tofu-bulgur", name: "Tikka Tofu Bulgur Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "tofu",
    timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Spiced crisp tofu over bulgur with wilted spinach.",
    ingredients: [
      { name: "firm tofu", quantity: "200 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "tikka spice", quantity: "1 tbsp" },
      { name: "spinach", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Crisp the spiced tofu in the oil.", "Wilt the spinach and build the bowl."],
  },
  {
    id: "l-indian-keema-turkey-rice", name: "Turkey Keema & Pea Rice", type: "lunch",
    cuisine: "indian", mainProtein: "turkey",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced turkey mince with peas over rice.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "peas", quantity: "100 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "onion", quantity: "60 g" },
    ],
    steps: ["Soften the onion, add the turkey and spice and brown.", "Stir in the peas.", "Serve over the rice."],
  },
  {
    id: "l-indian-rajma-quinoa", name: "Rajma & Quinoa Bowl", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 18, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Kidney beans in spiced tomato over quinoa.",
    ingredients: [
      { name: "kidney beans", quantity: "200 g" },
      { name: "quinoa", quantity: "60 g" },
      { name: "tomatoes", quantity: "100 g" },
      { name: "onion", quantity: "60 g" },
      { name: "curry powder", quantity: "1 tsp" },
    ],
    steps: ["Cook the quinoa.", "Soften the onion, add the tomato and spice, then the beans.", "Simmer 10 minutes and serve over the quinoa."],
  },

  // ---- Batch 8: dinner depth, six per cuisine ----
  //
  // Dinner carries the day's biggest macro load, so a thin cuisine cell here is what forces the
  // solver to repeat a dish. Kept to <=25 min and <=6 ingredients throughout.

  // -- Mediterranean --
  {
    id: "d-med-chicken-orzo-tray", name: "Chicken, Tomato & Orzo Tray", type: "dinner",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Orzo baked with chicken, burst tomatoes, olives and feta.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "orzo", quantity: "70 g" },
      { name: "cherry tomatoes", quantity: "120 g" },
      { name: "olives", quantity: "25 g" },
      { name: "feta", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Boil the orzo.", "Roast the chicken with the tomatoes and oil.", "Fold together and crumble the feta and olives over."],
  },
  {
    id: "d-med-salmon-couscous", name: "Baked Salmon & Pepper Couscous", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Baked salmon over couscous studded with roasted peppers.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "couscous", quantity: "60 g" },
      { name: "roasted peppers", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Bake the salmon 12 minutes.", "Soak the couscous in boiling water for 5 minutes.", "Fork the peppers, oil and lemon through and top with the salmon."],
  },
  {
    id: "d-med-white-bean-tuna-bake", name: "White Bean & Tuna Bake", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 22, approxCost: 1,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Cannellini beans baked in tomato with tuna and parmesan.",
    ingredients: [
      { name: "cannellini beans", quantity: "200 g" },
      { name: "canned tuna", quantity: "1 can" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Simmer the tomatoes with the beans and oil.", "Fold the tuna through, top with parmesan, and grill until golden."],
  },
  {
    id: "d-med-eggplant-chickpea-bake", name: "Eggplant & Chickpea Bake", type: "dinner",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Roasted eggplant with chickpeas in tomato under crumbled feta.",
    ingredients: [
      { name: "eggplant", quantity: "250 g" },
      { name: "chickpeas", quantity: "200 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "feta", quantity: "40 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast the cubed eggplant in the oil.", "Simmer with the tomatoes and chickpeas.", "Crumble the feta over to finish."],
  },
  {
    id: "d-med-prawn-tomato-bulgur", name: "Garlic Prawns & Tomato Bulgur", type: "dinner",
    cuisine: "mediterranean", mainProtein: "shrimp",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Prawns in garlicky tomato spooned over bulgur.",
    ingredients: [
      { name: "prawns", quantity: "180 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Soften the garlic in the oil, add the tomatoes, then the prawns for 3 minutes.", "Spoon over the bulgur."],
  },
  {
    id: "d-med-lemon-chicken-potatoes", name: "Lemon Chicken & Potatoes", type: "dinner",
    cuisine: "mediterranean", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Chicken thighs roasted with potatoes, green beans and lemon.",
    ingredients: [
      { name: "chicken thigh", quantity: "180 g" },
      { name: "baby potatoes", quantity: "250 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/2 piece" },
    ],
    steps: ["Roast the halved potatoes and chicken in the oil.", "Add the beans for the last 8 minutes.", "Squeeze the lemon over."],
  },

  // -- Asian --
  {
    id: "d-asian-teriyaki-chicken-rice", name: "Teriyaki Chicken & Broccoli Rice", type: "dinner",
    cuisine: "asian", mainProtein: "chicken",
    timeMinutes: 20, approxCost: 2,
    dietTags: [],
    description: "Glazed chicken with steamed broccoli over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
    ],
    steps: ["Pan-fry the chicken and glaze with the teriyaki.", "Steam the broccoli.", "Serve over the rice."],
  },
  {
    id: "d-asian-miso-tofu-soba", name: "Miso Tofu & Bok Choy Soba", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Soba noodles with miso-glazed tofu and bok choy.",
    ingredients: [
      { name: "firm tofu", quantity: "220 g" },
      { name: "soba noodles", quantity: "70 g" },
      { name: "bok choy", quantity: "150 g" },
      { name: "miso paste", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Boil the soba.", "Crisp the tofu and glaze with the miso loosened with water.", "Wilt the bok choy and toss everything with the sesame oil."],
  },
  {
    id: "d-asian-pork-noodle-stirfry", name: "Pork & Vegetable Noodle Stir-Fry", type: "dinner",
    cuisine: "asian", mainProtein: "pork",
    timeMinutes: 20, approxCost: 2,
    dietTags: [],
    description: "Egg noodles tossed with pork and crunchy stir-fry veg.",
    ingredients: [
      { name: "pork tenderloin", quantity: "180 g" },
      { name: "egg noodles", quantity: "70 g" },
      { name: "mixed stir-fry veg", quantity: "130 g" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
    ],
    steps: ["Boil the noodles.", "Stir-fry the sliced pork hard, add the veg.", "Toss with the noodles and sauce."],
  },
  {
    id: "d-asian-salmon-soba", name: "Sesame Salmon Soba", type: "dinner",
    cuisine: "asian", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Salmon over soba noodles with pak choi and sesame dressing.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "soba noodles", quantity: "70 g" },
      { name: "pak choi", quantity: "130 g" },
      { name: "sesame-soy sauce", quantity: "2 tbsp" },
    ],
    steps: ["Boil the soba.", "Pan-fry the salmon.", "Wilt the pak choi and toss the noodles with the sauce, then top with the salmon."],
  },
  {
    id: "d-asian-shrimp-fried-rice", name: "Shrimp & Pea Fried Rice", type: "dinner",
    cuisine: "asian", mainProtein: "shrimp",
    timeMinutes: 15, approxCost: 3,
    dietTags: [],
    description: "Hot-wok rice with shrimp, peas and egg.",
    ingredients: [
      { name: "shrimp", quantity: "170 g" },
      { name: "cooked rice", quantity: "200 g" },
      { name: "peas", quantity: "90 g" },
      { name: "eggs", quantity: "1 piece" },
      { name: "soy sauce", quantity: "1 tbsp" },
      { name: "sesame oil", quantity: "1 tsp" },
    ],
    steps: ["Scramble the egg in the sesame oil and set aside.", "Fry the rice hard with the peas and shrimp.", "Fold the egg back in with the soy."],
  },
  {
    id: "d-asian-tempeh-veg-rice", name: "Teriyaki Tempeh & Veg Rice", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 18, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Glazed tempeh with stir-fried vegetables over rice.",
    ingredients: [
      { name: "tempeh", quantity: "150 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "mixed stir-fry veg", quantity: "130 g" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
    ],
    steps: ["Slice and crisp the tempeh.", "Stir-fry the veg and add the sauce.", "Serve over the rice."],
  },

  // -- Mexican --
  {
    id: "d-mexican-chicken-burrito-bake", name: "Chicken Burrito Bake", type: "dinner",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Rice, beans and chicken baked under enchilada sauce and cheddar.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "black beans", quantity: "120 g" },
      { name: "enchilada sauce", quantity: "150 g" },
      { name: "cheddar", quantity: "30 g" },
    ],
    steps: ["Brown the diced chicken.", "Mix with the rice, beans and sauce in a dish.", "Top with cheddar and bake 15 minutes."],
  },
  {
    id: "d-mexican-cod-tacos-slaw", name: "Cod Tacos with Slaw", type: "dinner",
    cuisine: "mexican", mainProtein: "fish",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Flaked spiced cod in corn tortillas with cabbage slaw and avocado.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "corn tortillas", quantity: "3 pieces" },
      { name: "cabbage", quantity: "100 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "salsa", quantity: "60 g" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Pan-fry and flake the cod.", "Shred the cabbage and dress with lime.", "Fill the warmed tortillas with everything."],
  },
  {
    id: "d-mexican-beef-chilli-rice", name: "Beef Chilli & Rice", type: "dinner",
    cuisine: "mexican", mainProtein: "beef",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Slow-tasting beef chilli with kidney beans over rice.",
    ingredients: [
      { name: "lean ground beef", quantity: "160 g" },
      { name: "kidney beans", quantity: "150 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "cooked rice", quantity: "150 g" },
      { name: "chili powder", quantity: "1 tsp" },
    ],
    steps: ["Brown the beef with the chilli powder.", "Add the tomatoes and beans and simmer 15 minutes.", "Serve over the rice."],
  },
  {
    id: "d-mexican-sweet-potato-bean-bowl", name: "Sweet Potato & Black Bean Bowl", type: "dinner",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Roasted sweet potato with black beans, corn, salsa and avocado.",
    ingredients: [
      { name: "sweet potato", quantity: "250 g" },
      { name: "black beans", quantity: "200 g" },
      { name: "corn", quantity: "80 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "avocado", quantity: "1/4 piece" },
    ],
    steps: ["Roast the cubed sweet potato.", "Warm the beans and corn.", "Build the bowl with salsa and avocado."],
  },
  {
    id: "d-mexican-shrimp-rice-bowl", name: "Chilli Shrimp Rice Bowl", type: "dinner",
    cuisine: "mexican", mainProtein: "shrimp",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Spiced shrimp with black beans and corn over rice.",
    ingredients: [
      { name: "shrimp", quantity: "170 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "corn", quantity: "80 g" },
      { name: "salsa", quantity: "60 g" },
    ],
    steps: ["Sear the shrimp hard.", "Warm the beans and corn into the rice.", "Top with the shrimp and salsa."],
  },
  {
    id: "d-mexican-pork-carnitas-bowl", name: "Pork Carnitas-Style Bowl", type: "dinner",
    cuisine: "mexican", mainProtein: "pork",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Crisped spiced pork over rice with black beans and salsa.",
    ingredients: [
      { name: "pork tenderloin", quantity: "180 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "black beans", quantity: "120 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "taco spice", quantity: "1 tsp" },
    ],
    steps: ["Shred and crisp the spiced pork in a hot pan.", "Warm the beans into the rice.", "Top with the pork and salsa."],
  },

  // -- Italian --
  {
    id: "d-italian-chicken-tomato-penne", name: "Chicken & Tomato Penne", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Penne in a garlic tomato sauce with chicken and parmesan.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "whole-wheat penne", quantity: "70 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "parmesan", quantity: "20 g" },
    ],
    steps: ["Boil the penne.", "Brown the chicken, add the garlic and tomatoes and simmer.", "Toss with the pasta and parmesan."],
  },
  {
    id: "d-italian-salmon-pesto-pasta", name: "Salmon & Pesto Spaghetti", type: "dinner",
    cuisine: "italian", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Spaghetti tossed with pesto, flaked salmon and tomatoes.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "whole-wheat spaghetti", quantity: "70 g" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "rocket", quantity: "30 g" },
    ],
    steps: ["Boil the spaghetti.", "Pan-fry and flake the salmon.", "Toss with pesto, tomatoes and rocket."],
  },
  {
    id: "d-italian-bean-kale-stew", name: "White Bean & Kale Stew", type: "dinner",
    cuisine: "italian", mainProtein: "legumes",
    timeMinutes: 22, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Tuscan-style beans and kale in tomato, finished with parmesan.",
    ingredients: [
      { name: "cannellini beans", quantity: "250 g" },
      { name: "kale", quantity: "100 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soften the garlic in the oil.", "Add the tomatoes and beans and simmer 12 minutes.", "Stir the kale through to wilt and finish with parmesan."],
  },
  {
    id: "d-italian-turkey-meatball-penne", name: "Turkey Meatball Penne", type: "dinner",
    cuisine: "italian", mainProtein: "turkey",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Turkey meatballs in tomato sauce over wholemeal penne.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "whole-wheat penne", quantity: "70 g" },
      { name: "tomato sauce", quantity: "150 g" },
      { name: "parmesan", quantity: "20 g" },
    ],
    steps: ["Roll the turkey into small meatballs and brown.", "Add the sauce and simmer 10 minutes.", "Toss with the penne and parmesan."],
  },
  {
    id: "d-italian-zucchini-ricotta-bake", name: "Zucchini & Ricotta Bake", type: "dinner",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Layered zucchini with ricotta and tomato under melted mozzarella.",
    ingredients: [
      { name: "zucchini", quantity: "250 g" },
      { name: "ricotta", quantity: "150 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "mozzarella", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Griddle the sliced zucchini in the oil.", "Layer with the ricotta and tomatoes.", "Top with mozzarella and bake until bubbling."],
  },
  {
    id: "d-italian-shrimp-tomato-rice", name: "Shrimp & Tomato Rice", type: "dinner",
    cuisine: "italian", mainProtein: "shrimp",
    timeMinutes: 25, approxCost: 3,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Risotto-style rice with shrimp, tomato and parmesan.",
    ingredients: [
      { name: "shrimp", quantity: "170 g" },
      { name: "rice", quantity: "70 g" },
      { name: "chopped tomatoes", quantity: "150 g" },
      { name: "garlic", quantity: "2 cloves" },
      { name: "parmesan", quantity: "20 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toast the rice with the garlic in the oil.", "Add the tomatoes and stock a ladle at a time until tender.", "Stir in the shrimp for 3 minutes, then the parmesan."],
  },

  // -- Middle Eastern --
  {
    id: "d-me-chicken-shawarma-tray", name: "Chicken Shawarma Tray", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Spiced chicken thighs roasted with potatoes and peppers.",
    ingredients: [
      { name: "chicken thigh", quantity: "180 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "bell pepper", quantity: "120 g" },
      { name: "shawarma spice", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Toss everything with the spice and oil.", "Roast hot for 22 minutes, turning once."],
  },
  {
    id: "d-me-lentil-eggplant-stew", name: "Lentil & Eggplant Stew", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Cumin-spiced lentils stewed with roasted eggplant and tomato.",
    ingredients: [
      { name: "green lentils", quantity: "250 g" },
      { name: "eggplant", quantity: "250 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Roast the cubed eggplant in the oil.", "Simmer the tomatoes with the cumin and lentils.", "Fold the eggplant through."],
  },
  {
    id: "d-me-cod-tahini-couscous", name: "Cod with Tahini & Couscous", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Baked cod under lemon tahini with spinach couscous.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "couscous", quantity: "60 g" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "spinach", quantity: "100 g" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Bake the cod 12 minutes.", "Soak the couscous and wilt the spinach through it.", "Loosen the tahini with lemon and water and spoon over."],
  },
  {
    id: "d-me-beef-kofta-tray", name: "Beef Kofta & Bulgur Tray", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "beef",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Cumin beef koftas roasted with tomatoes over bulgur.",
    ingredients: [
      { name: "lean ground beef", quantity: "160 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "tomatoes", quantity: "120 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Shape the beef with the cumin into koftas and roast with the tomatoes.", "Serve over the bulgur."],
  },
  {
    id: "d-me-halloumi-couscous-tray", name: "Harissa Halloumi Couscous Tray", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Griddled halloumi over harissa couscous with roasted peppers.",
    ingredients: [
      { name: "halloumi", quantity: "100 g" },
      { name: "couscous", quantity: "60 g" },
      { name: "roasted peppers", quantity: "100 g" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Soak the couscous in boiling water for 5 minutes.", "Fork the harissa, peppers and oil through.", "Griddle the halloumi and lay it on top."],
  },
  {
    id: "d-me-prawn-harissa-bulgur", name: "Harissa Prawns & Bulgur", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "shrimp",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Harissa prawns with roasted peppers over herby bulgur.",
    ingredients: [
      { name: "prawns", quantity: "180 g" },
      { name: "bulgur", quantity: "60 g" },
      { name: "harissa", quantity: "1 tbsp" },
      { name: "roasted peppers", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Soak the bulgur in boiling water for 10 minutes.", "Sear the prawns with the harissa and oil.", "Fold the peppers through the bulgur and top with the prawns."],
  },

  // -- American --
  {
    id: "d-american-bbq-chicken-sweet-potato", name: "Buffalo Chicken & Sweet Potato", type: "dinner",
    cuisine: "american", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Roast sweet potato with buffalo-glazed chicken and broccoli.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "sweet potato", quantity: "250 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "buffalo sauce", quantity: "30 g" },
    ],
    steps: ["Roast the cubed sweet potato.", "Griddle the chicken and toss in the buffalo sauce.", "Steam the broccoli and plate together."],
  },
  {
    id: "d-american-turkey-meatloaf-veg", name: "Turkey Meatloaf & Vegetables", type: "dinner",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Turkey baked in tomato glaze with potatoes and green beans.",
    ingredients: [
      { name: "ground turkey", quantity: "180 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "tomato sauce", quantity: "100 g" },
    ],
    steps: ["Shape the turkey into a small loaf and glaze with the sauce.", "Bake with the halved potatoes 22 minutes.", "Steam the beans."],
  },
  {
    id: "d-american-salmon-rice-broccoli", name: "Lemon Salmon, Rice & Broccoli", type: "dinner",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "The weeknight standard: baked salmon, rice and broccoli.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/2 piece" },
    ],
    steps: ["Bake the salmon 12 minutes.", "Steam the broccoli.", "Plate with the rice, oil and lemon."],
  },
  {
    id: "d-american-beef-veg-skillet", name: "Beef & Sweet Potato Skillet", type: "dinner",
    cuisine: "american", mainProtein: "beef",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Ground beef with sweet potato and green beans in tomato.",
    ingredients: [
      { name: "lean ground beef", quantity: "160 g" },
      { name: "sweet potato", quantity: "200 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "tomato sauce", quantity: "100 g" },
    ],
    steps: ["Pan-fry the diced sweet potato covered until tender.", "Brown the beef alongside.", "Add the beans and sauce and simmer."],
  },
  {
    id: "d-american-bean-quinoa-bake", name: "Bean & Quinoa Bake", type: "dinner",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 25, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Quinoa baked with kidney beans, corn and tomato under cheddar.",
    ingredients: [
      { name: "kidney beans", quantity: "200 g" },
      { name: "quinoa", quantity: "60 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "corn", quantity: "80 g" },
      { name: "cheddar", quantity: "30 g" },
    ],
    steps: ["Cook the quinoa.", "Mix with the beans, corn and tomatoes in a dish.", "Top with cheddar and bake 15 minutes."],
  },
  {
    id: "d-american-cod-potato-bake", name: "Cod & Potato Traybake", type: "dinner",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Cod baked over potatoes and green beans with lemon.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "baby potatoes", quantity: "250 g" },
      { name: "green beans", quantity: "150 g" },
      { name: "olive oil", quantity: "1 tbsp" },
      { name: "lemon", quantity: "1/2 piece" },
    ],
    steps: ["Roast the halved potatoes in the oil for 15 minutes.", "Add the cod and beans and bake 10 more.", "Squeeze the lemon over."],
  },

  // -- Indian --
  {
    id: "d-indian-chicken-saag", name: "Chicken Saag & Rice", type: "dinner",
    cuisine: "indian", mainProtein: "chicken",
    timeMinutes: 25, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Chicken simmered with spinach, yogurt and spice over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "spinach", quantity: "200 g" },
      { name: "greek yogurt", quantity: "80 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "cooked rice", quantity: "160 g" },
    ],
    steps: ["Brown the diced chicken with the spice.", "Wilt in the spinach, then stir the yogurt through off the heat.", "Serve over the rice."],
  },
  {
    id: "d-indian-chana-masala-rice", name: "Chana Masala & Rice", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 22, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Chickpeas simmered in spiced tomato and onion over rice.",
    ingredients: [
      { name: "chickpeas", quantity: "1 can" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "onion", quantity: "80 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "cooked rice", quantity: "150 g" },
    ],
    steps: ["Soften the onion and toast the spice.", "Add the tomatoes and chickpeas and simmer 15 minutes.", "Serve over the rice."],
  },
  {
    id: "d-indian-cod-curry-rice", name: "Cod Curry & Rice", type: "dinner",
    cuisine: "indian", mainProtein: "fish",
    timeMinutes: 20, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Cod poached in tikka sauce with spinach over rice.",
    ingredients: [
      { name: "cod fillet", quantity: "180 g" },
      { name: "tikka masala sauce", quantity: "150 g" },
      { name: "cooked rice", quantity: "180 g" },
      { name: "spinach", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Warm the sauce with the oil.", "Slide in the cod and poach 8 minutes, wilting the spinach through.", "Serve over the rice."],
  },
  {
    id: "d-indian-tofu-jalfrezi", name: "Tofu Jalfrezi", type: "dinner",
    cuisine: "indian", mainProtein: "tofu",
    timeMinutes: 22, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Crisp tofu with peppers in a dry-spiced tomato sauce over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "220 g" },
      { name: "bell pepper", quantity: "120 g" },
      { name: "chopped tomatoes", quantity: "200 g" },
      { name: "curry powder", quantity: "1 tbsp" },
      { name: "cooked rice", quantity: "150 g" },
    ],
    steps: ["Crisp the cubed tofu.", "Fry the peppers with the spice, add the tomatoes and reduce.", "Fold the tofu back in and serve over the rice."],
  },
  {
    id: "d-indian-prawn-curry-rice", name: "Prawn Curry & Pea Rice", type: "dinner",
    cuisine: "indian", mainProtein: "shrimp",
    timeMinutes: 18, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Prawns in tikka sauce with peas stirred through the rice.",
    ingredients: [
      { name: "prawns", quantity: "180 g" },
      { name: "tikka masala sauce", quantity: "150 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "peas", quantity: "100 g" },
    ],
    steps: ["Warm the sauce and cook the prawns in it for 3 minutes.", "Stir the peas into the hot rice.", "Serve together."],
  },
  {
    id: "d-indian-beef-keema-peas", name: "Beef Keema with Peas", type: "dinner",
    cuisine: "indian", mainProtein: "beef",
    timeMinutes: 22, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Spiced beef mince with peas and onion over rice.",
    ingredients: [
      { name: "lean ground beef", quantity: "160 g" },
      { name: "peas", quantity: "100 g" },
      { name: "cooked rice", quantity: "160 g" },
      { name: "onion", quantity: "70 g" },
      { name: "curry powder", quantity: "1 tbsp" },
    ],
    steps: ["Soften the onion and toast the spice.", "Brown the beef, then add the peas and a splash of water.", "Simmer 10 minutes and serve over the rice."],
  },

  // ---- Batch 9: snack depth, and the library to 500 ----
  //
  // Snacks were the smallest tier (69 against 121-136 elsewhere) and the least useful one —
  // the fourth meal a 4-meals-a-day plan has to fill every single day, out of the shallowest
  // pool. All <=8 minutes and assembled, not cooked, because nobody cooks a snack.

  // -- Mediterranean --
  {
    id: "s-med-white-bean-rosemary-dip", name: "White Bean & Garlic Dip", type: "snack",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Cannellini beans blended smooth with garlic, lemon and oil.",
    ingredients: [
      { name: "cannellini beans", quantity: "150 g" },
      { name: "garlic", quantity: "1 clove" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Blend the beans with the garlic, oil and lemon.", "Loosen with a little water."],
  },
  {
    id: "s-med-tomato-feta-skewers", name: "Tomato, Feta & Olive Skewers", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Cherry tomatoes, feta and olives threaded and dressed with oil.",
    ingredients: [
      { name: "cherry tomatoes", quantity: "120 g" },
      { name: "feta", quantity: "60 g" },
      { name: "olives", quantity: "25 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Thread the tomatoes, cubed feta and olives onto sticks.", "Drizzle with the oil."],
  },
  {
    id: "s-med-egg-olive-plate", name: "Egg, Olive & Tomato Plate", type: "snack",
    cuisine: "mediterranean", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Halved boiled eggs with olives, tomato and olive oil.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "olives", quantity: "30 g" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Halve the boiled eggs.", "Plate with the olives and tomatoes and drizzle with oil."],
  },
  {
    id: "s-med-chickpea-lemon-cup", name: "Lemon & Parsley Chickpea Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "legumes",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Chickpeas dressed simply with lemon, parsley and olive oil.",
    ingredients: [
      { name: "chickpeas", quantity: "150 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
      { name: "parsley", quantity: "1 tbsp" },
    ],
    steps: ["Toss the chickpeas with the oil and lemon.", "Fold the parsley through."],
  },
  {
    id: "s-med-ricotta-honey-walnut", name: "Ricotta, Honey & Walnut Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Whipped ricotta with honey and toasted walnuts.",
    ingredients: [
      { name: "ricotta", quantity: "120 g" },
      { name: "walnuts", quantity: "15 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Beat the ricotta smooth.", "Top with walnuts and honey."],
  },
  {
    id: "s-med-mackerel-cucumber-cup", name: "Mackerel & Cucumber Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "fish",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["keto", "gluten_free", "mediterranean"],
    description: "Flaked smoked mackerel with cucumber and lemon.",
    ingredients: [
      { name: "smoked mackerel", quantity: "80 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Flake the mackerel over the diced cucumber.", "Squeeze the lemon over."],
  },
  {
    id: "s-med-quinoa-feta-cup", name: "Quinoa & Feta Cup", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    timeMinutes: 8, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Cold quinoa forked with feta, tomato and olive oil.",
    ingredients: [
      { name: "quinoa", quantity: "40 g" },
      { name: "feta", quantity: "40 g" },
      { name: "cherry tomatoes", quantity: "60 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Cook and cool the quinoa.", "Fork through the feta, tomatoes and oil."],
  },

  // -- Asian --
  {
    id: "s-asian-edamame-chilli", name: "Chilli Edamame", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Warm edamame tossed with chilli and sesame.",
    ingredients: [
      { name: "edamame", quantity: "150 g" },
      { name: "sriracha", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Steam the edamame.", "Toss with the sriracha and sesame seeds."],
  },
  {
    id: "s-asian-peanut-cucumber-salad", name: "Peanut & Cucumber Salad", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Smashed cucumber with peanuts, soy and chilli.",
    ingredients: [
      { name: "cucumber", quantity: "200 g" },
      { name: "peanuts", quantity: "25 g" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "sriracha", quantity: "1 tsp" },
    ],
    steps: ["Smash and roughly chop the cucumber.", "Toss with the soy and sriracha and scatter the peanuts."],
  },
  {
    id: "s-asian-egg-soy-cup", name: "Soy Egg & Cucumber Cup", type: "snack",
    cuisine: "asian", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "keto"],
    description: "Boiled eggs rolled in soy and sesame with cucumber.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
      { name: "cucumber", quantity: "80 g" },
    ],
    steps: ["Halve the boiled eggs and brush with soy.", "Scatter sesame and serve with cucumber."],
  },
  {
    id: "s-asian-mango-yogurt-sesame", name: "Mango & Sesame Yogurt Cup", type: "snack",
    cuisine: "asian", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Yogurt with fresh mango and toasted sesame.",
    ingredients: [
      { name: "greek yogurt", quantity: "180 g" },
      { name: "mango", quantity: "1/2 piece" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Dice the mango into the yogurt.", "Scatter the sesame over."],
  },
  {
    id: "s-asian-tempeh-teriyaki-bites", name: "Teriyaki Tempeh Bites", type: "snack",
    cuisine: "asian", mainProtein: "tofu",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crisped tempeh cubes glazed with teriyaki and sesame.",
    ingredients: [
      { name: "tempeh", quantity: "100 g" },
      { name: "teriyaki sauce", quantity: "1 tbsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Cube and crisp the tempeh.", "Glaze with the teriyaki and scatter sesame."],
  },
  {
    id: "s-asian-bean-sprout-sesame-cup", name: "Sesame Bean Sprout Cup", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Blanched bean sprouts with sesame oil, soy and peanuts.",
    ingredients: [
      { name: "bean sprouts", quantity: "150 g" },
      { name: "sesame oil", quantity: "1 tsp" },
      { name: "soy sauce", quantity: "1 tsp" },
      { name: "peanuts", quantity: "20 g" },
    ],
    steps: ["Blanch the sprouts for 30 seconds and drain.", "Toss with the oil and soy and scatter the peanuts."],
  },
  {
    id: "s-asian-miso-edamame-cup", name: "Miso Edamame Cup", type: "snack",
    cuisine: "asian", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Steamed edamame tossed in a savoury miso glaze.",
    ingredients: [
      { name: "edamame", quantity: "150 g" },
      { name: "miso paste", quantity: "1 tsp" },
      { name: "sesame seeds", quantity: "1 tsp" },
    ],
    steps: ["Steam the edamame.", "Loosen the miso with a splash of water, toss through, and scatter sesame."],
  },

  // -- Mexican --
  {
    id: "s-mexican-black-bean-corn-cup", name: "Black Bean & Corn Cup", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Black beans with corn, salsa and lime.",
    ingredients: [
      { name: "black beans", quantity: "150 g" },
      { name: "corn", quantity: "80 g" },
      { name: "salsa", quantity: "50 g" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Fork the beans and corn together.", "Stir in the salsa and lime."],
  },
  {
    id: "s-mexican-avocado-lime-cup", name: "Avocado & Lime Cup", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Chunky avocado with tomato, lime and chilli.",
    ingredients: [
      { name: "avocado", quantity: "1 piece" },
      { name: "cherry tomatoes", quantity: "80 g" },
      { name: "lime", quantity: "1/4 piece" },
      { name: "chili powder", quantity: "1 tsp" },
    ],
    steps: ["Cube the avocado.", "Fold through the tomatoes, lime and chilli."],
  },
  {
    id: "s-mexican-cottage-salsa-cup", name: "Salsa Cottage Cheese Cup", type: "snack",
    cuisine: "mexican", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Cottage cheese with salsa and sweetcorn.",
    ingredients: [
      { name: "cottage cheese", quantity: "200 g" },
      { name: "salsa", quantity: "60 g" },
      { name: "corn", quantity: "60 g" },
    ],
    steps: ["Spoon the cottage cheese into a cup.", "Top with the salsa and corn."],
  },
  {
    id: "s-mexican-chicken-lime-cup", name: "Chilli Chicken & Lime Cup", type: "snack",
    cuisine: "mexican", mainProtein: "chicken",
    timeMinutes: 5, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Shredded chicken with salsa, avocado and lime.",
    ingredients: [
      { name: "chicken breast", quantity: "120 g" },
      { name: "salsa", quantity: "50 g" },
      { name: "avocado", quantity: "1/4 piece" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Shred the cooked chicken.", "Fold through the salsa, avocado and lime."],
  },
  {
    id: "s-mexican-kidney-bean-dip", name: "Chilli Kidney Bean Dip", type: "snack",
    cuisine: "mexican", mainProtein: "legumes",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Blended kidney beans with chilli, salsa and lime.",
    ingredients: [
      { name: "kidney beans", quantity: "160 g" },
      { name: "salsa", quantity: "50 g" },
      { name: "chili powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Blend the beans with the salsa and chilli.", "Finish with lime."],
  },
  {
    id: "s-mexican-egg-salsa-cup", name: "Egg & Salsa Cup", type: "snack",
    cuisine: "mexican", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Boiled eggs with salsa and avocado.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "salsa", quantity: "60 g" },
      { name: "avocado", quantity: "1/4 piece" },
    ],
    steps: ["Chop the boiled eggs.", "Fold through the salsa and avocado."],
  },

  // -- Italian --
  {
    id: "s-italian-mozzarella-tomato-basil", name: "Mozzarella & Tomato Cup", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Torn mozzarella with cherry tomatoes and olive oil.",
    ingredients: [
      { name: "mozzarella", quantity: "80 g" },
      { name: "cherry tomatoes", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Tear the mozzarella over the halved tomatoes.", "Dress with the oil."],
  },
  {
    id: "s-italian-tuna-bean-cup", name: "Tuna & Cannellini Cup", type: "snack",
    cuisine: "italian", mainProtein: "fish",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["gluten_free", "mediterranean"],
    description: "Tuna forked through white beans with parsley and oil.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "cannellini beans", quantity: "120 g" },
      { name: "olive oil", quantity: "1 tsp" },
      { name: "parsley", quantity: "1 tbsp" },
    ],
    steps: ["Fork the tuna through the beans.", "Dress with oil and parsley."],
  },
  {
    id: "s-italian-ricotta-berry-cup", name: "Ricotta & Berry Cup", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Whipped ricotta with mixed berries and honey.",
    ingredients: [
      { name: "ricotta", quantity: "150 g" },
      { name: "mixed berries", quantity: "80 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Beat the ricotta smooth.", "Top with berries and honey."],
  },
  {
    id: "s-italian-turkey-parmesan-rolls", name: "Turkey & Parmesan Rolls", type: "snack",
    cuisine: "italian", mainProtein: "turkey",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Turkey slices rolled around parmesan and rocket.",
    ingredients: [
      { name: "turkey breast", quantity: "120 g" },
      { name: "parmesan", quantity: "20 g" },
      { name: "rocket", quantity: "20 g" },
    ],
    steps: ["Shave the parmesan.", "Roll the turkey around the parmesan and rocket."],
  },
  {
    id: "s-italian-pesto-cottage-cup", name: "Pesto Cottage Cheese Cup", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Cottage cheese rippled with pesto and cherry tomatoes.",
    ingredients: [
      { name: "cottage cheese", quantity: "200 g" },
      { name: "pesto", quantity: "1 tbsp" },
      { name: "cherry tomatoes", quantity: "80 g" },
    ],
    steps: ["Ripple the pesto through the cottage cheese.", "Top with halved tomatoes."],
  },
  {
    id: "s-italian-almond-parmesan-plate", name: "Almond, Parmesan & Olive Plate", type: "snack",
    cuisine: "italian", mainProtein: "dairy",
    timeMinutes: 2, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Shaved parmesan with almonds and olives.",
    ingredients: [
      { name: "almonds", quantity: "25 g" },
      { name: "parmesan", quantity: "25 g" },
      { name: "olives", quantity: "20 g" },
    ],
    steps: ["Shave the parmesan.", "Plate with the almonds and olives."],
  },

  // -- Middle Eastern --
  {
    id: "s-me-hummus-egg-cup", name: "Hummus & Egg Cup", type: "snack",
    cuisine: "middle_eastern", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "mediterranean"],
    description: "Boiled egg over hummus with cucumber.",
    ingredients: [
      { name: "hummus", quantity: "3 tbsp" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "cucumber", quantity: "80 g" },
    ],
    steps: ["Spread the hummus into a cup.", "Top with the halved eggs and cucumber."],
  },
  {
    id: "s-me-zaatar-halloumi-cup", name: "Spiced Halloumi & Tomato Cup", type: "snack",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 6, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Griddled halloumi dusted with spice, with tomato.",
    ingredients: [
      { name: "halloumi", quantity: "80 g" },
      { name: "shawarma spice", quantity: "1 tsp" },
      { name: "tomatoes", quantity: "80 g" },
    ],
    steps: ["Griddle the halloumi until golden.", "Dust with the spice and serve with the tomato."],
  },
  {
    id: "s-me-chickpea-harissa-cup", name: "Harissa Chickpea Cup", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free", "mediterranean"],
    description: "Chickpeas tossed in harissa with lemon.",
    ingredients: [
      { name: "chickpeas", quantity: "160 g" },
      { name: "harissa", quantity: "1 tsp" },
      { name: "lemon", quantity: "1/4 piece" },
    ],
    steps: ["Toss the chickpeas with the harissa.", "Finish with lemon."],
  },
  {
    id: "s-me-yogurt-walnut-honey", name: "Yogurt, Walnut & Honey Cup", type: "snack",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free", "mediterranean"],
    description: "Thick yogurt with walnuts and honey.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "walnuts", quantity: "20 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon the yogurt into a cup.", "Top with walnuts and honey."],
  },
  {
    id: "s-me-feta-olive-cucumber", name: "Feta, Olive & Cucumber Plate", type: "snack",
    cuisine: "middle_eastern", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free", "mediterranean"],
    description: "Feta with olives, cucumber and olive oil.",
    ingredients: [
      { name: "feta", quantity: "60 g" },
      { name: "olives", quantity: "25 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "olive oil", quantity: "1 tsp" },
    ],
    steps: ["Cube the feta and cucumber.", "Plate with the olives and drizzle with oil."],
  },
  {
    id: "s-me-tahini-apple-slices", name: "Tahini & Cinnamon Apple", type: "snack",
    cuisine: "middle_eastern", mainProtein: "legumes",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Apple slices with tahini and cinnamon.",
    ingredients: [
      { name: "apple", quantity: "1 piece" },
      { name: "tahini", quantity: "1 tbsp" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Slice the apple.", "Drizzle with tahini and dust with cinnamon."],
  },

  // -- American --
  {
    id: "s-american-cottage-berry-cup", name: "Cottage Cheese & Berry Cup", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Cottage cheese with mixed berries and honey.",
    ingredients: [
      { name: "cottage cheese", quantity: "200 g" },
      { name: "mixed berries", quantity: "80 g" },
      { name: "honey", quantity: "1 tsp" },
    ],
    steps: ["Spoon the cottage cheese into a cup.", "Top with berries and honey."],
  },
  {
    id: "s-american-turkey-avocado-cup", name: "Turkey & Avocado Cup", type: "snack",
    cuisine: "american", mainProtein: "turkey",
    timeMinutes: 4, approxCost: 2,
    dietTags: ["keto", "gluten_free"],
    description: "Sliced turkey with avocado and cherry tomatoes.",
    ingredients: [
      { name: "turkey breast", quantity: "120 g" },
      { name: "avocado", quantity: "1/2 piece" },
      { name: "cherry tomatoes", quantity: "60 g" },
    ],
    steps: ["Slice the turkey and avocado.", "Plate with the halved tomatoes."],
  },
  {
    id: "s-american-pb-banana-cup", name: "Peanut Butter & Banana Cup", type: "snack",
    cuisine: "american", mainProtein: "legumes",
    timeMinutes: 2, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Banana with peanut butter and cinnamon.",
    ingredients: [
      { name: "banana", quantity: "1 piece" },
      { name: "peanut butter", quantity: "1 tbsp" },
      { name: "cinnamon", quantity: "1 tsp" },
    ],
    steps: ["Slice the banana.", "Drizzle with peanut butter and dust with cinnamon."],
  },
  {
    id: "s-american-tuna-egg-plate", name: "Tuna & Egg Plate", type: "snack",
    cuisine: "american", mainProtein: "fish",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["keto", "gluten_free"],
    description: "Tuna with boiled egg and cucumber.",
    ingredients: [
      { name: "canned tuna", quantity: "1 can" },
      { name: "eggs", quantity: "2 pieces" },
      { name: "cucumber", quantity: "80 g" },
    ],
    steps: ["Halve the boiled eggs.", "Plate with the drained tuna and cucumber."],
  },
  {
    id: "s-american-yogurt-granola-apple", name: "Yogurt, Granola & Apple Cup", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Yogurt with granola and diced apple.",
    ingredients: [
      { name: "greek yogurt", quantity: "200 g" },
      { name: "granola", quantity: "25 g" },
      { name: "apple", quantity: "1/2 piece" },
    ],
    steps: ["Spoon the yogurt into a cup.", "Top with granola and diced apple."],
  },
  {
    id: "s-american-cheddar-apple-walnut", name: "Cheddar, Apple & Walnut Plate", type: "snack",
    cuisine: "american", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Sharp cheddar with apple slices and walnuts.",
    ingredients: [
      { name: "cheddar", quantity: "40 g" },
      { name: "apple", quantity: "1/2 piece" },
      { name: "walnuts", quantity: "15 g" },
    ],
    steps: ["Slice the cheddar and apple.", "Plate with the walnuts."],
  },
  {
    id: "s-american-egg-cheddar-cup", name: "Egg & Cheddar Cup", type: "snack",
    cuisine: "american", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Boiled eggs with cubed cheddar and tomato.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "cheddar", quantity: "30 g" },
      { name: "cherry tomatoes", quantity: "60 g" },
    ],
    steps: ["Halve the boiled eggs.", "Plate with the cubed cheddar and tomatoes."],
  },

  // -- Indian --
  {
    id: "s-indian-lentil-yogurt-cup", name: "Cumin Lentil & Yogurt Cup", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Cumin-spiced lentils spooned under thick yogurt.",
    ingredients: [
      { name: "green lentils", quantity: "180 g" },
      { name: "greek yogurt", quantity: "80 g" },
      { name: "cumin", quantity: "1 tsp" },
    ],
    steps: ["Toss the lentils with the cumin.", "Spoon the yogurt over."],
  },
  {
    id: "s-indian-spiced-peanut-cup", name: "Turmeric Peanut Cup", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Peanuts toasted with turmeric and finished with lime.",
    ingredients: [
      { name: "peanuts", quantity: "35 g" },
      { name: "turmeric", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Toast the peanuts with the turmeric in a dry pan.", "Squeeze the lime over."],
  },
  {
    id: "s-indian-egg-masala-cup", name: "Masala Egg Cup", type: "snack",
    cuisine: "indian", mainProtein: "eggs",
    timeMinutes: 5, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Boiled eggs with turmeric, tomato and onion.",
    ingredients: [
      { name: "eggs", quantity: "2 pieces" },
      { name: "tomatoes", quantity: "80 g" },
      { name: "onion", quantity: "40 g" },
      { name: "turmeric", quantity: "1 tsp" },
    ],
    steps: ["Chop the boiled eggs.", "Fold through the diced tomato, onion and turmeric."],
  },
  {
    id: "s-indian-cucumber-peanut-salad", name: "Cucumber & Peanut Chaat", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Diced cucumber with peanuts, chilli and lime.",
    ingredients: [
      { name: "cucumber", quantity: "200 g" },
      { name: "peanuts", quantity: "25 g" },
      { name: "chili powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Dice the cucumber.", "Toss with the peanuts, chilli and lime."],
  },
  {
    id: "s-indian-yogurt-cumin-cup", name: "Cumin Raita Cup", type: "snack",
    cuisine: "indian", mainProtein: "dairy",
    timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Cooling yogurt with cucumber, cumin and pumpkin seeds.",
    ingredients: [
      { name: "greek yogurt", quantity: "220 g" },
      { name: "cucumber", quantity: "100 g" },
      { name: "cumin", quantity: "1 tsp" },
      { name: "pumpkin seeds", quantity: "1 tbsp" },
    ],
    steps: ["Grate the cucumber into the yogurt with the cumin.", "Scatter the seeds over."],
  },
  {
    id: "s-indian-rajma-cup", name: "Spiced Rajma Cup", type: "snack",
    cuisine: "indian", mainProtein: "legumes",
    timeMinutes: 4, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Kidney beans with curry spice, onion and lime.",
    ingredients: [
      { name: "kidney beans", quantity: "160 g" },
      { name: "onion", quantity: "40 g" },
      { name: "curry powder", quantity: "1 tsp" },
      { name: "lime", quantity: "1/4 piece" },
    ],
    steps: ["Toss the beans with the spice and finely diced onion.", "Finish with lime."],
  },
];

/** The library the whole engine uses. Macros come from the food, not from a card. */
export const RECIPES: Recipe[] = SEED_RECIPES.map(deriveMacros);

// --- Selection engine ------------------------------------------------------

type SlotSplit = [Recipe["type"], number][];

function localSplit(mealsPerDay: number): SlotSplit {
  return mealsPerDay === 4
    ? [
        ["breakfast", 0.27],
        ["lunch", 0.31],
        ["dinner", 0.31],
        ["snack", 0.11],
      ]
    : [
        ["breakfast", 0.3],
        ["lunch", 0.35],
        ["dinner", 0.35],
      ];
}

function budgetCap(b: UserProfile["budget"]): number {
  return b === "low" ? 2 : 3;
}

function passesDiet(r: Recipe, diet: UserProfile["diet"]): boolean {
  switch (diet) {
    case "none":
      return true;
    case "vegan":
      return r.dietTags.includes("vegan");
    case "vegetarian":
      return r.dietTags.includes("vegetarian") || r.dietTags.includes("vegan");
    case "keto":
      return r.dietTags.includes("keto");
    case "mediterranean":
      return r.dietTags.includes("mediterranean");
    default:
      return true;
  }
}

function blockedByExclusions(r: Recipe, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  // Include steps so method exclusions work too ("no oven" → drop bake/roast recipes).
  // Matching is word-aware and expands categories: "nuts" must block almonds (a raw substring
  // test did not), while "egg" must NOT block eggplant. Allergies are a hard rule.
  const hay = `${r.name} ${r.ingredients.map((i) => i.name).join(" ")} ${r.steps.join(" ")}`;
  return haystackBlocked(hay, tokens);
}

// Find the library recipe that best matches a free-text dish request (e.g.
// "cottage cheese pancakes"), respecting diet/exclusions/budget and an optional
// meal type. Used for "swap X with <specific dish>".
export function findRecipe(
  query: string,
  type: Recipe["type"] | undefined,
  profile: UserProfile,
): Recipe | null {
  const words = query
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return null;
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  let best: Recipe | null = null;
  let bestScore = 0;
  for (const r of RECIPES) {
    if (type && r.type !== type) continue;
    if (!passesDiet(r, profile.diet) || blockedByExclusions(r, tokens) || r.approxCost > cap) continue;
    const hay =
      `${r.name} ${r.description} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : null;
}

// Micronutrients per recipe, computed once from the USDA-mapped ingredients.
const microsCache = new Map<string, ReturnType<typeof microsForIngredients>>();
export function recipeMicros(r: Recipe) {
  let m = microsCache.get(r.id);
  if (!m) {
    const raw = microsForIngredients(r.ingredients);
    const per = Math.max(1, r.servings ?? 1);
    m = per === 1
      ? raw
      : { coverage: raw.coverage, micros: Object.fromEntries(Object.entries(raw.micros).map(([k, v]) => [k, v / per])) as typeof raw.micros };
    microsCache.set(r.id, m);
  }
  return m;
}

interface PickContext {
  target: number;
  proteinTarget?: number; // grams of protein this slot should aim for
  carbTarget?: number; // grams of carbohydrate this slot should aim for
  fatTarget?: number; // grams of fat this slot should aim for
  proteinDays: Record<string, number>;
  usedIds: Set<string>;
  usedNames: Set<string>;
  dayCuisines: Set<string>;
  usedIngredients: Set<string>;
  fridge?: Set<string>; // on-hand ingredients to prefer ("use what's in my fridge")
  preferFiber?: boolean;
  boost?: MicroKey; // nutrient to favour ("I'm low on iron")
  ketoCarbs?: boolean; // prefer the lowest-carb dish among keto-eligible ones
  ratings?: ReadonlyMap<string, number>; // lowercased recipe name -> 1..5, what the user thought
}

// Choose the best candidate: prefer unused dishes, then a fresh protein, then a
// new cuisine for the day, then closest to the calorie target — with a little
// randomness among the top few so "generate again" varies.
function chooseRecipe(candidates: Recipe[], ctx: PickContext): Recipe | null {
  if (candidates.length === 0) return null;
  let pool = candidates.filter(
    (r) => !ctx.usedIds.has(r.id) && !ctx.usedNames.has(r.name.toLowerCase()),
  );
  if (pool.length === 0) pool = candidates; // relax: allow a repeat if we must

  const freshProtein = pool.filter((r) => (ctx.proteinDays[r.mainProtein] ?? 0) < 3);
  if (freshProtein.length) pool = freshProtein;

  const newCuisine = pool.filter((r) => !ctx.dayCuisines.has(r.cuisine));
  if (newCuisine.length) pool = newCuisine;

  // Dishes the user loved (4-5). Applied as a pool filter, not a score bonus, because the scoring
  // window below is the six closest dishes by calorie distance — a loved dish sitting seventh
  // would never be seen. Placed BEFORE the fridge filter so "use up the salmon", which is a
  // guarantee, still wins over a taste preference.
  if (ctx.ratings?.size) {
    const loved = pool.filter((r) => (ctx.ratings!.get(r.name.toLowerCase()) ?? 0) >= 4);
    if (loved.length) pool = loved;
  }

  // "Use what's in my fridge" — strongly prefer recipes built on on-hand items.
  const fridgeMatch = ctx.fridge
    ? pool.filter((r) => r.ingredients.some((i) => ctx.fridge!.has(i.name.trim().toLowerCase())))
    : [];
  if (fridgeMatch.length) pool = fridgeMatch;

  // PRIMARY RANK — macro fit, scored on density PER CALORIE (portions scale to the slot's calorie
  // target anyway, so what a dish really contributes is its grams-per-calorie). This used to be a
  // pure calorie-distance sort with the macro terms bolted onto the tiebreak below, where they were
  // outvoted by ingredient-reuse and fat ran 15-25% over target on every non-keto diet. Macro fit is
  // the ONLY lever for a day's carb/fat balance — portion-scaling moves a meal's macros together,
  // never their ratio — so it belongs in the primary rank, not the tiebreak.
  const targetDensity = ctx.proteinTarget && ctx.target > 0 ? ctx.proteinTarget / ctx.target : 0;
  const carbDensity = ctx.carbTarget && ctx.target > 0 ? ctx.carbTarget / ctx.target : 0;
  const fatDensity = ctx.fatTarget && ctx.target > 0 ? ctx.fatTarget / ctx.target : 0;
  const calDenom = Math.max(ctx.target, 1);
  const fitDistance = (r: Recipe) => {
    // Guard the divisor: fitDistance drives the PRIMARY sort now, so a 0-calorie recipe producing a
    // NaN would corrupt the ordering, not just lose a tiebreak.
    const cal = Math.max(1, r.calories);
    return (
      // Stay scalable to the slot's calories (the clamp is 0.6-1.8x), so calorie distance leads.
      (Math.abs(r.calories - ctx.target) / calDenom) * 2 +
      // Fat and carbs, two-sided — a dish can miss high or low. Keto keeps its own stronger one-sided
      // carb pull below, so the generic carb term steps aside when keto is active.
      (fatDensity > 0 ? Math.abs(r.fatGrams / cal - fatDensity) * 24 : 0) +
      (carbDensity > 0 && !ctx.ketoCarbs ? Math.abs(r.carbsGrams / cal - carbDensity) * 11 : 0) +
      // Protein only penalised when SHORT — scaling can't raise protein per calorie, so a low-protein
      // pick can't be rescued downstream; being over is fine.
      (targetDensity > 0 ? Math.max(0, targetDensity - r.proteinGrams / cal) * 12 : 0) +
      // Keto: drive carbs as low as the eligible pool allows. Weighted to DOMINATE the fit (net carbs
      // under 50g/day is a hard invariant, not a preference), the way the old one-sided carb term did.
      (ctx.ketoCarbs ? (r.carbsGrams / cal) * 250 : 0)
    );
  };
  const sorted = [...pool].sort((a, b) => fitDistance(a) - fitDistance(b));
  // Among the best-fitting few, break ties by shopping convenience: reuse the week's ingredients,
  // pick cheaper dishes, favour the fridge and a nutrient boost, and shed a "meh" rating. A little
  // randomness among the near-best keeps "generate again" fresh.
  const top = sorted.slice(0, Math.min(8, sorted.length));
  const score = (r: Recipe) =>
    r.ingredients.filter((i) => ctx.usedIngredients.has(i.name.trim().toLowerCase())).length -
    r.approxCost +
    (ctx.preferFiber ? (r.fiberGrams ?? 0) * 0.5 : 0) +
    (ctx.fridge
      ? r.ingredients.filter((i) => ctx.fridge!.has(i.name.trim().toLowerCase())).length * 3
      : 0) +
    (ctx.boost
      ? microDensity(recipeMicros(r).micros, r.calories, ctx.boost) *
        (2000 / DAILY_REFERENCE[ctx.boost]) *
        4
      : 0) +
    // Keto again in the final pick: the fit-sort above puts the lowest-carb dishes in the window,
    // but the random tiebreak must not then trade one away for a cheaper, higher-carb dish. Net
    // carbs under 50g/day is a hard invariant, so keto carbs dominate the pick as well as the sort.
    (ctx.ketoCarbs ? -(r.carbsGrams / Math.max(1, r.calories)) * 900 : 0) -
    ((ctx.ratings?.get(r.name.toLowerCase()) ?? 0) === 2 ? 8 : 0);
  const maxScore = Math.max(...top.map(score));
  const best = top.filter((r) => score(r) >= maxScore - 0.5);
  return best[Math.floor(Math.random() * best.length)];
}

// Scale a numeric ingredient quantity ("150 g", "1/2 piece") by a factor so the
// recipe's portions match its scaled calories. Best-effort: leaves anything it
// can't parse untouched.
function scaleQuantity(q: string, f: number): string {
  const m = q.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (!m) return q;
  const value = (m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])) * f;
  if (!Number.isFinite(value) || value <= 0) return q;
  const rest = q.slice(m[0].length);
  const isMass = /\b(g|ml|kg|l)\b/i.test(rest);
  let rounded = isMass ? Math.round(value / 5) * 5 : Math.round(value * 2) / 2;
  if (rounded <= 0) rounded = isMass ? 5 : 0.5;
  const num = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${num}${rest}`;
}

// Portion-scale a recipe so its calories/macros hit the per-meal target. This is
// what lets a modest library hit any calorie goal without needing a perfectly
// sized recipe for every target. Factor is clamped so portions stay realistic.
function scaleRecipeToTarget(r: Recipe, target: number): Recipe {
  const f = Math.max(0.6, Math.min(1.8, target / r.calories));
  if (Math.abs(f - 1) < 0.08) return r; // already close — don't fiddle
  return {
    ...r,
    calories: Math.round(r.calories * f),
    proteinGrams: Math.round(r.proteinGrams * f),
    carbsGrams: Math.round(r.carbsGrams * f),
    fatGrams: Math.round(r.fatGrams * f),
    ...(r.fiberGrams != null ? { fiberGrams: Math.round(r.fiberGrams * f) } : {}),
    ingredients: r.ingredients.map((i) => ({ ...i, quantity: scaleQuantity(i.quantity, f) })),
  };
}

// Week-level state carried across days so the plan stays varied (no repeated
// dishes/proteins) and cheap (reuses ingredients already on the list).
interface WeekCtx {
  proteinDays: Record<string, number>;
  usedIds: Set<string>;
  usedNames: Set<string>;
  usedIngredients: Set<string>;
  fridge?: Set<string>; // on-hand ingredients to prefer across the week
  boost?: MicroKey; // nutrient to favour across the week
  ketoCarbs?: boolean; // prefer the lowest-carb dish among keto-eligible ones
  ratings?: ReadonlyMap<string, number>; // lowercased recipe name -> 1..5
}

/** The user's ratings as the selector wants them: lowercased name -> 1..5. */
export function ratingMap(profile: UserProfile): ReadonlyMap<string, number> {
  return new Map((profile.mealRatings ?? []).map((r) => [r.name.toLowerCase(), r.rating]));
}

/**
 * "Never serve me this again." Every path that PUTS a recipe into a plan must consult this, not
 * just the day selector — the protein rebalancer and the nutrient boost both re-pick dishes on
 * their own, and a ban that only covers one of the three is not a ban. (It didn't: a one-starred
 * breakfast came back in 5 of 25 weeks, swapped in by the protein lever.)
 *
 * A ban is a preference, so each caller decides its own fallback. Where the fallback is "keep the
 * meal that's already there", skipping is free. Where it's "leave the slot empty", it must relax.
 */
function bannedForUser(profile: UserProfile, name: string): boolean {
  const list = profile.mealRatings;
  if (!list?.length) return false;
  const lower = name.toLowerCase();
  return list.some((r) => r.rating === 1 && r.name.toLowerCase() === lower);
}

function newCtx(): WeekCtx {
  return { proteinDays: {}, usedIds: new Set(), usedNames: new Set(), usedIngredients: new Set() };
}

function exclusionTokens(profile: UserProfile): string[] {
  return parseExclusionTokens(profile.allergies, profile.dislikes);
}

/**
 * What the selector had to compromise on. The product rule is "soft preferences may be relaxed
 * but ONLY with disclosure" — before this existed, pickMealsForDay quietly handed a 30-minute
 * meal to a user who asked for 15, and quietly dropped a meal entirely when no recipe fit the
 * diet (keto + 4 meals silently produced 3).
 */
export interface SelectionReport {
  droppedSlots: string[];
  slowestOverLimit: number; // worst cook time placed above the user's limit (0 = none)
  relaxedBudget: boolean;
  // A slot where every remaining dish was one the user asked never to see again. We served one
  // anyway — and, per the disclosure rule, we say so.
  servedBannedDish: boolean;
}

export const newReport = (): SelectionReport => ({
  droppedSlots: [], slowestOverLimit: 0, relaxedBudget: false, servedBannedDish: false,
});

/** Turn a report into honest, user-facing sentences. Empty when nothing was compromised. */
export function reportNotes(rep: SelectionReport, profile: UserProfile): string[] {
  const out: string[] = [];
  if (rep.droppedSlots.length) {
    const uniq = [...new Set(rep.droppedSlots)];
    out.push(
      `I couldn't find a ${uniq.join(" or ")} that fits your ${profile.diet !== "none" ? profile.diet + " " : ""}rules, so ${uniq.length > 1 ? "those meals are" : "that meal is"} missing from some days.`,
    );
  }
  if (rep.slowestOverLimit > profile.maxCookTime + 5)
    out.push(
      `Heads up: you asked for meals under ${profile.maxCookTime} min, but the only options that fit your other rules take up to ${rep.slowestOverLimit} min.`,
    );
  if (rep.relaxedBudget) out.push(`Some meals came out pricier than your budget setting — there wasn't a cheaper option that fit.`);
  if (rep.servedBannedDish)
    out.push(`I've had to reuse a dish you told me you didn't want — there's nothing else in that slot that fits your other rules. Rate a few more meals and I'll have more to work with.`);
  return out;
}

// Select one day's meals under all constraints. Shared by the full-week
// generator and single-day edits. An optional cuisine preference biases picks.
function pickMealsForDay(
  profile: UserProfile,
  split: SlotSplit,
  cap: number,
  tokens: string[],
  ctx: WeekCtx,
  cuisinePref?: Cuisine,
  preferFiber?: boolean,
  report?: SelectionReport,
): Meal[] {
  const dayCuisines = new Set<string>();
  const meals: Meal[] = [];
  for (const [type, share] of split) {
    const target = Math.round(profile.targetCalories * share);
    const st = slotTargetMacros(profile, type); // this slot's macro share (keto-adjusted)
    // HARD rules — diet, allergies and exclusions are never relaxed.
    const hard = RECIPES.filter(
      (r) =>
        r.type === type &&
        !r.treatOnly && // never plan a treat for someone; only serve it on request
        passesDiet(r, profile.diet) &&
        !blockedByExclusions(r, tokens),
    );
    // SOFT preferences — relax in stages rather than silently drop a meal from the day. A
    // pricier meal beats a missing one; a nutritionist would never leave you without dinner.
    //
    // ORDER MATTERS. Cook time is relaxed LAST: someone who says "nothing over 15 minutes"
    // usually cannot cook for 25, whereas price is elastic. Relaxing time to save money
    // (the earlier order) handed a 25-min meal to a user with a 15-min limit.
    const fast = (r: Recipe) => r.timeMinutes <= profile.maxCookTime + 5;
    let candidates = hard.filter(
      (r) => fast(r) && r.ingredients.length <= profile.maxIngredients + 1 && r.approxCost <= cap,
    );
    if (!candidates.length) candidates = hard.filter((r) => fast(r) && r.approxCost <= cap); // drop ingredient cap
    if (!candidates.length) {
      candidates = hard.filter(fast); // drop budget, keep the time limit
      if (candidates.length && report) report.relaxedBudget = true;
    }
    if (!candidates.length) candidates = hard.filter((r) => r.timeMinutes <= profile.maxCookTime + 15);
    if (!candidates.length) candidates = hard; // last resort: honour only the hard rules
    if (!hard.length && report) report.droppedSlots.push(type); // no recipe can satisfy the HARD rules
    // "Never serve me this again" (rating 1). A preference, so it relaxes like one: if banning
    // the dishes would leave this slot with nothing, they come back. A dinner you disliked beats
    // no dinner, and a user who one-stars every keto breakfast must still get breakfast.
    if (profile.mealRatings?.length) {
      const allowed = candidates.filter((r) => !bannedForUser(profile, r.name));
      if (allowed.length) candidates = allowed;
      else if (report) report.servedBannedDish = true;
    }
    if (cuisinePref) {
      const pref = candidates.filter((r) => r.cuisine === cuisinePref);
      if (pref.length) candidates = pref;
    }
    const pick = chooseRecipe(candidates, {
      target,
      proteinTarget: Math.round(profile.proteinGrams * share),
      carbTarget: st.carbs,
      fatTarget: st.fat,
      proteinDays: ctx.proteinDays,
      usedIds: ctx.usedIds,
      usedNames: ctx.usedNames,
      dayCuisines,
      usedIngredients: ctx.usedIngredients,
      fridge: ctx.fridge,
      preferFiber,
      boost: ctx.boost,
      ketoCarbs: ctx.ketoCarbs,
      ratings: ctx.ratings,
    });
    if (!pick && hard.length && report) report.droppedSlots.push(type);
    if (pick) {
      if (report && pick.timeMinutes > profile.maxCookTime + 5)
        report.slowestOverLimit = Math.max(report.slowestOverLimit, pick.timeMinutes);
      ctx.usedIds.add(pick.id);
      ctx.usedNames.add(pick.name.toLowerCase());
      ctx.proteinDays[pick.mainProtein] = (ctx.proteinDays[pick.mainProtein] ?? 0) + 1;
      dayCuisines.add(pick.cuisine);
      for (const ing of pick.ingredients) ctx.usedIngredients.add(ing.name.trim().toLowerCase());
      meals.push(toMeal(scaleRecipeToTarget(pick, target)));
    }
  }
  return meals;
}

// Assemble a full week by selecting from the library under all constraints.
export function selectWeekFromDb(
  profile: UserProfile,
  cuisinePref?: Cuisine,
  preferFiber?: boolean,
  seedIngredients?: string[],
  boost?: MicroKey,
  report?: SelectionReport,
): WeekPlan {
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const ctx = newCtx();
  if (seedIngredients?.length)
    ctx.fridge = new Set(seedIngredients.map((s) => s.trim().toLowerCase()).filter(Boolean));
  ctx.boost = boost;
  ctx.ketoCarbs = profile.diet === "keto";
  ctx.ratings = ratingMap(profile);
  // A pinned dish is going back into its slot after this, so the selector must not spend it
  // somewhere else — otherwise the week serves the user's Sunday roast twice. (It did, in 6 of
  // every 30 rebuilds, until the selector was told.)
  for (const l of profile.lockedMeals ?? []) {
    const r = RECIPES.find((x) => x.name === l.name);
    if (r) {
      ctx.usedIds.add(r.id);
      ctx.usedNames.add(r.name.toLowerCase());
    }
  }

  const days = DAYS.map((day) => ({
    day,
    meals: pickMealsForDay(profile, split, cap, tokens, ctx, cuisinePref, preferFiber, report),
  }));

  const avg = Math.round(
    days.reduce((s, d) => s + d.meals.reduce((m, x) => m + x.calories, 0), 0) / days.length,
  );
  return {
    days,
    weekSummary: `A varied week from the recipe library, averaging about ${avg.toLocaleString()} kcal per day.`,
  };
}

// Regenerate a single day, seeded from the rest of the week so it stays varied
// (no repeated dishes) and reuses ingredients already on the shopping list.
export function selectDay(
  profile: UserProfile,
  dayName: DayPlan["day"],
  plan: WeekPlan,
  cuisinePref?: Cuisine,
  preferFiber?: boolean,
  seedIngredients?: string[],
  boost?: MicroKey,
  report?: SelectionReport,
): DayPlan {
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const ctx = newCtx();
  if (seedIngredients?.length)
    ctx.fridge = new Set(seedIngredients.map((s) => s.trim().toLowerCase()).filter(Boolean));
  ctx.boost = boost;
  ctx.ketoCarbs = profile.diet === "keto";
  ctx.ratings = ratingMap(profile);
  for (const d of plan.days) {
    if (d.day === dayName) continue;
    for (const m of d.meals) {
      ctx.usedNames.add(m.name.toLowerCase());
      for (const ing of m.ingredients) ctx.usedIngredients.add(ing.name.trim().toLowerCase());
    }
  }
  // A dish pinned to ANOTHER day is spent, even when it is transiently absent from the plan (a
  // restaurant reserve sits in its slot, say). Otherwise this day picks it, the pin is re-imposed
  // later, and the week serves it twice.
  for (const l of profile.lockedMeals ?? []) {
    if (l.day === dayName) continue;
    const r = RECIPES.find((x) => x.name === l.name);
    if (r) {
      ctx.usedIds.add(r.id);
      ctx.usedNames.add(r.name.toLowerCase());
    }
  }
  return {
    day: dayName,
    meals: pickMealsForDay(profile, split, cap, tokens, ctx, cuisinePref, preferFiber, report),
  };
}

const CUISINE_ALIASES: [RegExp, Cuisine][] = [
  [/mediterran|greek/, "mediterranean"],
  [/asian|chinese|japanese|thai|korean|stir.?fry|teriyaki/, "asian"],
  [/mexican|latin|tex.?mex|taco/, "mexican"],
  [/italian|pasta/, "italian"],
  [/middle.?eastern|lebanese|turkish|shawarma|moroccan/, "middle_eastern"],
  [/indian|curry|tikka|masala/, "indian"],
  [/american|classic|comfort/, "american"],
];

function normalizeCuisine(input: string | null): Cuisine | undefined {
  if (!input) return undefined;
  const s = input.toLowerCase();
  for (const [re, c] of CUISINE_ALIASES) if (re.test(s)) return c;
  return undefined;
}

function mergeDislikes(current: string, add: string[]): string {
  const existing = current ? current.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return [...new Set([...existing, ...add.map((s) => s.trim().toLowerCase())])]
    .filter(Boolean)
    .join(", ");
}

const fiberOn = (op: Operation) => op.targetFiber != null && op.targetFiber > 0;

// The nutritionist default: keep the day on its macro targets. The LLM only turns
// this off (preserveMacros === false) when the user signals a treat / doesn't care
// about macros this time. Omitted/null → default on.
const keepMacros = (op: Operation) => op.preserveMacros !== false;

// --- Macro engine (the nutritionist substrate) -----------------------------
// The LLM decides WHAT to do (swap this, regenerate that) and WHETHER to stay on
// the macro targets; this code just does the math reliably once asked. After an
// edit we RE-SOLVE the day so its totals still hit the user's macros — portion-
// scaling is the lever (each meal scales within realistic limits), and a small
// gradient descent picks the scale factors that best match the day's
// {calories, protein, carbs, fat, fiber} targets. Add an axis (a vitamin, later)
// and the same solver balances it — no architecture change.

interface Macros {
  cal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

const MACRO_AXES = ["cal", "protein", "carbs", "fat", "fiber"] as const;
// How hard we try to hit each axis. Calories and protein are the two the user
// actually set and notices; carbs/fat/fiber follow. Calories must out-weigh the
// combined carb+fat+fiber pull, otherwise the solver trades calories away to keep
// those three happy and days land short (observed: 1852 kcal vs a 2000 target).
const MACRO_WEIGHTS: Macros = { cal: 4, protein: 3, carbs: 2, fat: 3, fiber: 0.5 };
const DAY_FIBER_TARGET = 30; // g/day (no per-user field yet; sensible default)
const SLOT_WEIGHT = 1.5; // how hard we keep each meal near its share of the day
const SCALE_LO = 0.6;
const SCALE_HI = 1.8; // keep portions realistic (matches scaleRecipeToTarget)
const clampScale = (f: number) => Math.max(SCALE_LO, Math.min(SCALE_HI, f));

function recipeMacros(r: Recipe): Macros {
  return { cal: r.calories, protein: r.proteinGrams, carbs: r.carbsGrams, fat: r.fatGrams, fiber: r.fiberGrams ?? 0 };
}
function mealMacros(m: Meal): Macros {
  return { cal: m.calories, protein: m.proteinGrams, carbs: m.carbsGrams, fat: m.fatGrams, fiber: m.fiberGrams ?? 0 };
}
/**
 * Ketosis is judged on NET carbohydrate — total carbs minus fiber, because fiber isn't absorbed.
 * Under 50g net keeps most people in ketosis; 30 is where a dietitian would aim. The solver works
 * in total carbs, so the target it gets is the net target plus the fiber the week carries anyway.
 */
const KETO_NET_CARB_TARGET = 30;

/**
 * The macro targets a day is solved against.
 *
 * A diet is not just a filter on recipes — it is a claim about macros, and for keto the app was
 * only honouring the filter. A keto user kept whatever carb target their onboarding default gave
 * them (200g), the solver dutifully scaled portions toward it, and their "keto" week landed at
 * 42-74g of carbohydrate a day. Keto in name only.
 *
 * So keto sets its own targets: carbs down to 30g, and the calories that frees go to fat, which is
 * exactly the trade the diet is. Protein is left where the user put it. The profile is NOT
 * modified — this is a derived target, so switching off keto restores what they chose.
 */
function dayTargetMacros(p: UserProfile): Macros {
  const fiber = p.fiberGrams ?? DAY_FIBER_TARGET;
  if (p.diet !== "keto")
    return { cal: p.targetCalories, protein: p.proteinGrams, carbs: p.carbsGrams, fat: p.fatGrams, fiber };

  const carbs = Math.min(p.carbsGrams, KETO_NET_CARB_TARGET + DAY_FIBER_TARGET);
  const fatCalories = p.targetCalories - p.proteinGrams * 4 - carbs * 4;
  return {
    cal: p.targetCalories,
    protein: p.proteinGrams,
    carbs,
    fat: Math.max(p.fatGrams, Math.round(fatCalories / 9)),
    fiber,
  };
}
function slotShare(p: UserProfile, type: Recipe["type"]): number {
  return localSplit(p.mealsPerDay).find((s) => s[0] === type)?.[1] ?? 1 / p.mealsPerDay;
}
function slotTargetMacros(p: UserProfile, type: Recipe["type"]): Macros {
  const t = dayTargetMacros(p);
  const s = slotShare(p, type);
  return { cal: t.cal * s, protein: t.protein * s, carbs: t.carbs * s, fat: t.fat * s, fiber: t.fiber * s };
}
// Scale-free weighted distance between a meal/recipe's macros and a target.
function macroDistance(m: Macros, target: Macros): number {
  let d = 0;
  for (const a of MACRO_AXES) {
    const rel = (m[a] - target[a]) / Math.max(target[a], 1);
    d += MACRO_WEIGHTS[a] * rel * rel;
  }
  return d;
}

const recipeByName = new Map(RECIPES.map((r) => [r.name.toLowerCase(), r]));
const baseRecipeOf = (m: Meal): Recipe | undefined => recipeByName.get(m.name.toLowerCase());

// Scale a recipe by an exact factor. Unlike scaleRecipeToTarget (which ignores any
// change under 8% to avoid pointless re-portioning during generation), the rebalancer
// needs its corrections applied verbatim — otherwise small, deliberate adjustments are
// silently discarded and the day drifts off target.
function scaleRecipeByFactor(r: Recipe, factor: number): Recipe {
  const f = clampScale(factor);
  if (Math.abs(f - 1) < 0.01) return r;
  return {
    ...r,
    calories: Math.round(r.calories * f),
    proteinGrams: Math.round(r.proteinGrams * f),
    carbsGrams: Math.round(r.carbsGrams * f),
    fatGrams: Math.round(r.fatGrams * f),
    ...(r.fiberGrams != null ? { fiberGrams: Math.round(r.fiberGrams * f) } : {}),
    ingredients: r.ingredients.map((i) => ({ ...i, quantity: scaleQuantity(i.quantity, f) })),
  };
}

// LEVER 1 — portion scaling. Re-solve the adjustable meals' portions so the day's
// totals hit the macro targets. `locked` (the meals the user swapped in, or already ate)
// in) keeps its chosen portion; the OTHER meals absorb the difference. Only meals
// traceable to a library recipe are rescaled; anything else is left untouched.
type LockedSlots = ReadonlySet<Recipe["type"]>;

function scaleToTargets(meals: Meal[], profile: UserProfile, locked?: LockedSlots): Meal[] {
  const target = dayTargetMacros(profile);
  const adj = meals
    .map((m) => ({ m, base: baseRecipeOf(m) }))
    .filter((x): x is { m: Meal; base: Recipe } => !!x.base && !locked?.has(x.m.type))
    .map((x) => ({ m: x.m, base: x.base, g: clampScale(x.m.calories / x.base.calories) }));
  if (adj.length === 0) return meals;

  // Fixed contribution: meals we won't rescale (the locked meal + any without a base).
  const fixed: Macros = { cal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const m of meals) {
    if (adj.some((a) => a.m === m)) continue;
    const mm = mealMacros(m);
    for (const a of MACRO_AXES) fixed[a] += mm[a];
  }

  // Gradient descent on the scale factors (scale-free weighted squared error).
  const LR = 0.05;
  for (let iter = 0; iter < 300; iter++) {
    const total: Macros = { ...fixed };
    for (const it of adj) {
      const b = recipeMacros(it.base);
      for (const a of MACRO_AXES) total[a] += b[a] * it.g;
    }
    for (const it of adj) {
      const b = recipeMacros(it.base);
      let grad = 0;
      for (const a of MACRO_AXES) {
        const denom = Math.max(target[a], 1);
        grad += MACRO_WEIGHTS[a] * 2 * ((total[a] - target[a]) / (denom * denom)) * b[a];
      }
      // Keep meals a sensible SIZE. Hitting the day's macros by squashing breakfast to its 0.6x
      // floor and inflating dinner to its 1.8x ceiling is arithmetically correct and useless as
      // a meal plan (observed: a 265 kcal breakfast beside a 1084 kcal dinner). Pull each meal
      // toward its slot's share of the day; the macro terms still dominate.
      const want = target.cal * slotShare(profile, it.m.type);
      const have = b.cal * it.g;
      grad += SLOT_WEIGHT * 2 * ((have - want) / (want * want)) * b.cal;
      it.g = clampScale(it.g - LR * grad);
    }
  }

  // Calorie polish (water-filling). The multi-axis descent balances five goals at once and
  // can settle off-target on calories when carbs/fat/fiber pull the other way. Calories are
  // the axis the user actually set, so close the gap directly.
  //
  // Scaling every meal by the same factor is wrong: a meal already pinned at a clamp absorbs
  // none of the correction, so the day stays short even when the others have headroom
  // (observed: lunch pinned at 0.60x while breakfast sat at 1.49x and the day was 350 kcal
  // under). Instead, each round pushes the remaining deficit ONLY onto meals that can still
  // move, and re-checks. Works in both directions (deficit and surplus).
  const adjCal = () => adj.reduce((s, it) => s + recipeMacros(it.base).cal * it.g, 0);
  const wanted = target.cal - fixed.cal;
  for (let t = 0; t < 12 && wanted > 0; t++) {
    const deficit = wanted - adjCal();
    if (Math.abs(deficit) < 5) break; // close enough
    const free = adj.filter((it) => (deficit > 0 ? it.g < SCALE_HI - 1e-6 : it.g > SCALE_LO + 1e-6));
    if (!free.length) break; // everything is clamped: the target is physically unreachable
    const freeCal = free.reduce((s, it) => s + recipeMacros(it.base).cal * it.g, 0);
    if (freeCal <= 0) break;
    const k = (freeCal + deficit) / freeCal;
    for (const it of free) it.g = clampScale(it.g * k);
  }

  const scaled = new Map<Meal, Meal>();
  for (const it of adj) scaled.set(it.m, toMeal(scaleRecipeByFactor(it.base, it.g)));
  return meals.map((m) => scaled.get(m) ?? m);
}


/**
 * Rough order of a day. Used by log_meal: once you've eaten lunch, breakfast and lunch are
 * facts — only the meals still ahead of you can be adjusted.
 */
const MEAL_ORDER: Record<Recipe["type"], number> = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

/** Every slot at or before `type` — i.e. everything already eaten. */
const slotsUpTo = (type: Recipe["type"]): Set<Recipe["type"]> =>
  new Set((Object.keys(MEAL_ORDER) as Recipe["type"][]).filter((t) => MEAL_ORDER[t] <= MEAL_ORDER[type]));

const dayProtein = (meals: Meal[]) => meals.reduce((s, m) => s + m.proteinGrams, 0);
const PROTEIN_SLACK = 8; // g/day we'll tolerate before reaching for lever 2

// Re-solve one day onto the macro targets. Two levers, in order — exactly what a
// nutritionist does:
//  1) SCALE the meals' portions to hold calories + macros.
//  2) if the day is still protein-short (scaling can't raise protein at fixed
//     calories), UPGRADE the weakest eligible meal to a higher-protein same-type
//     recipe to "make room" — then scale again.
// `locked` protects meals that must not move: the dish the user swapped in, or every meal
// they have already EATEN today (log_meal). They are never rescaled or upgraded.
// `avoidNames` are dishes used elsewhere in the week, so an upgrade doesn't create a
// cross-day repeat.
function rebalanceDay(
  meals: Meal[],
  profile: UserProfile,
  locked?: LockedSlots,
  avoidNames?: Set<string>,
): Meal[] {
  let work = meals;
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  // At most two upgrades so we change as few meals as needed.
  for (let pass = 0; pass < 2; pass++) {
    const scaled = scaleToTargets(work, profile, locked);
    const gap = profile.proteinGrams - dayProtein(scaled);
    if (gap <= PROTEIN_SLACK) {
      work = scaled;
      break;
    }
    let best: { i: number; r: Recipe; calTarget: number; gap: number } | null = null;
    for (let i = 0; i < work.length; i++) {
      const cur = work[i];
      if (locked?.has(cur.type) || !baseRecipeOf(cur)) continue;
      const share = split.find((s) => s[0] === cur.type)?.[1] ?? 1 / profile.mealsPerDay;
      const calTarget = Math.round(profile.targetCalories * share);
      const usedElsewhere = new Set([
        ...work.filter((_, j) => j !== i).map((x) => x.name.toLowerCase()),
        ...(avoidNames ?? []),
      ]);
      for (const r of RECIPES) {
        if (
          r.type !== cur.type ||
          r.treatOnly || // a protein upgrade must never become a burger
          !passesDiet(r, profile.diet) ||
          blockedByExclusions(r, tokens) ||
          // Chasing protein is no reason to serve a dish the user rejected. If nothing else beats
          // the current meal, `best` stays null and the meal stays — no slot can be emptied here.
          bannedForUser(profile, r.name) ||
          r.approxCost > cap ||
          r.timeMinutes > profile.maxCookTime + 5 ||
          r.ingredients.length > profile.maxIngredients + 1 ||
          usedElsewhere.has(r.name.toLowerCase())
        )
          continue;
        const trial = work.map((x, j) => (j === i ? toMeal(scaleRecipeToTarget(r, calTarget)) : x));
        const trialGap = Math.abs(profile.proteinGrams - dayProtein(scaleToTargets(trial, profile, locked)));
        if (best === null || trialGap < best.gap) best = { i, r, calTarget, gap: trialGap };
      }
    }
    // Stop if the best available upgrade doesn't meaningfully close the gap.
    if (!best || best.gap >= Math.abs(gap) - 2) {
      work = scaled;
      break;
    }
    work = work.map((x, j) => (j === best!.i ? toMeal(scaleRecipeToTarget(best!.r, best!.calTarget)) : x));
  }
  return scaleToTargets(work, profile, locked);
}

// Re-solve every day of a week onto the macro targets. Used for the initial plan
// and after a week/profile change so the plan the user sees respects their macros
// from the start. Threads a running set of used dish names so a protein upgrade on
// one day never introduces a dish already on another day.
export const rebalanceWeek = (plan: WeekPlan, profile: UserProfile): WeekPlan => {
  // Seed with the pinned dishes too. They are not in `plan` yet — the selector was told to skip
  // them — so without this an upgrade is free to spend one on the wrong day.
  const used = new Set([
    ...plan.days.flatMap((d) => d.meals.map((m) => m.name.toLowerCase())),
    ...(profile.lockedMeals ?? []).map((l) => l.name.toLowerCase()),
  ]);
  const days = plan.days.map((d) => {
    const own = new Set(d.meals.map((m) => m.name.toLowerCase()));
    const avoid = new Set([...used].filter((n) => !own.has(n)));
    const meals = rebalanceDay(d.meals, profile, undefined, avoid);
    for (const m of meals) used.add(m.name.toLowerCase());
    return { ...d, meals };
  });
  return { ...plan, days };
};

// Macro-aware swap: among the recipes that match the requested dish name, pick the
// one whose macro profile best fits the slot — so "pancakes" on a high-protein plan
// auto-selects the protein-forward pancake (the user never has to say "protein").
// Dish match wins first; macro fit only breaks ties between equally-matching dishes.
// `respectSoft` = also honour the user's cook-time / ingredient-count limits. We try
// with them on first; if nothing fits we retry with them off purely to tell the user
// WHY we couldn't do it ("that dahl takes 30 min, over your 15-min limit").
function findRecipeForSwap(
  query: string,
  type: Recipe["type"] | undefined,
  profile: UserProfile,
  respectSoft = true,
): Recipe | null {
  const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  const eligible = (r: Recipe) =>
    (!type || r.type === type) &&
    passesDiet(r, profile.diet) &&
    !blockedByExclusions(r, tokens) &&
    r.approxCost <= cap &&
    (!respectSoft || (r.timeMinutes <= profile.maxCookTime + 5 && r.ingredients.length <= profile.maxIngredients + 1));

  // An EXACT name match wins outright. "Swap in the Veggie Omelette" must give the Veggie Omelette,
  // not the dish that happens to share the most keywords with it — a keyword tie once handed a
  // request for "Veggie Omelette" a chickpea omelette instead. Still behind the hard filters, so a
  // vegan who names an egg dish is refused, not served it.
  const q = query.trim().toLowerCase();
  const exact = RECIPES.find((r) => r.name.toLowerCase() === q && eligible(r));
  if (exact) return exact;

  const scored: { r: Recipe; kw: number }[] = [];
  for (const r of RECIPES) {
    if (!eligible(r)) continue;
    const hay = `${r.name} ${r.description} ${r.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
    let kw = 0;
    for (const w of words) if (hay.includes(w)) kw++;
    if (kw > 0) scored.push({ r, kw });
  }
  if (scored.length === 0) return null;
  const maxKw = Math.max(...scored.map((s) => s.kw));
  const top = scored.filter((s) => s.kw === maxKw).map((s) => s.r);
  if (top.length === 1) return top[0];
  const st = slotTargetMacros(profile, type ?? top[0].type);
  return top.slice().sort((a, b) => macroDistance(recipeMacros(a), st) - macroDistance(recipeMacros(b), st))[0];
}

const dayTotals = (d: DayPlan) => ({
  kcal: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
});

// Fuller totals for the honesty note (carbs/fat/fiber too). Kept separate from dayTotals, whose
// two-field shape flows into the agent read-tools and shouldn't grow here.
const dayTotalsFull = (d: DayPlan) => ({
  kcal: d.meals.reduce((s, m) => s + m.calories, 0),
  protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
  carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
  fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
  fiber: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
});

const weekAveragesFull = (plan: WeekPlan) => {
  const n = plan.days.length || 1;
  const t = plan.days.map(dayTotalsFull);
  const avg = (k: keyof ReturnType<typeof dayTotalsFull>) =>
    Math.round(t.reduce((s, x) => s + x[k], 0) / n);
  return { kcal: avg("kcal"), protein: avg("protein"), carbs: avg("carbs"), fat: avg("fat"), fiber: avg("fiber") };
};


/** Average daily amount of a micronutrient across the week, from the mapped ingredients. */
function weekMicroAverage(plan: WeekPlan, key: MicroKey): { amount: number; coverage: number } {
  const n = plan.days.length || 1;
  let total = 0;
  let cov = 0;
  let meals = 0;
  for (const d of plan.days)
    for (const m of d.meals) {
      const r = microsForIngredients(m.ingredients);
      total += r.micros[key] / Math.max(1, m.servings ?? 1);
      cov += r.coverage;
      meals++;
    }
  return { amount: total / n, coverage: meals ? cov / meals : 0 };
}

const PROTEIN_MISS = 8; // g/day we'll tolerate before admitting we fell short

/**
 * Report what the plan ACTUALLY achieved. The model writes the friendly sentence but does
 * no arithmetic, so left alone it will happily claim "I hit 190g protein" when the recipe
 * pool tops out at 167g. That is a trust violation. The engine appends the truth — including
 * an explicit admission when a target is out of reach under the user's constraints.
 */
function achievementNote(
  label: string,
  got: { kcal: number; protein: number; carbs?: number; fat?: number; fiber?: number },
  p: UserProfile,
): string {
  let note = `${label} ${got.kcal} kcal and ${got.protein}g protein.`;
  const short = p.proteinGrams - got.protein;
  if (short > PROTEIN_MISS)
    note += ` I couldn't reach ${p.proteinGrams}g protein within your diet, budget and time limits — ${got.protein}g is the most these recipes allow.`;
  // Calories were only ever reported, never admitted as missed. A user setting 4000 kcal was
  // told "your week averages 2100 kcal" as though that were success.
  const calMiss = got.kcal - p.targetCalories;
  if (Math.abs(calMiss) > p.targetCalories * 0.1)
    note += ` That's ${Math.abs(calMiss)} kcal ${calMiss < 0 ? "below" : "above"} your ${p.targetCalories} kcal target — these recipes can't stretch further without unrealistic portions.`;
  // Carbs and fat are steered at selection time but can't always land exactly; the note owes the
  // user the same honesty on them as on calories/protein. Only disclose a real miss (>20% off),
  // measured against the keto-adjusted day target.
  const tgt = dayTargetMacros(p);
  const keto = p.diet === "keto";
  // On keto, carbs are a CEILING (the whole point is to drive them as low as the pool allows), so
  // landing under is success — only flag carbs that run OVER. Every other diet treats carbs as a
  // target and discloses a miss in either direction.
  if (got.carbs != null && tgt.carbs > 0) {
    const missed = keto ? got.carbs - tgt.carbs > tgt.carbs * 0.2 : Math.abs(got.carbs - tgt.carbs) > tgt.carbs * 0.2;
    if (missed) note += ` Carbs come to ${got.carbs}g against about ${Math.round(tgt.carbs)}g.`;
  }
  if (got.fat != null && tgt.fat > 0 && Math.abs(got.fat - tgt.fat) > tgt.fat * 0.2)
    note += ` Fat comes to ${got.fat}g against about ${Math.round(tgt.fat)}g.`;
  // Fiber is a floor, not a ceiling — only flag a real shortfall, and not on keto, which is
  // inherently low in fibre (and whose fix, more beans/whole grains, would break the diet).
  if (!keto && got.fiber != null && got.fiber < tgt.fiber * 0.7)
    note += ` Fiber is ${got.fiber}g, under the ${Math.round(tgt.fiber)}g I aim for — a serving of veg, beans or whole grains closes it.`;
  return note;
}


/**
 * A nutrient boost must be a GUARANTEE, not a bias. Scoring recipes higher for iron and then
 * re-rolling a random week can hand the user LESS iron than they started with — which makes
 * "I'll rebuild your week around iron" a lie. This pass only ever accepts a strict improvement,
 * so the nutrient can go up or stay put, never down.
 *
 * Variety still matters: a nutritionist doesn't prescribe salmon seven nights running, so no
 * recipe may appear more than twice a week, and never twice in one day.
 */
function upgradeForNutrient(profile: UserProfile, plan: WeekPlan, key: MicroKey): WeekPlan {
  const tokens = exclusionTokens(profile);
  const eligible = RECIPES.filter(
    (r) =>
      !r.treatOnly &&
      passesDiet(r, profile.diet) &&
      !blockedByExclusions(r, tokens) &&
      // An iron-rich dish the user hated is not an upgrade. Nothing better => keep the meal.
      !bannedForUser(profile, r.name) &&
      r.timeMinutes <= profile.maxCookTime,
  );
  const density = new Map(eligible.map((r) => [r.id, recipeMicros(r).micros[key]] as const));
  const uses = new Map<string, number>();
  for (const d of plan.days) for (const m of d.meals) uses.set(m.name, (uses.get(m.name) ?? 0) + 1);

  const days = plan.days.map((d) => ({ ...d, meals: [...d.meals] }));
  for (const d of days) {
    for (let i = 0; i < d.meals.length; i++) {
      const cur = d.meals[i];
      const curRecipe = RECIPES.find((r) => r.name === cur.name);
      const curAmount = curRecipe ? recipeMicros(curRecipe).micros[key] : 0;
      const inDay = new Set(d.meals.map((m) => m.name));
      const best = eligible
        .filter(
          (r) =>
            r.type === cur.type &&
            !inDay.has(r.name) &&
            (uses.get(r.name) ?? 0) < 2 &&
            (density.get(r.id) ?? 0) > curAmount,
        )
        .sort((a, b) => (density.get(b.id) ?? 0) - (density.get(a.id) ?? 0))[0];
      if (!best) continue; // nothing strictly better — keep what's there
      const share = localSplit(profile.mealsPerDay).find((sp) => sp[0] === best.type)?.[1] ?? 1 / profile.mealsPerDay;
      d.meals[i] = toMeal(scaleRecipeToTarget(best, Math.round(profile.targetCalories * share)));
      uses.set(cur.name, Math.max(0, (uses.get(cur.name) ?? 1) - 1));
      uses.set(best.name, (uses.get(best.name) ?? 0) + 1);
    }
  }
  return rebalanceWeek({ ...plan, days }, profile);
}

/**
 * "I'm always tired." The only defensible thing an app can do here is refuse to guess.
 *
 * It does not diagnose: it names what the symptom is nutritionally ASSOCIATED with, then checks
 * those nutrients against what the user is actually eating this week, and reports which are low.
 * That is a claim about their food, which we can support, and never about their body, which we
 * cannot. It recommends no supplement and no dose. It sends them to a doctor, because for every
 * symptom in the table the medically correct answer is "get it looked at".
 *
 * Red-flag symptoms short-circuit the whole thing. Chest pain is not a magnesium problem, and an
 * app that answers it with a meal plan is dangerous.
 */
function symptomNote(plan: WeekPlan, p: UserProfile, reported: string): { text: string; override: boolean } {
  const said = reported.trim().toLowerCase();
  if (!said) return { text: "What have you been noticing?", override: false };

  const words = said.split(/[^a-z']+/).filter(Boolean);
  const same = (w: string, t: string) => w === t || wordMatches(w, t) || wordMatches(t, w);

  // SYMPTOMS match as an unordered WORD SET, with the same stemmer the allergen filter uses:
  // "my nails are brittle and my hair is thinning" must find "brittle nails" and "hair thinning";
  // "retired" must never find "tired".
  const hasWord = (t: string) => words.some((w) => same(w, t));
  const phraseIn = (phrase: string) => phrase.split(/\s+/).every(hasWord);

  // RED FLAGS match on ADJACENCY, not on a scattered set. "blood in stool" contains the word
  // "in"; as a word set it would fire on "my blood test was low and I sat on a stool in the
  // kitchen". Noise words are dropped from both sides, then the phrase must appear as
  // consecutive words — which still lets "coughing up blood" find "coughing blood".
  const signal = words.filter((w) => !PHRASE_NOISE.has(w.replace(/'/g, "")));
  const flagIn = (phrase: string) => {
    const want = phrase.split(/\s+/).filter((w) => !PHRASE_NOISE.has(w.replace(/'/g, "")));
    if (!want.length) return false;
    // Adjacent but ORDER-FREE: "a pain in my chest" and "my speech is slurred" are the same
    // emergency as "chest pain" and "slurred speech". Strict ordering missed both.
    for (let i = 0; i + want.length <= signal.length; i++) {
      const window = signal.slice(i, i + want.length);
      const taken = new Array(window.length).fill(false);
      const all = want.every((t) => {
        const j = window.findIndex((w, k) => !taken[k] && same(w, t));
        if (j < 0) return false;
        taken[j] = true;
        return true;
      });
      if (all) return true;
    }
    return false;
  };

  // Crisis first. Nothing else in this function runs.
  // `override` means: the model's own words are DISCARDED and this text is the entire reply. A
  // 1.5B must not be able to prepend "sounds like low iron!" to a chest-pain warning.
  if (CRISIS_FLAGS.some(flagIn))
    return {
      text: "I'm not the right help for this, and I don't want to talk to you about food right now. Please contact your local emergency number or a crisis line straight away — in the US and Canada you can call or text 988, in the UK call 116 123. If you're in danger, call emergency services.",
      override: true,
    };

  if (URGENT_FLAGS.some(flagIn))
    return {
      text: "That isn't something I should be answering with food. Please contact a doctor or urgent care now — I'll look at your nutrition once you've had it seen to.",
      override: true,
    };

  const hit = SYMPTOMS.find((sym) => sym.triggers.some(phraseIn));
  if (!hit)
    return {
      text: "I don't have a nutritional angle on that, and I'd rather say so than invent one. If it's bothering you, a doctor is the right person to ask.",
      override: false,
    };

  const low: string[] = [];
  const fine: string[] = [];
  const unmeasured: string[] = [];
  const lowKeys: MicroKey[] = [];
  for (const k of hit.nutrients) {
    const { amount, coverage } = weekMicroAverage(plan, k);
    if (coverage < 0.6) { unmeasured.push(MICRO_LABEL[k]); continue; }
    const pct = Math.round((amount / DAILY_REFERENCE[k]) * 100);
    if (pct < 80) { low.push(`${MICRO_LABEL[k]} (${pct}% of the daily reference)`); lowKeys.push(k); }
    else fine.push(`${MICRO_LABEL[k]} (${pct}%)`);
  }

  const parts = [
    `${cap(hit.label)} can have many causes and most of them aren't dietary — I can't diagnose it, and if it's persisted you should see a doctor.`,
    `What I can do is check the nutrients it's classically associated with — ${listPhrase(hit.nutrients.map((k) => MICRO_LABEL[k]))} — against what you're actually eating.`,
  ];

  if (low.length) {
    parts.push(`In your current week, ${listPhrase(low)} ${low.length > 1 ? "are" : "is"} below the reference.`);
    const fixable = lowKeys.filter((k) => nutrientReachable(p, k));
    const stuck = lowKeys.filter((k) => !nutrientReachable(p, k));
    if (fixable.length) parts.push(`I can rebuild your week around ${listPhrase(fixable.map((k) => MICRO_LABEL[k]))} if you'd like.`);
    if (stuck.length)
      parts.push(`No food that fits your ${p.diet !== "none" ? p.diet + " " : ""}rules carries enough ${listPhrase(stuck.map((k) => MICRO_LABEL[k]))} — that's worth raising with a doctor or dietitian rather than something I can fix with recipes.`);
  } else if (fine.length) {
    parts.push(`In your current week they all look adequate — ${listPhrase(fine)} — so your food probably isn't the explanation. That's a reason to see a doctor, not to ignore it.`);
  }
  if (unmeasured.length) parts.push(`(I can't measure ${listPhrase(unmeasured)} reliably from these ingredients.)`);
  return { text: parts.join(" "), override: false };
}

/**
 * "I've run out of Greek yogurt." A substitution has to clear three bars, in this order:
 *
 *  1. SAFETY. It must not be something they're allergic to, dislike, or that breaks their diet.
 *     Suggesting butter to a vegan, or almond butter to a nut-allergic user, is the single worst
 *     thing this feature could do — so candidates are filtered before anything else is computed.
 *  2. SENSE. Which foods stand in for which is curated (see substitutions.ts); a nutrient table
 *     doesn't know that lentils don't belong where a chicken breast was.
 *  3. HONESTY about the cost. The macro difference is computed from USDA data at the portion the
 *     recipe actually calls for, and stated. "Basically the same" is a claim, not a courtesy.
 */
/**
 * Substring matching once served almonds to a user allergic to nuts, because "nuts" is inside
 * "almonds"... backwards. Here it made "unicorn tears" match corn. Ingredients match on WORD
 * boundaries or not at all.
 */
function nameMatches(ingredientName: string, want: string): boolean {
  const n = ingredientName.trim().toLowerCase();
  if (n === want) return true;
  // Compare word by word, with the same stemming the allergen filter uses, so "egg" finds "eggs"
  // and "tortilla" finds "corn tortillas" — but "unicorn tears" never finds corn.
  const nw = n.split(/[^a-z]+/).filter(Boolean);
  const ww = want.split(/[^a-z]+/).filter(Boolean);
  if (!ww.length) return false;
  const covers = (hay: string[], needles: string[]) =>
    needles.every((t) => hay.some((w) => wordMatches(w, t) || wordMatches(t, w)));
  return covers(nw, ww) || covers(ww, nw);
}

/**
 * "almond" must not resolve to "almond butter" just because that key is listed first. Among the
 * keys that match, prefer the one that says the least beyond what the user said.
 */
function bestKey(want: string): string | undefined {
  const alias = INGREDIENT_ALIASES[want];
  if (alias && SUBSTITUTES[alias]) return alias;
  const words = (x: string) => x.split(/[^a-z]+/).filter(Boolean).length;
  return Object.keys(SUBSTITUTES)
    .filter((k) => nameMatches(k, want))
    .sort((a, b) => Math.abs(words(a) - words(want)) - Math.abs(words(b) - words(want)) || a.length - b.length)[0];
}

function substituteNote(
  plan: WeekPlan,
  p: UserProfile,
  query: string,
  day: DayPlan["day"] | undefined,
  type: Meal["type"] | undefined,
): string {
  const raw = query.trim().toLowerCase();
  if (!raw) return "Which ingredient have you run out of?";
  const want = INGREDIENT_ALIASES[raw] ?? raw;

  // Find where it appears in the plan, so the advice is about a real portion.
  const scope = plan.days.filter((d) => !day || d.day === day);
  let found: { day: string; meal: Meal; name: string; quantity: string } | null = null;
  for (const d of scope)
    for (const m of d.meals) {
      if (type && m.type !== type) continue;
      const hit = m.ingredients.find((i) => nameMatches(i.name, want));
      if (hit && !found) found = { day: d.day, meal: m, name: hit.name.trim().toLowerCase(), quantity: hit.quantity };
    }

  const key = found?.name ?? want;
  const candidates = SUBSTITUTES[key] ?? SUBSTITUTES[want] ?? SUBSTITUTES[bestKey(key) ?? bestKey(want) ?? ""] ?? [];
  if (!candidates.length)
    return found
      ? `I don't have a substitution I trust for ${key}. Leaving it out of ${found.day}'s ${found.meal.type} is usually safer than guessing.`
      : `I don't know what to swap for "${query}", and I'd rather say so than invent something.`;

  // 1. SAFETY FIRST — diet, allergies, dislikes.
  const tokens = exclusionTokens(p);
  const dietTag = p.diet === "vegan" ? "vegan" : p.diet === "vegetarian" ? "vegetarian" : "";
  const safe = candidates.filter((c: string) => {
    if (haystackBlocked(c, tokens)) return false;
    if (dietTag && dietTagConflicts(dietTag, [c]).length) return false;
    // Keto isn't a tag on an ingredient, it's a number on one. dietTagConflicts can't see it, so
    // a keto user was being told to replace rice with... quinoa and couscous.
    if (p.diet === "keto" && (NUTRIENT_TABLE[c]?.per100g.carbs ?? 0) > KETO_MAX_CARBS_PER_100G) return false;
    return true;
  });
  if (!safe.length)
    return `Everything I'd normally swap for ${key} breaks your ${p.diet !== "none" ? p.diet + " diet" : "restrictions"} or something you avoid, so I won't suggest any of them.`;

  const best = safe[0];
  const parts: string[] = [];

  // 3. THE COST, computed. Only when we know both foods and the portion.
  const grams = found ? gramsFor(found.name, found.quantity) : null;
  const a = NUTRIENT_TABLE[key]?.per100g;
  const b = NUTRIENT_TABLE[best]?.per100g;
  if (found && grams && a && b) {
    const f = grams / 100;
    const dCal = Math.round(((b.cal ?? 0) - (a.cal ?? 0)) * f);
    const dPro = Math.round(((b.protein ?? 0) - (a.protein ?? 0)) * f);
    const cost: string[] = [];
    if (Math.abs(dCal) >= 15) cost.push(`${Math.abs(dCal)} ${dCal > 0 ? "more" : "fewer"} kcal`);
    if (Math.abs(dPro) >= 3) cost.push(`${Math.abs(dPro)}g ${dPro > 0 ? "more" : "less"} protein`);
    parts.push(
      `Use ${best} instead of the ${portion(found.quantity, key)} in ${found.day}'s ${found.meal.type}` +
        (cost.length ? ` — that's ${listPhrase(cost)} for that portion.` : ` — near enough identical for that portion.`),
    );
  } else if (found) {
    parts.push(`Use ${best} instead of the ${portion(found.quantity, key)} in ${found.day}'s ${found.meal.type}.`);
    parts.push(`I can't put a number on the macro difference — I don't have full data for both.`);
  } else {
    parts.push(`Use ${best} in place of ${key}.`);
    parts.push(`It isn't in this week's plan, so I'm speaking generally.`);
  }

  const others = safe.slice(1, 3);
  if (others.length) parts.push(`${listPhrase(others.map(cap))} also work${others.length > 1 ? "" : "s"}.`);
  const dropped = candidates.length - safe.length;
  if (dropped) parts.push(`(I left out ${dropped} I'd normally suggest — ${dropped > 1 ? "they don't" : "it doesn't"} fit your diet or what you avoid.)`);
  return parts.join(" ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "150 g of greek yogurt", but "1 egg" — a bare count doesn't take "of". */
function portion(quantity: string, ingredient: string): string {
  return /[a-z]/i.test(quantity) ? `${quantity} of ${ingredient}` : `${quantity} ${ingredient}`;
}

/**
 * "Why is this in my plan?" An assistant that cannot justify its own choices is a black box, and
 * a black box cannot replace a nutritionist. Every clause below is derived from the plan and the
 * USDA table — the model narrates it, it never invents it.
 *
 * Where the data is thin (an ingredient list we can't fully match), the nutrient claim is dropped
 * rather than softened. "Rich in iron" is a claim about someone's blood; we make it only when the
 * numbers actually say so.
 */
function explainMealNote(plan: WeekPlan, p: UserProfile, day: DayPlan["day"], type: Meal["type"]): string {
  const d = plan.days.find((x) => x.day === day);
  const meal = d?.meals.find((m) => m.type === type);
  if (!meal) return `I don't have a ${type} on ${day}.`;

  const t = dayTargetMacros(p);
  const pctCal = Math.round((meal.calories / t.cal) * 100);
  const pctPro = t.protein > 0 ? Math.round((meal.proteinGrams / t.protein) * 100) : 0;
  const parts: string[] = [
    `${day}'s ${type} is ${meal.name}: ${meal.calories} kcal (${pctCal}% of your day) and ${meal.proteinGrams}g protein (${pctPro}% of your ${Math.round(t.protein)}g target).`,
  ];

  // A reserved or logged meal has no recipe behind it — say that plainly rather than pretending.
  const base = RECIPES.find((r) => r.name === meal.name);
  if (!base) {
    parts.push(`It isn't one of my recipes — it's a meal you told me about, so I planned the rest of the day around it.`);
    return parts.join(" ");
  }

  const why: string[] = [];
  const density = meal.calories > 0 ? (meal.proteinGrams * 4) / meal.calories : 0;
  if (density >= 0.3) why.push(`it's protein-dense (${Math.round(density * 100)}% of its calories)`);
  if (base.timeMinutes <= 15) why.push(`it's quick (${base.timeMinutes} min)`);
  else if (base.timeMinutes <= p.maxCookTime) why.push(`it fits your ${p.maxCookTime}-min limit at ${base.timeMinutes} min`);
  if (base.approxCost === 1) why.push("it's one of the cheaper recipes");
  // The SERVED portion, not the recipe card: everything else in this sentence is scaled.
  if ((meal.fiberGrams ?? 0) >= 8) why.push(`it carries ${meal.fiberGrams}g of fiber`);
  if (p.diet !== "none") why.push(`it's ${p.diet}`);

  // Ingredient reuse is a real reason: it's why the grocery list stays short.
  const mine = new Set(base.ingredients.map((i) => i.name.trim().toLowerCase()));
  const shared = new Set<string>();
  for (const other of plan.days.flatMap((x) => x.meals))
    if (other !== meal)
      for (const ing of other.ingredients)
        if (mine.has(ing.name.trim().toLowerCase())) shared.add(ing.name.trim().toLowerCase());
  if (shared.size >= 2) why.push(`it reuses ${shared.size} ingredients already on your shopping list`);

  if (why.length) parts.push(`I picked it because ${listPhrase(why)}.`);

  // Micronutrients: only claim what the data supports.
  const { micros, coverage } = microsForIngredients(meal.ingredients);
  if (coverage >= 0.6) {
    const per = Math.max(1, meal.servings ?? 1);
    const top = MICRO_KEYS.map((k) => ({ k, pct: (micros[k] / per) / DAILY_REFERENCE[k] }))
      .filter((x) => x.pct >= 0.3)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 2);
    if (top.length)
      parts.push(
        `It's a strong source of ${listPhrase(top.map((x) => `${MICRO_LABEL[x.k]} (${Math.round(x.pct * 100)}% of a day's reference)`))}.`,
      );
  } else {
    parts.push(`I can't measure its micronutrients reliably — I don't have full data for its ingredients.`);
  }
  return parts.join(" ");
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------------- *
 * Pinned meals — "never change my Sunday roast"
 *
 * A plan you cannot pin is not yours. A locked meal is re-imposed after EVERY rebuild (a new
 * week, a new day, a nutrient boost, a macro re-solve) and the day is then re-solved around it as
 * a fixed point, exactly like a meal the user has already eaten.
 *
 * A pin outranks PREFERENCES — cook time, budget, variety — because the user asked for it by
 * name. A pin never outranks a HARD RULE. If they go vegan, a pinned chicken roast cannot stay,
 * so the pin is dropped and they are told. Silently serving it would break I1/I2, the two
 * invariants that exist to protect someone's health.
 * ------------------------------------------------------------------------- */

function lockKey(day: string, mealType: string): string {
  return `${day}|${mealType}`;
}

function lockedSlotsFor(p: UserProfile, day: DayPlan["day"]): Set<Meal["type"]> {
  return new Set((p.lockedMeals ?? []).filter((l) => l.day === day).map((l) => l.mealType));
}

/**
 * Would this pinned recipe break a hard rule under the CURRENT profile? Diet and allergies are the
 * only things allowed to evict a pin.
 */
function lockViolatesHardRule(p: UserProfile, lock: LockedMeal): string | null {
  const recipe = RECIPES.find((r) => r.name === lock.name);
  if (!recipe) return "it isn't one of my recipes any more";
  // A pin on a slot the day no longer has (they dropped from 4 meals to 3) can never be placed.
  // Left alive it becomes a phantom: silently ignored, silently resurrected on the way back.
  if (!localSplit(p.mealsPerDay).some(([t]) => t === lock.mealType))
    return `you eat ${p.mealsPerDay} meals a day now, so there's no ${lock.mealType}`;
  if (!passesDiet(recipe, p.diet)) return `it isn't ${p.diet}`;
  if (blockedByExclusions(recipe, exclusionTokens(p))) return "it contains something you avoid";
  return null;
}

/**
 * Put every surviving pin back into its slot and re-solve those days around them.
 * Returns the plan plus any pins that had to be dropped, so the caller can update the profile
 * and say so out loud.
 */
function reimposeLocks(
  p: UserProfile,
  plan: WeekPlan,
  onlyDays?: Set<string>,
): { plan: WeekPlan; dropped: { lock: LockedMeal; why: string }[] } {
  const locks = p.lockedMeals ?? [];
  if (!locks.length) return { plan, dropped: [] };

  const dropped: { lock: LockedMeal; why: string }[] = [];
  const live: LockedMeal[] = [];
  for (const l of locks) {
    const why = lockViolatesHardRule(p, l);
    if (why) dropped.push({ lock: l, why });
    else live.push(l);
  }

  const touched = new Set(live.filter((l) => !onlyDays || onlyDays.has(l.day)).map((l) => l.day));
  const days = plan.days.map((d) => {
    if (!touched.has(d.day)) return d;
    const here = live.filter((l) => l.day === d.day);
    const meals = d.meals.map((m) => {
      const lock = here.find((l) => l.mealType === m.type);
      if (!lock || m.name === lock.name) return m;
      const recipe = RECIPES.find((r) => r.name === lock.name)!;
      const share = localSplit(p.mealsPerDay).find((sp) => sp[0] === recipe.type)?.[1] ?? 1 / p.mealsPerDay;
      return { ...toMeal(scaleRecipeToTarget(recipe, Math.round(p.targetCalories * share))), type: m.type };
    });
    const pinned = new Set(here.map((l) => l.mealType));
    return { ...d, meals: rebalanceDay(meals, p, pinned, namesOnOtherDays(plan, d.day, p)) };
  });

  return { plan: { ...plan, days }, dropped };
}

/* ------------------------------------------------------------------------- *
 * "Use up the salmon and broccoli I have"
 *
 * Preferring on-hand food was a BIAS: the selector filtered each slot toward matching recipes, but
 * the protein-diversity cap could still push fish out of the whole week, so the salmon the user
 * asked to use up simply didn't appear. Some runs, not others — the test for it could only say
 * "usually", which is another way of saying nobody knew.
 *
 * It is a guarantee now, in the same shape as the nutrient boost: build the week, then check, then
 * place what's missing. Hard rules still win — nothing on-hand gets used if it breaks the diet or
 * an allergy, and a pinned meal is never displaced to make room. When an ingredient cannot be
 * used, the engine says so instead of quietly ignoring it.
 * ------------------------------------------------------------------------- */
function guaranteeFridge(p: UserProfile, plan: WeekPlan, wanted: string[], notes: string[]): WeekPlan {
  const want = wanted.map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!want.length) return plan;

  const tokens = exclusionTokens(p);
  const uses = (m: Meal, ing: string) => m.ingredients.some((i) => i.name.trim().toLowerCase() === ing);
  const pinned = new Set((p.lockedMeals ?? []).map((l) => lockKey(l.day, l.mealType)));
  const unusable: string[] = [];
  const relaxed: string[] = [];
  const forcedBanned: string[] = []; // ingredients only a rejected dish can use up
  let cur = plan;

  for (const ing of want) {
    if (cur.days.some((d) => d.meals.some((m) => uses(m, ing)))) continue;

    const inWeek = new Set(cur.days.flatMap((d) => d.meals.map((m) => m.name.toLowerCase())));
    const eligible = RECIPES.filter(
      (r) =>
        !r.treatOnly &&
        passesDiet(r, p.diet) &&
        !blockedByExclusions(r, tokens) &&
        !inWeek.has(r.name.toLowerCase()) &&
        r.ingredients.some((i) => i.name.trim().toLowerCase() === ing),
    );
    // Cook time is a preference, so it may be relaxed — but only with disclosure, and only when
    // nothing quick enough exists.
    let cands = eligible.filter((r) => r.timeMinutes <= p.maxCookTime);
    if (!cands.length && eligible.length) {
      cands = eligible;
      relaxed.push(ing);
    }
    // "Use up the salmon" is a guarantee the user just asked for; a rating is a standing
    // preference. Prefer a dish they haven't rejected — but if the only way to use the ingredient
    // is a dish they one-starred, honour the request they made today, and say so.
    const notBanned = cands.filter((r) => !bannedForUser(p, r.name));
    if (notBanned.length) cands = notBanned;
    else if (cands.length) forcedBanned.push(ing);
    if (!cands.length) {
      unusable.push(ing);
      continue;
    }
    const score = (r: Recipe) => r.ingredients.filter((i) => want.includes(i.name.trim().toLowerCase())).length;
    cands.sort((a, b) => score(b) - score(a) || a.approxCost - b.approxCost);
    const pick = cands[0];

    // Displace a slot of the same type that is neither pinned nor already earning its keep.
    const target = cur.days.find((d) => {
      const m = d.meals.find((x) => x.type === pick.type);
      return !!m && !pinned.has(lockKey(d.day, m.type)) && !want.some((w) => uses(m, w));
    });
    if (!target) {
      unusable.push(ing);
      continue;
    }

    const share = localSplit(p.mealsPerDay).find((sp) => sp[0] === pick.type)?.[1] ?? 1 / p.mealsPerDay;
    const placed = toMeal(scaleRecipeToTarget(pick, Math.round(p.targetCalories * share)));
    const days = cur.days.map((d) => {
      if (d.day !== target.day) return d;
      const meals = d.meals.map((m) => (m.type === pick.type ? { ...placed, type: m.type } : m));
      const fixed = new Set<Meal["type"]>([pick.type, ...lockedSlotsFor(p, d.day)]);
      return { ...d, meals: rebalanceDay(meals, p, fixed, namesOnOtherDays(cur, d.day, p)) };
    });
    cur = { ...cur, days };
  }

  if (relaxed.length)
    notes.push(`Nothing with ${listPhrase(relaxed)} fits your ${p.maxCookTime}-min limit, so that meal takes a little longer.`);
  if (forcedBanned.length)
    notes.push(`The only dish I have that uses ${listPhrase(forcedBanned)} is one you rated poorly — I've used it anyway so nothing goes to waste.`);
  if (unusable.length)
    notes.push(`I couldn't work ${listPhrase(unusable)} into the week — nothing I have with ${unusable.length > 1 ? "them" : "it"} fits your plan.`);
  return cur;
}

/**
 * The contract for a boost: the user ends up with MORE of the nutrient than they had. A fresh
 * random week can easily be worse than the one it replaced, so we upgrade the new week, and if
 * that still doesn't beat what the user already had, we upgrade their existing week instead —
 * less disruption, and the promise holds either way.
 */
function guaranteeBoost(
  profile: UserProfile,
  prev: WeekPlan,
  built: WeekPlan,
  key: MicroKey,
): { plan: WeekPlan; note?: string } {
  const level = (pl: WeekPlan) => weekMicroAverage(pl, key).amount;
  const before = level(prev);
  const candidates = [upgradeForNutrient(profile, built, key), upgradeForNutrient(profile, prev, key)];
  const best = candidates.reduce((a, b) => (level(b) > level(a) ? b : a));
  // Portion rebalancing can claw back what the swaps gained, so the win is verified, not assumed.
  if (level(best) > before) return { plan: best };
  return {
    plan: prev,
    note: `I couldn't put more ${MICRO_LABEL[key]} into your week than it already has, so I left it alone.`,
  };
}

/**
 * Name a condition-driven micronutrient bias to the user, honestly. Sits next to microNote and
 * mirrors symptomNote's rule: food guidance, and it points at a doctor. Never claims completeness —
 * the engine can only favour the nutrients it actually tracks.
 */
function conditionDisclosure(keys: MicroKey[]): string {
  const labels = keys.map((k) => MICRO_LABEL[k]);
  const list =
    labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
  return (
    `Because your profile notes a condition that calls for more ${list}, I've favoured meals ` +
    `richer in ${list} while keeping your calories and protein on target. This is food guidance, ` +
    `not medical advice — check anything health-related with your doctor.`
  );
}

/**
 * A first-plan build that honours durable conditions/deficiencies in the profile: the PRIMARY
 * derived nutrient biases selection, the rest are secured in turn by guaranteeBoost. Macros stay
 * the hard invariant (every guaranteeBoost path ends in rebalanceWeek), and no already-secured
 * nutrient is allowed to fall below the unbiased baseline. Returns the plan (carrying its disclosure
 * notes when it adjusted anything) plus those notes.
 *
 * Reuses the existing boost machinery end-to-end — no new hard-coded tools. NOT yet wired into the
 * live generatePlan path: whether a fresh plan may auto-apply a condition (vs the assistant ASKing
 * first, and free-text matching's false-positive risk) is a product decision. See
 * CONDITION-AWARE-GEN.md. Exposed + tested so wiring is a one-line change once decided.
 */
export function selectConditionAwareWeek(profile: UserProfile): { plan: WeekPlan; notes: string[] } {
  const wanted = conditionBoosts(profile).filter((k) => nutrientReachable(profile, k));
  const baseline = rebalanceWeek(selectWeekFromDb(profile, undefined, false), profile);
  if (!wanted.length) return { plan: baseline, notes: [] };

  // The primary nutrient biases which dishes are chosen; a macro re-solve always follows.
  const primary = wanted[0];
  let plan = rebalanceWeek(selectWeekFromDb(profile, undefined, false, undefined, primary), profile);

  // Secure each wanted nutrient in turn. guaranteeBoost only accepts a strict gain for its own key,
  // but a later pass could claw an earlier one back down, so reject any pass that lowers an
  // already-secured nutrient.
  const secured: MicroKey[] = [];
  const EPS = 1e-6;
  for (const key of wanted) {
    const candidate = guaranteeBoost(profile, baseline, plan, key).plan;
    const holds = secured.every(
      (s) => weekMicroAverage(candidate, s).amount >= weekMicroAverage(plan, s).amount - EPS,
    );
    if (holds) {
      plan = candidate;
      secured.push(key);
    }
  }

  // Disclose only nutrients that actually ended above baseline — never claim a bias we couldn't
  // deliver from the library.
  const raised = secured.filter(
    (k) => weekMicroAverage(plan, k).amount > weekMicroAverage(baseline, k).amount + EPS,
  );
  const notes: string[] = [];
  if (raised.length) {
    notes.push(conditionDisclosure(raised));
    for (const k of raised) notes.push(microNote(plan, k));
  }
  return { plan: notes.length ? { ...plan, notes } : plan, notes };
}

/**
 * "I'm going out for dinner on Friday." The meal is in the FUTURE and its contents are unknown,
 * which makes it the opposite of log_meal: nothing about it is a fact.
 *
 * A nutritionist does two things here. They set aside a realistic calorie budget for the meal —
 * restaurant portions are large, and pretending otherwise is how a week quietly goes 3,000 kcal
 * over — and they do NOT count on it for protein, because you cannot know what you'll order. So
 * the reserved slot contributes calories and zero protein, and the rest of the day is re-solved
 * to carry the full protein target within what calories are left.
 *
 * Every assumption here is disclosed to the user. An estimate presented as a measurement is a lie.
 */
const RESTAURANT_SHARE = 0.4; // a restaurant main is a big meal, not an average one

/** Above this, a food is not a keto food. Bell peppers pass; rice, couscous and banana do not. */
const KETO_MAX_CARBS_PER_100G = 10;

function eatingOut(
  p: UserProfile,
  plan: WeekPlan,
  day: DayPlan["day"],
  mealType: Meal["type"],
  estimated: number | undefined,
  notes: string[],
): WeekPlan {
  const origDay = plan.days.find((d) => d.day === day);
  if (!origDay) return plan;
  // .map() below can only REPLACE a slot, never add one. On a 3-meal plan an eating_out for
  // "snack" silently reserved nothing while the note cheerfully claimed it had. Say the truth.
  if (!origDay.meals.some((m) => m.type === mealType)) {
    notes.push(`You don't have a ${mealType} on ${day}, so there's nothing for me to set aside there.`);
    return plan;
  }
  const reserve = estimated ?? Math.round(p.targetCalories * Math.max(slotShare(p, mealType), RESTAURANT_SHARE));

  const placeholder: Meal = {
    name: `${mealType[0].toUpperCase()}${mealType.slice(1)} out`,
    type: mealType,
    description: "Eating out — calories reserved. Log what you actually had and I'll rebalance.",
    calories: reserve,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    timeMinutes: 0,
    ingredients: [],
    steps: ["Enjoy it. Tell me what you ate afterwards and I'll re-solve the rest of the week."],
  };

  const withReserve = origDay.meals.map((m) => (m.type === mealType ? placeholder : m));
  const rest = withReserve.filter((m) => m.type !== mealType);
  // Can the remaining meals even fit in what's left? At minimum portion (0.6x) they still cost
  // something; if the reserve eats the whole day, say so instead of quietly blowing the target.
  const restFloor = rest.reduce((sum, m) => {
    // A meal with no library recipe behind it (a logged meal, an earlier reserve) CANNOT be
    // rescaled — scaleToTargets skips it. Flooring it at 0.6x understated the day and silently
    // suppressed the "you'll be over target" warning on exactly the days that needed it.
    const base = RECIPES.find((r) => r.name === m.name);
    return sum + (base ? base.calories * SCALE_LO : m.calories);
  }, 0);

  // The reserved slot is fixed, and so is every pinned slot on that day.
  const meals = rebalanceDay(withReserve, p, new Set([mealType, ...lockedSlotsFor(p, day)]), namesOnOtherDays(plan, day, p));
  const total = meals.reduce((sum, m) => sum + m.calories, 0);
  const pct = Math.round((reserve / p.targetCalories) * 100);

  notes.push(
    `I've set aside ${reserve} kcal for ${day} ${mealType} — about ${pct}% of your day — and made the other meals lighter.`,
  );
  if (!estimated)
    notes.push(
      `That ${reserve} is a typical restaurant main, not a measured number. Tell me what you actually ate and I'll rebalance.`,
    );

  // Turn the protein gap into an INSTRUCTION, not an apology. The generic shortfall note would
  // say "these recipes can't reach 150g", which is false and unhelpful: the recipes are fine, we
  // deliberately booked no protein for a meal we can't see. What the user needs is what to order.
  const homeProtein = Math.round(meals.filter((m) => m.type !== mealType).reduce((sum, m) => sum + m.proteinGrams, 0));
  const wantProtein = Math.round(dayTargetMacros(p).protein);
  const gap = wantProtein - homeProtein;
  // Protein has 4 kcal per gram, so a reserve can only physically hold so much of it. Telling
  // someone to find 90g of protein inside a 300 kcal salad is advice that cannot be followed.
  const proteinCal = gap * 4;
  if (gap <= 10)
    notes.push(`Your other meals already carry your ${wantProtein}g of protein, so order whatever you fancy.`);
  else if (proteinCal > reserve)
    notes.push(
      `To finish on ${wantProtein}g you'd need about ${gap}g of protein from that meal, which is more than ${reserve} kcal can physically hold. Either it'll be a bigger meal than that, or you'll end the day around ${gap}g short — both are fine, just tell me which and I'll plan the week around it.`,
    );
  else
    notes.push(
      `Your other meals carry ${homeProtein}g of protein, so order something with roughly ${gap}g — a chicken, fish, steak or tofu main rather than a pasta or a pizza — and you'll finish the day on your ${wantProtein}g.`,
    );

  if (reserve + restFloor > p.targetCalories * 1.05)
    notes.push(
      `Heads up: even with everything else as light as I can make it, ${day} lands about ${Math.round(total - p.targetCalories)} kcal over target. I can pull the rest of your week down to absorb it — just say the word.`,
    );
  else notes.push(`${day} still comes to ${Math.round(total)} kcal, reserve included.`);

  return { ...plan, days: plan.days.map((d) => (d.day === day ? { ...d, meals } : d)) };
}

/**
 * Can this nutrient actually be raised, given the user's diet and exclusions? Offering to
 * "rebuild the week around your B12" when no vegan food in the library carries any is a false
 * promise. A nutritionist would say plainly that food alone won't cover it.
 */
function nutrientReachable(p: UserProfile, key: MicroKey): boolean {
  const tokens = exclusionTokens(p);
  // "Reachable" must mean the gap can actually be CLOSED, not that a trace exists. One meal
  // carrying a quarter of the daily reference means three such meals get the week near target.
  const meaningful = 0.25 * DAILY_REFERENCE[key];
  return RECIPES.some(
    (r) =>
      !r.treatOnly &&
      passesDiet(r, p.diet) &&
      !blockedByExclusions(r, tokens) &&
      recipeMicros(r).micros[key] > meaningful,
  );
}

/**
 * "How am I doing this week?" Every number here is COMPUTED — averages from the plan, micros
 * from the USDA-mapped ingredients. The model never states a figure it did not get from here.
 * Nutrients whose ingredient coverage is too thin are omitted rather than guessed at.
 */
/**
 * Exported for the agent's `report` read tool (`agentTools.ts`), which must not reimplement this.
 * It is pure — plan and profile in, a sentence out — and it is the same function the
 * `weekly_report` operation pushes as a note, so the agent and the user are told the same thing by
 * the same code.
 */
export function weeklyReportNote(plan: WeekPlan, p: UserProfile): string {
  const n = plan.days.length || 1;
  const sum = (f: (m: Meal) => number) => plan.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + f(m), 0), 0);
  const kcal = Math.round(sum((m) => m.calories) / n);
  const protein = Math.round(sum((m) => m.proteinGrams) / n);
  const carbs = Math.round(sum((m) => m.carbsGrams) / n);
  const fat = Math.round(sum((m) => m.fatGrams) / n);
  const fiber = Math.round(sum((m) => m.fiberGrams ?? 0) / n);

  let s = `This week you average ${kcal} kcal a day (target ${p.targetCalories}), ${protein}g protein (target ${p.proteinGrams}g), ${carbs}g carbs, ${fat}g fat and ${fiber}g fiber.`;

  const calOff = kcal - p.targetCalories;
  if (Math.abs(calOff) > p.targetCalories * 0.1)
    s += ` That's ${Math.abs(calOff)} kcal ${calOff > 0 ? "above" : "below"} your target.`;
  const protOff = p.proteinGrams - protein;
  if (protOff > PROTEIN_MISS) s += ` Protein is ${protOff}g short.`;

  if (p.diet === "keto") {
    // Total carbs include fiber, which ketosis doesn't. Reporting 51g of carbs to someone who is
    // actually eating 30g net tells them they've failed when they haven't.
    const net = Math.max(0, Math.round(carbs - fiber));
    s +=
      net <= 50
        ? ` Net carbs — what counts for ketosis — average ${net}g a day, under the 50g that keeps you in it.`
        : ` Net carbs average ${net}g a day, above the 50g that keeps you in ketosis.`;
  }

  const fixable: string[] = [];
  const unfixable: string[] = [];
  let skipped = 0;
  for (const k of MICRO_KEYS) {
    const { amount, coverage } = weekMicroAverage(plan, k);
    if (coverage < 0.6) { skipped++; continue; }
    const pct = amount / DAILY_REFERENCE[k];
    if (pct >= 0.8) continue;
    const shown = `${MICRO_LABEL[k]} (${Math.round(pct * 100)}% of the daily reference)`;
    (nutrientReachable(p, k) ? fixable : unfixable).push(shown);
  }
  if (fixable.length)
    s += ` You're running low on ${fixable.join(", ")} — I can rebuild the week around ${fixable.length > 1 ? "any of them" : "it"}.`;
  if (unfixable.length) {
    const many = unfixable.length > 1;
    s += ` ${fixable.length ? "You're also low on" : "You're running low on"} ${unfixable.join(", ")}, and no food that fits your ${p.diet !== "none" ? p.diet + " " : ""}rules carries enough of ${many ? "them" : "it"} — that normally needs a fortified food or a supplement, which is worth raising with a doctor or dietitian.`;
  }
  if (!fixable.length && !unfixable.length) s += ` Your micronutrients all look adequate against the daily reference.`;
  if (skipped) s += ` (${skipped} nutrient${skipped > 1 ? "s" : ""} I can't measure reliably from these ingredients.)`;
  return s;
}

// Dish names used on days OTHER than `day` — so a single-day rebalance/upgrade
// doesn't introduce a dish already on the plate elsewhere in the week.
/**
 * Dishes a re-solve of `day` must not introduce, because they belong to another day.
 *
 * That includes any dish PINNED to another day, even if it isn't in the plan yet: a pin is
 * re-imposed after the rebuild, so a protein upgrade that grabs it now produces a week serving the
 * user's Sunday roast twice. (It did, in 1 of every 25 rebuilds.)
 */
function namesOnOtherDays(plan: WeekPlan, day: DayPlan["day"], profile?: UserProfile): Set<string> {
  const names = plan.days
    .filter((d) => d.day !== day)
    .flatMap((d) => d.meals.map((m) => m.name.toLowerCase()));
  for (const l of profile?.lockedMeals ?? []) if (l.day !== day) names.push(l.name.toLowerCase());
  return new Set(names);
}

/**
 * "I'm still hungry" / "that's way too much food".
 *
 * The model says which direction; these are the factors. Deliberately gentle — a nutritionist
 * nudges a portion, they don't halve it — and repeatable, because the clamp against the BASE
 * recipe means saying "smaller" five times saturates at 0.6x rather than compounding to nothing.
 */
const PORTION_FACTOR: Record<NonNullable<Operation["portionChange"]>, number> = {
  much_smaller: 0.75,
  smaller: 0.9,
  bigger: 1.1,
  much_bigger: 1.25,
};

/**
 * Resize the servings in a meal, a day, or the whole week.
 *
 * This is the one tool that deliberately moves a day OFF its calorie target: that is what the user
 * asked for. So it owes them three honest sentences — what the day now totals, what could not be
 * moved, and (for a change to the whole week) that a lasting change belongs in the target, not in
 * the portions.
 *
 * Two things it will not do. It will not rescale a meal with no recipe behind it — a restaurant
 * reserve, or something the user logged as eaten — because there are no ingredients to divide. And
 * it will not take a day below the calorie floor, however politely it's asked: "make it all much
 * smaller", repeated, must not become a starvation diet one step at a time.
 */
function scalePortions(
  p: UserProfile,
  plan: WeekPlan,
  change: NonNullable<Operation["portionChange"]>,
  day: string | undefined,
  mealType: string | undefined,
  notes: string[],
): WeekPlan {
  const factor = PORTION_FACTOR[change];
  const down = factor < 1;
  const floor = p.bodyStats?.sex ? CALORIE_FLOOR[p.bodyStats.sex] : DEFAULT_CALORIE_FLOOR;

  const inScope = (d: DayPlan, m: Meal) =>
    (!day || d.day === day) && (!mealType || m.type === mealType);

  const unscalable = new Set<string>();
  let atLimit = 0;
  let changed = 0; // meals actually rescaled — so we never CLAIM a change that didn't happen
  const blockedByFloor: string[] = [];

  const days = plan.days.map((d) => {
    if (day && d.day !== day) return d;

    const meals = d.meals.map((m) => {
      if (!inScope(d, m)) return m;
      const base = baseRecipeOf(m);
      if (!base) {
        unscalable.add(m.name);
        return m;
      }
      const current = m.calories / base.calories;
      const wanted = current * factor;
      const clamped = clampScale(wanted);
      if (Math.abs(clamped - current) < 0.02) {
        atLimit++;
        return m;
      }
      changed++;
      return { ...toMeal(scaleRecipeByFactor(base, clamped)), type: m.type };
    });

    // The floor is judged on the DAY, after everything in scope has moved. A single small meal is
    // fine; a day that adds up to less than someone can get their nutrients from is not.
    const total = meals.reduce((s, m) => s + m.calories, 0);
    if (down && total < floor) {
      blockedByFloor.push(d.day);
      return d; // leave the day exactly as it was
    }
    return { ...d, meals };
  });

  const scaled: WeekPlan = { ...plan, days };

  // Four scopes: one meal, one day, one slot across the week, or everything.
  const scope =
    day && mealType ? `${day} ${mealType}` : day ? day : mealType ? `every ${mealType}` : "the week";
  const word = change.replace("_", " ");
  if (blockedByFloor.length === plan.days.length || (day && blockedByFloor.length)) {
    notes.push(
      `I've left ${scope} as it is. Going smaller would drop ${blockedByFloor.length > 1 ? "those days" : "that day"} under ${floor} kcal, and below that it's very hard to get the nutrients you need. If you want to eat less overall, let's redo your targets properly — tell me your age, height, weight, sex and how active you are.`,
    );
    return plan;
  }

  // Nothing actually moved — don't claim it did. Say WHY: already at the sensible limit, nothing
  // resizable in scope (a restaurant reserve), or no such meal to resize at all.
  if (changed === 0) {
    if (atLimit)
      notes.push(`${scope[0].toUpperCase() + scope.slice(1)} ${atLimit === 1 ? "is" : "are"} already as ${down ? "small" : "big"} as a sensible portion goes — I've left ${atLimit === 1 ? "it" : "them"} be.`);
    else if (unscalable.size)
      notes.push(`I can't resize ${listPhrase([...unscalable])} — ${unscalable.size > 1 ? "they aren't recipes" : "that isn't a recipe"} of mine, so there's nothing to scale there.`);
    else
      notes.push(`There's nothing to resize on ${scope} — I couldn't find a meal there.`);
    return plan;
  }

  // The number has to match the scope. Reporting the week's average after the user resized one
  // day told them "Monday now averages 2028 kcal" when Monday came to 2201.
  const dayTotal = (d: DayPlan) => d.meals.reduce((t, m) => t + m.calories, 0);
  let note =
    day && mealType ? `Made ${scope} ${word}.`
    : day ? `Made ${day}'s meals ${word}.`
    : mealType ? `Made ${scope} ${word}.`
    : `Made every meal ${word}.`;
  if (day) {
    const total = dayTotal(scaled.days.find((d) => d.day === day)!);
    note += ` ${day} now comes to ${total} kcal against your ${p.targetCalories} kcal target.`;
  } else {
    const avg = Math.round(scaled.days.reduce((s, d) => s + dayTotal(d), 0) / scaled.days.length);
    note += ` Your week now averages ${avg} kcal a day against your ${p.targetCalories} kcal target.`;
  }

  if (blockedByFloor.length)
    note += ` I left ${listPhrase(blockedByFloor)} alone — going smaller would put ${blockedByFloor.length > 1 ? "them" : "it"} under ${floor} kcal.`;
  if (atLimit)
    note += ` ${atLimit === 1 ? "One meal was" : `${atLimit} meals were`} already as ${down ? "small" : "big"} as a sensible portion goes, so ${atLimit === 1 ? "it" : "they"} didn't move.`;
  if (unscalable.size)
    note += ` I couldn't resize ${listPhrase([...unscalable])} — ${unscalable.size > 1 ? "they aren't recipes" : "that isn't a recipe"} of mine.`;
  if (!day)
    note += ` If this is how you want to eat from now on, it belongs in your targets rather than your portions — say "work out my macros" and I'll set them properly.`;

  notes.push(note);
  return scaled;
}

/**
 * Resolve the dish a rating is about: the name the user said, or whatever is in the slot they
 * named. Returns null when neither identifies a real recipe.
 *
 * Only library recipes can be rated. A restaurant reserve or something the user logged has no
 * recipe behind it, so a rating on it could never change a future week — saying so beats storing
 * a preference that silently does nothing.
 */
function resolveRatedDish(plan: WeekPlan, dish?: string, day?: string, mealType?: string): Recipe | null {
  const want = dish?.trim().toLowerCase();
  if (want) {
    const exact = RECIPES.find((r) => r.name.toLowerCase() === want);
    if (exact) return exact;
    const fuzzy = RECIPES.filter((r) => nameMatches(r.name, want));
    if (fuzzy.length === 1) return fuzzy[0];
    // Ambiguous by name — fall through to the slot, which is unambiguous.
  }
  if (day && mealType) {
    const meal = plan.days.find((d) => d.day === day)?.meals.find((m) => m.type === mealType);
    if (meal) return RECIPES.find((r) => r.name === meal.name) ?? null;
  }
  return null;
}

/**
 * "That salmon was incredible" (5) / "never make me the tofu again" (1).
 *
 * A rating changes what the NEXT week looks like, not this one. We don't quietly rewrite a plan
 * the user is looking at because they passed a comment on a meal — we record the taste, and if the
 * dish is still coming up this week, we say where, so they can ask for a swap if they want one.
 */
function rateMealNote(plan: WeekPlan, recipe: Recipe, rating: number, day?: string, mealType?: string): string {
  const upcoming = plan.days
    .filter((d) => d.meals.some((m) => m.name === recipe.name))
    .map((d) => d.day)
    .filter((d) => !(d === day && mealType)); // the meal they just rated isn't "still coming up"

  if (rating >= 4) {
    const note = `Noted — you rated ${recipe.name} ${rating}/5. I'll reach for it more often.`;
    return note;
  }
  if (rating === 3) return `Noted — ${recipe.name} was a 3/5. I'll keep it in the rotation but won't favour it.`;

  const verb = rating === 1 ? `I won't plan ${recipe.name} again` : `I'll steer away from ${recipe.name}`;
  if (!upcoming.length) return `Noted — ${recipe.name} was a ${rating}/5. ${verb}.`;
  return `Noted — ${recipe.name} was a ${rating}/5. ${verb}. It's still on your ${upcoming.join(" and ")} this week; say "swap ${upcoming[0].toLowerCase()} ${recipe.type}" and I'll replace it now.`;
}

/**
 * Honest reporting for a nutrient boost: the achieved daily average against the reference
 * intake, plus the ingredient coverage behind it. We never present a number we half-guessed:
 * if too few ingredients resolved to USDA records, we say so instead of quoting a figure.
 */
function microNote(plan: WeekPlan, key: MicroKey): string {
  const { amount, coverage } = weekMicroAverage(plan, key);
  const label = MICRO_LABEL[key];
  const unit = MICRO_UNIT[key];
  if (coverage < 0.6)
    return `I've favoured ${label}-rich meals, but I can't put a reliable number on it — only ${Math.round(coverage * 100)}% of these ingredients have nutrition data.`;
  const pct = Math.round((amount / DAILY_REFERENCE[key]) * 100);
  const round = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  return `Your week now averages about ${round(amount)}${unit} of ${label} a day — roughly ${pct}% of the daily reference.`;
}

// Execute a list of tool-call operations against the plan + profile, in order.
// `update_profile` changes persist to the profile; per-day overrides don't. This
// is the general executor the tool-calling assistant drives — no per-phrase rules,
// and multiple ops compose ("cheaper and vegetarian and no onions").
export function applyOperations(
  profile: UserProfile,
  plan: WeekPlan,
  operations: Operation[],
  /** The state before the LAST change, so `undo` can restore it. The server keeps none. */
  previous?: PlanSnapshot,
): {
  plan: WeekPlan;
  profile: UserProfile;
  notes: string[];
  replyOverride?: string;
  /** What ACTUALLY changed, compared. Not inferred from which tools were named: a swap for a dish
   *  we don't have is a no-op, and used to report "Done — I updated your plan." */
  planChanged: boolean;
  profileChanged: boolean;
  /** True when this turn restored a snapshot; the caller must then forget it. */
  undone: boolean;
} {
  const p: UserProfile = { ...profile };
  let curPlan = plan;
  let profileChanged = false;
  let undone = false;
  // Set when the engine must own the ENTIRE reply and the model's words are discarded — a
  // crisis or an urgent medical symptom. Nothing the LLM writes may sit in front of it.
  let replyOverride: string | undefined;

  /**
   * Put the user's pinned meals back. Called after EVERY rebuild, and always BEFORE the engine
   * states any number — otherwise achievementNote reports a week the user is not getting.
   *
   * `effective` is the profile the day is judged against. For regenerate_day it is the per-day
   * override ("make Tuesday vegan"), NOT the saved profile — otherwise a pinned beef bowl is
   * re-imposed onto a vegan Tuesday, and the day's other meals get re-solved against the wrong
   * diet too. A pin may never break a hard rule; that includes a rule the user set for one day.
   *
   * A pin that a permanent change made impossible is dropped for good and said out loud. A pin
   * that merely conflicts with a ONE-DAY override is skipped for that day and kept — the user
   * said "make Tuesday vegan", not "stop pinning my roast".
   */
  const applyLocks = (onlyDays?: Set<string>, effective?: UserProfile) => {
    if (!p.lockedMeals?.length) return;
    const eff = effective ?? p;
    const temporary = eff !== p;
    const res = reimposeLocks(eff, curPlan, onlyDays);
    curPlan = res.plan;
    if (!res.dropped.length) return;
    if (temporary) {
      for (const d of res.dropped)
        notes.push(`${d.lock.name} is pinned on ${d.lock.day}, but ${d.why} — I've left it out just for this change and kept the pin.`);
      return;
    }
    const gone = new Set(res.dropped.map((d) => lockKey(d.lock.day, d.lock.mealType)));
    p.lockedMeals = p.lockedMeals.filter((l) => !gone.has(lockKey(l.day, l.mealType)));
    profileChanged = true;
    for (const d of res.dropped)
      notes.push(`I couldn't keep ${d.lock.name} pinned on ${d.lock.day} — ${d.why}. I've unpinned it.`);
  };
  // Factual macro notes the LLM can't produce (it does no math) — the route appends
  // these so the assistant reports honestly what the engine did.
  const notes: string[] = [];

  for (const op of operations) {
    switch (op.tool) {
      case "update_profile": {
        if (op.diet) p.diet = op.diet;
        if (op.budget) p.budget = op.budget;
        if (op.mealsPerDay === 3 || op.mealsPerDay === 4) p.mealsPerDay = op.mealsPerDay;
        if (op.maxCookTime && op.maxCookTime > 0) p.maxCookTime = op.maxCookTime;
        if (op.targetCalories && op.targetCalories > 0) p.targetCalories = op.targetCalories;
        if (op.targetProtein && op.targetProtein > 0) p.proteinGrams = op.targetProtein;
        if (op.targetCarbs && op.targetCarbs > 0) p.carbsGrams = op.targetCarbs;
        if (op.targetFat && op.targetFat > 0) p.fatGrams = op.targetFat;
        if (op.excludeFoods?.length) p.dislikes = mergeDislikes(p.dislikes, op.excludeFoods);
        profileChanged = true;
        // Re-solve every day onto the macro targets so the base plan actually hits
        // protein/calories, not just each meal's calorie share.
        {
          const rep = newReport();
          const prev = curPlan;
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
          if (op.boostNutrient) {
            const g = guaranteeBoost(p, prev, curPlan, op.boostNutrient);
            curPlan = g.plan;
            if (g.note) notes.push(g.note);
          }
          applyLocks();
          if (op.useIngredients?.length) curPlan = guaranteeFridge(p, curPlan, op.useIngredients, notes);
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          if (op.boostNutrient) notes.push(microNote(curPlan, op.boostNutrient));
        }
        break;
      }
      case "regenerate_week": {
        {
          const rep = newReport();
          const prev = curPlan;
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
          if (op.boostNutrient) {
            const g = guaranteeBoost(p, prev, curPlan, op.boostNutrient);
            curPlan = g.plan;
            if (g.note) notes.push(g.note);
          }
          applyLocks();
          if (op.useIngredients?.length) curPlan = guaranteeFridge(p, curPlan, op.useIngredients, notes);
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          if (op.boostNutrient) notes.push(microNote(curPlan, op.boostNutrient));
        }
        break;
      }
      case "regenerate_day": {
        if (!op.day) break;
        const tp: UserProfile = { ...p }; // per-day overrides — not persisted
        if (op.diet) tp.diet = op.diet;
        if (op.targetCalories && op.targetCalories > 0) tp.targetCalories = op.targetCalories;
        if (op.targetProtein && op.targetProtein > 0) tp.proteinGrams = op.targetProtein;
        if (op.excludeFoods?.length) tp.dislikes = mergeDislikes(tp.dislikes, op.excludeFoods);
        const rep = newReport();
        const newDay = selectDay(tp, op.day, curPlan, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
        notes.push(...reportNotes(rep, tp));
        const meals = keepMacros(op)
          ? rebalanceDay(newDay.meals, tp, undefined, namesOnOtherDays(curPlan, op.day, tp))
          : newDay.meals;
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...newDay, meals } : d)) };
        applyLocks(new Set([op.day]), tp);
        const finalDay = curPlan.days.find((d) => d.day === op.day);
        if (keepMacros(op) && finalDay) notes.push(achievementNote(`${op.day} now has`, dayTotalsFull(finalDay), tp));
        break;
      }
      case "swap_meal": {
        if (!op.dish) break;
        // "Pancakes every day", "make every lunch a big salad" — NO specific day means apply the dish
        // to that slot on ALL days. This is the whole-week operation the model previously couldn't
        // express: it had to emit seven separate swaps, so it did one (Monday) and falsely claimed
        // "every day". Now it's a single, honest operation.
        if (!op.day) {
          const match = findRecipeForSwap(op.dish, op.mealType ?? undefined, p);
          if (!match) {
            notes.push(`I don't have anything like "${op.dish}" that fits your plan, so I left the week as it is.`);
            break;
          }
          const slot = op.mealType ?? match.type;
          for (const day of DAYS) {
            const origDay = curPlan.days.find((d) => d.day === day);
            if (!origDay) continue;
            // A pin on this slot is overridden by an explicit whole-week swap (and removed, quietly
            // here — one summary note below covers the week rather than seven pin notices).
            if (p.lockedMeals?.some((l) => l.day === day && l.mealType === slot)) {
              p.lockedMeals = p.lockedMeals.filter((l) => !(l.day === day && l.mealType === slot));
              profileChanged = true;
            }
            const dayShare = localSplit(p.mealsPerDay).find((s) => s[0] === match.type)?.[1] ?? 1 / p.mealsPerDay;
            const dish = toMeal(scaleRecipeToTarget(match, Math.round(p.targetCalories * dayShare)));
            const swapped = origDay.meals.map((m) => (m.type === match.type ? dish : m));
            const newMeals = keepMacros(op)
              ? rebalanceDay(swapped, p, new Set([match.type, ...lockedSlotsFor(p, day)]), namesOnOtherDays(curPlan, day, p))
              : swapped;
            curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === day ? { ...d, meals: newMeals } : d)) };
          }
          const wanted = op.dish.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
          if (wanted.length && wanted.some((w) => !match.name.toLowerCase().includes(w)))
            notes.push(`I didn't have "${op.dish}" — I used ${match.name}.`);
          // Say what changed, then disclose the week's macros honestly (the same achievementNote the
          // regenerate paths use) rather than an unverified blanket "kept each day on target".
          notes.push(`Set ${match.name} as your ${slot} every day.`);
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
          break;
        }
        // Macro-aware pick: matches the requested dish, tie-broken toward the slot's
        // macro profile (e.g. the protein-forward pancake on a high-protein plan).
        const match = findRecipeForSwap(op.dish, op.mealType ?? undefined, p);
        // A pin says "don't change this when you rebuild". An explicit swap of that very slot is a
        // newer, more specific instruction, so it wins — but the pin is removed and the user is
        // told, rather than the swap silently reverting on their next regeneration.
        //
        // mealType is OPTIONAL, so the slot that actually gets swapped is the matched recipe's.
        // Keying the unpin off op.mealType alone left the pin in place and the swap reverted on
        // the next rebuild, silently.
        const swapSlot = op.mealType ?? match?.type;
        if (swapSlot && p.lockedMeals?.some((l) => l.day === op.day && l.mealType === swapSlot)) {
          const gone = p.lockedMeals.find((l) => l.day === op.day && l.mealType === swapSlot)!;
          p.lockedMeals = p.lockedMeals.filter((l) => !(l.day === op.day && l.mealType === swapSlot));
          profileChanged = true;
          notes.push(`${gone.name} was pinned on ${op.day} — I've swapped it and removed the pin.`);
        }
        const origDay = curPlan.days.find((d) => d.day === op.day);
        if (!origDay) break;
        if (!match) {
          // Say WHY we couldn't. A silent no-op looks like the app ignored you.
          const loose = findRecipeForSwap(op.dish, op.mealType ?? undefined, p, false);
          notes.push(
            loose
              ? `${loose.name} takes ${loose.timeMinutes} min, over your ${p.maxCookTime}-min limit — I left ${op.day} as it is.`
              : `I don't have anything like "${op.dish}" that fits your plan.`,
          );
          break;
        }
        const share =
          localSplit(p.mealsPerDay).find((s) => s[0] === match.type)?.[1] ?? 1 / p.mealsPerDay;
        const meal = toMeal(scaleRecipeToTarget(match, Math.round(p.targetCalories * share)));
        // Be honest when we substituted something other than what was asked for.
        // "unicorn stew" matching "Cod & Smoky Bean Stew" is a reasonable guess, but
        // the user must be told — a silent wrong swap is worse than no swap.
        const asked = op.dish.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
        const got = match.name.toLowerCase();
        const unmatched = asked.filter((w) => !got.includes(w));
        if (asked.length && unmatched.length)
          notes.push(`I didn't have "${op.dish}" — I used ${match.name} instead.`);

        const swapped = origDay.meals.map((m) => (m.type === match.type ? meal : m));
        // Keep the day on its macro targets by rebalancing the OTHER meals — the
        // swapped-in dish stays as the user requested (locked).
        const newMeals = keepMacros(op)
          ? rebalanceDay(swapped, p, new Set([match.type, ...lockedSlotsFor(p, op.day)]), namesOnOtherDays(curPlan, op.day, p))
          : swapped;
        curPlan = {
          ...curPlan,
          days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals: newMeals } : d)),
        };
        if (keepMacros(op)) {
          const kcal = newMeals.reduce((s, m) => s + m.calories, 0);
          const protein = newMeals.reduce((s, m) => s + m.proteinGrams, 0);
          // Meals the engine upgraded (a non-locked dish whose name changed) to fit
          // the requested dish in while holding macros.
          const bumped = newMeals.filter(
            (nm) =>
              nm.type !== match.type &&
              !origDay.meals.some((om) => om.type === nm.type && om.name === nm.name),
          );
          let note = `Kept ${op.day} on target — about ${kcal} kcal and ${protein}g protein.`;
          if (bumped.length)
            note += ` I bumped your ${bumped.map((b) => `${b.type} to ${b.name}`).join(" and ")} to make room.`;
          notes.push(note);
        }
        break;
      }
      case "compute_targets": {
        // The model gathers the facts; the arithmetic lives here. If a fact is missing we say
        // so rather than guessing a body weight.
        const missing = (
          [
            ["age", op.age],
            ["height", op.heightCm],
            ["weight", op.weightKg],
            ["sex", op.sex],
            ["activity level", op.activity],
          ] as const
        ).filter(([, v]) => v == null).map(([k]) => k);
        if (missing.length) {
          notes.push(`I need your ${missing.join(", ")} before I can work out your targets.`);
          break;
        }
        const t = computeTargets({
          age: op.age!,
          heightCm: op.heightCm!,
          weightKg: op.weightKg!,
          sex: op.sex!,
          activity: op.activity!,
          goal: op.goal ?? p.goal,
        });
        p.goal = op.goal ?? p.goal;
        p.targetCalories = t.calories;
        p.proteinGrams = t.proteinGrams;
        p.carbsGrams = t.carbsGrams;
        p.fatGrams = t.fatGrams;
        // Remember the facts, not just what we computed from them. Without the weight, the app
        // cannot answer "how much water should I drink?" without asking for it a second time.
        p.bodyStats = {
          age: op.age!, heightCm: op.heightCm!, weightKg: op.weightKg!,
          sex: op.sex!, activity: op.activity!,
        };
        profileChanged = true;
        const rep = newReport();
        curPlan = rebalanceWeek(selectWeekFromDb(p, undefined, false, undefined, undefined, rep), p);
        applyLocks();
        notes.push(
          explainTargets(t, {
            age: op.age!, heightCm: op.heightCm!, weightKg: op.weightKg!,
            sex: op.sex!, activity: op.activity!, goal: p.goal,
          }),
        );
        notes.push(...reportNotes(rep, p));
        notes.push(achievementNote("Your week now averages", weekAveragesFull(curPlan), p));
        break;
      }
      case "log_meal": {
        // "I ate a burger for lunch." Real life derails plans constantly; the plan should absorb
        // it rather than pretend. What you ate is a FACT — it is locked, along with everything
        // earlier in the day — and only the meals still ahead of you are re-solved.
        if (!op.day || !op.mealType) break;
        const origDay = curPlan.days.find((d) => d.day === op.day);
        if (!origDay) break;

        let eaten: Meal | null = null;
        if (op.dish) {
          // Search ALL slots, not just the logged one: pizza is a "dinner" recipe but people
          // eat it at lunch. respectSoft=false because they already ate it — cook time and
          // budget are irrelevant to a meal that is already in the past.
          const match = findRecipeForSwap(op.dish, undefined, p, false);
          if (match) eaten = { ...toMeal(match), type: op.mealType };
        }
        if (!eaten && op.loggedCalories) {
          eaten = {
            name: op.dish ? op.dish : "Logged meal",
            type: op.mealType,
            description: "Logged by you.",
            calories: op.loggedCalories,
            proteinGrams: op.loggedProtein ?? 0,
            carbsGrams: 0,
            fatGrams: 0,
            timeMinutes: 0,
            ingredients: [],
            steps: [],
          };
        }
        if (!eaten) {
          notes.push(`I don't know what's in "${op.dish ?? "that"}" — roughly how many calories was it?`);
          break;
        }
        if (op.dish && !op.loggedCalories && eaten.proteinGrams === 0 && !eaten.ingredients.length)
          notes.push(`I logged it at ${eaten.calories} kcal but I don't know its protein.`);

        // Everything already eaten today is fixed — and so is anything the user pinned. Without
        // this, logging a 1400 kcal breakfast rescaled the pinned dinner to its 0.6x floor and the
        // protein-upgrade lever was free to replace the dish outright.
        const locked = new Set([...slotsUpTo(op.mealType), ...lockedSlotsFor(p, op.day)]);
        // A logged meal is a FACT to absorb, not an edit to an existing slot. If the day has no slot
        // of this type (a 3-meal plan, a snack logged), ADD it — a plain replace-map would drop the
        // eaten meal, rebalance the day as if it never happened, and then the note would claim
        // calories the plan never actually carried (silent data loss + a false accounting).
        const hasSlot = origDay.meals.some((m) => m.type === op.mealType);
        const withEaten = hasSlot
          ? origDay.meals.map((m) => (m.type === op.mealType ? eaten! : m))
          : [...origDay.meals, eaten!];
        const newMeals = rebalanceDay(withEaten, p, locked, namesOnOtherDays(curPlan, op.day, p));
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals: newMeals } : d)) };

        const tot = dayTotals({ ...origDay, meals: newMeals });
        const ahead = newMeals.filter((m) => !locked.has(m.type));
        const changed = ahead.filter((nm) => !origDay.meals.some((om) => om.type === nm.type && om.name === nm.name));
        let note = `Logged ${eaten.name} (${eaten.calories} kcal) for ${op.mealType}.`;
        if (ahead.length === 0) note += ` That was your last meal of the day — ${op.day} lands at ${tot.kcal} kcal and ${tot.protein}g protein.`;
        else {
          note += ` I re-solved the rest of ${op.day}: it now lands at ${tot.kcal} kcal and ${tot.protein}g protein.`;
          if (changed.length) note += ` I switched your ${changed.map((c) => `${c.type} to ${c.name}`).join(" and ")}.`;
        }
        const over = tot.kcal - p.targetCalories;
        if (Math.abs(over) > p.targetCalories * 0.15)
          note += ` That's still ${Math.abs(over)} kcal ${over > 0 ? "over" : "under"} your ${p.targetCalories} kcal target — there isn't enough left in the day to fix it.`;
        const pShort = p.proteinGrams - tot.protein;
        if (pShort > PROTEIN_MISS)
          note += ` Protein lands at ${tot.protein}g against your ${p.proteinGrams}g target — what you ate didn't leave room to make it up.`;
        notes.push(note);
        break;
      }
      case "eating_out": {
        if (!op.day || !op.mealType) {
          notes.push("Which day and which meal are you eating out for?");
          break;
        }
        curPlan = eatingOut(p, curPlan, op.day, op.mealType, op.estimatedCalories ?? undefined, notes);
        break;
      }
      case "lock_meal": {
        if (!op.day || !op.mealType) {
          notes.push("Which meal would you like me to pin — which day, and breakfast, lunch or dinner?");
          break;
        }
        const day = curPlan.days.find((d) => d.day === op.day);
        const meal = day?.meals.find((m) => m.type === op.mealType);
        if (!meal) {
          notes.push(`You don't have a ${op.mealType} on ${op.day} to pin.`);
          break;
        }
        // Pins are stored by name and re-cooked from the library on every rebuild, so a meal we
        // can't rebuild (a restaurant reserve, something the user logged) cannot be pinned.
        if (!RECIPES.some((r) => r.name === meal.name)) {
          notes.push(`${meal.name} isn't one of my recipes — it's something you told me about, so I can't pin it.`);
          break;
        }
        p.lockedMeals = [
          ...(p.lockedMeals ?? []).filter((l) => !(l.day === op.day && l.mealType === op.mealType)),
          { day: op.day, mealType: op.mealType, name: meal.name },
        ];
        profileChanged = true;
        notes.push(`Pinned: ${meal.name} stays as your ${op.day} ${op.mealType}. I'll build the rest of the week around it.`);
        break;
      }
      case "unlock_meal": {
        if (!op.day || !op.mealType) {
          notes.push("Which pin should I remove — which day, and which meal?");
          break;
        }
        const had = p.lockedMeals?.find((l) => l.day === op.day && l.mealType === op.mealType);
        if (!had) {
          notes.push(`Nothing is pinned on ${op.day} ${op.mealType}.`);
          break;
        }
        p.lockedMeals = (p.lockedMeals ?? []).filter((l) => !(l.day === op.day && l.mealType === op.mealType));
        profileChanged = true;
        notes.push(`Unpinned ${had.name} — I can change ${op.day} ${op.mealType} again.`);
        break;
      }
      case "undo": {
        if (!previous) {
          notes.push("There's nothing to undo — I haven't changed anything yet.");
          break;
        }
        curPlan = previous.plan;
        // Replace the working profile wholesale. Assigning field-by-field would leave anything the
        // last turn ADDED (a pin, a rating, a stored body weight) sitting on the restored profile.
        for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
        Object.assign(p, previous.profile);
        profileChanged = true;
        undone = true;
        notes.push(`Done — I've put things back to how they were before I ${previous.label}.`);
        break;
      }
      case "scale_portions": {
        if (!op.portionChange) {
          notes.push("Would you like the portions bigger or smaller?");
          break;
        }
        curPlan = scalePortions(p, curPlan, op.portionChange, op.day ?? undefined, op.mealType ?? undefined, notes);
        break;
      }
      case "rebalance_day": {
        // "Balance my day around this" — the coach move after importing a meal. scaleToTargets holds
        // anything without a base recipe (an imported meal, a logged meal, a restaurant reserve) as a
        // FIXED contribution and rescales the day's OTHER meals' portions to hit the calorie/macro
        // target around it. Portions only — it never swaps the dishes the user chose.
        if (!op.day) {
          notes.push("Which day should I balance around your other meals?");
          break;
        }
        const dp = curPlan.days.find((d) => d.day === op.day);
        if (!dp) {
          notes.push(`I don't see ${op.day} in your plan.`);
          break;
        }
        const scaled = scaleToTargets(dp.meals, p);
        const changed = scaled.some((m, i) => JSON.stringify(m) !== JSON.stringify(dp.meals[i]));
        if (!changed) {
          notes.push(`${op.day} is already balanced around your targets — nothing to move.`);
          break;
        }
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...d, meals: scaled } : d)) };
        const total = Math.round(scaled.reduce((s, m) => s + m.calories, 0));
        const tgt = Math.round(dayTargetMacros(p).cal);
        const off = total - tgt;
        notes.push(
          Math.abs(off) <= 60
            ? `Balanced ${op.day} around your other meals — the day now lands at about ${total} kcal, on your ${tgt} target.`
            : `Balanced ${op.day} as far as realistic portions allow: about ${total} kcal, still ${off > 0 ? `${off} over` : `${-off} under`} your ${tgt} target — the fixed meal is too ${off > 0 ? "large" : "small"} for the rest of the day to fully offset.`,
        );
        break;
      }
      case "hydration": {
        // Read-only. The weight comes from the profile (compute_targets stored it) or from what
        // the user just said. We never guess a body weight — the same rule compute_targets follows.
        const weightKg = op.weightKg ?? p.bodyStats?.weightKg;
        if (!weightKg) {
          notes.push("How much do you weigh? Fluid needs scale with body weight, and I'd rather ask than guess.");
          break;
        }
        // No stored activity means we don't know it. Assume the least, and say so below — a
        // sedentary baseline under-promises, where guessing "active" would over-promise.
        const known = op.activity ?? p.bodyStats?.activity;
        const activity = known ?? "sedentary";
        if (op.weightKg || op.activity) {
          // They just told us something. Keep it, so we never ask twice.
          p.bodyStats = {
            ...p.bodyStats,
            ...(op.weightKg ? { weightKg: op.weightKg } : {}),
            ...(op.activity ? { activity: op.activity } : {}),
          };
          profileChanged = true;
        }
        let note = explainHydration(hydrationTarget(weightKg, activity), weightKg, activity);
        if (!known) note += " I've assumed you're not training much — tell me how active you are and I'll adjust it.";
        notes.push(note);
        break;
      }
      case "rate_meal": {
        const rating = op.rating;
        if (rating == null) {
          notes.push("How would you rate it, 1 to 5?");
          break;
        }
        const recipe = resolveRatedDish(curPlan, op.dish ?? undefined, op.day ?? undefined, op.mealType ?? undefined);
        if (!recipe) {
          notes.push(
            op.dish
              ? `I don't have a recipe called "${op.dish}" — which day and meal was it?`
              : "Which meal are you rating — which day, and breakfast, lunch or dinner?",
          );
          break;
        }
        p.mealRatings = [
          ...(p.mealRatings ?? []).filter((r) => r.name.toLowerCase() !== recipe.name.toLowerCase()),
          { name: recipe.name, rating: rating as MealRating["rating"] },
        ];
        profileChanged = true;
        notes.push(rateMealNote(curPlan, recipe, rating, op.day ?? undefined, op.mealType ?? undefined));
        break;
      }
      case "symptom_check": {
        // Read-only, and deliberately so: a symptom never silently rewrites someone's food.
        const res = symptomNote(curPlan, p, op.symptom ?? op.dish ?? "");
        notes.push(res.text);
        if (res.override) replyOverride = res.text;
        break;
      }
      case "substitute_ingredient": {
        // Read-only advice: the user is at the counter, not asking for a new plan.
        notes.push(
          substituteNote(curPlan, p, op.ingredient ?? op.dish ?? "", op.day ?? undefined, op.mealType ?? undefined),
        );
        break;
      }
      case "explain_meal": {
        // Read-only: justify, never change.
        if (!op.day || !op.mealType) {
          notes.push("Which meal would you like me to explain — which day, and breakfast, lunch or dinner?");
          break;
        }
        notes.push(explainMealNote(curPlan, p, op.day, op.mealType));
        break;
      }
      case "weekly_report": {
        // Read-only: report, never change. Facts computed here; the model narrates them.
        notes.push(weeklyReportNote(curPlan, p));
        break;
      }
      case "answer":
        break;
    }
  }

  // Compared, not inferred. `planWasChanged(operations)` asks which tools were NAMED; this asks
  // what actually moved. A swap for a dish we don't have is a no-op, and used to tell the user
  // "Done — I updated your plan."
  const planChanged = JSON.stringify(curPlan) !== JSON.stringify(plan);
  return {
    plan: curPlan,
    profile: profileChanged ? p : profile,
    notes,
    replyOverride,
    planChanged,
    profileChanged,
    undone,
  };
}
