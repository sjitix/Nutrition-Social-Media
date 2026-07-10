

import {
  DAYS,
  type DayPlan,
  type Meal,
  type Operation,
  type UserProfile,
  type WeekPlan,
  type LockedMeal,
} from "./types";
import { haystackBlocked, parseExclusionTokens, dietTagConflicts, wordMatches } from "./exclusions";
import { computeTargets, explainTargets } from "./targets";
import { SUBSTITUTES, INGREDIENT_ALIASES } from "./substitutions";
import { SYMPTOMS, URGENT_FLAGS, CRISIS_FLAGS, PHRASE_NOISE } from "./symptoms";
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
  proteinDays: Record<string, number>;
  usedIds: Set<string>;
  usedNames: Set<string>;
  dayCuisines: Set<string>;
  usedIngredients: Set<string>;
  fridge?: Set<string>; // on-hand ingredients to prefer ("use what's in my fridge")
  preferFiber?: boolean;
  boost?: MicroKey; // nutrient to favour ("I'm low on iron")
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

  // "Use what's in my fridge" — strongly prefer recipes built on on-hand items.
  const fridgeMatch = ctx.fridge
    ? pool.filter((r) => r.ingredients.some((i) => ctx.fridge!.has(i.name.trim().toLowerCase())))
    : [];
  if (fridgeMatch.length) pool = fridgeMatch;

  const sorted = [...pool].sort(
    (a, b) => Math.abs(a.calories - ctx.target) - Math.abs(b.calories - ctx.target),
  );
  // Among the closest calorie matches, prefer the recipe that reuses the most
  // ingredients already on the week's shopping list — fewer distinct items means
  // a cheaper, simpler shop. A little randomness keeps "generate again" fresh.
  const top = sorted.slice(0, Math.min(6, sorted.length));
  // Score rewards reusing the week's ingredients and picking cheaper recipes —
  // both keep the shop affordable and accessible. It also penalizes recipes whose
  // protein DENSITY falls short of the slot's target density, so the plan actually
  // respects the protein macro (scaling later can't fix a low-protein-per-calorie
  // pick). Randomness among the best keeps "generate again" fresh.
  const targetDensity =
    ctx.proteinTarget && ctx.target > 0 ? ctx.proteinTarget / ctx.target : 0;
  const score = (r: Recipe) =>
    r.ingredients.filter((i) => ctx.usedIngredients.has(i.name.trim().toLowerCase())).length -
    r.approxCost +
    (ctx.preferFiber ? (r.fiberGrams ?? 0) * 0.5 : 0) -
    (targetDensity > 0 ? Math.max(0, targetDensity - r.proteinGrams / r.calories) * 60 : 0) +
    (ctx.fridge
      ? r.ingredients.filter((i) => ctx.fridge!.has(i.name.trim().toLowerCase())).length * 3
      : 0) +
    // Nutrient boost, scored on DENSITY per calorie: scaling a portion raises the nutrient
    // and the calories together, so only density tells an iron-rich meal from a big one.
    // Normalised against the daily reference so every nutrient contributes on one scale.
    (ctx.boost
      ? microDensity(recipeMicros(r).micros, r.calories, ctx.boost) *
        (2000 / DAILY_REFERENCE[ctx.boost]) *
        4
      : 0);
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
}

export const newReport = (): SelectionReport => ({ droppedSlots: [], slowestOverLimit: 0, relaxedBudget: false });

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
    if (cuisinePref) {
      const pref = candidates.filter((r) => r.cuisine === cuisinePref);
      if (pref.length) candidates = pref;
    }
    const pick = chooseRecipe(candidates, {
      target,
      proteinTarget: Math.round(profile.proteinGrams * share),
      proteinDays: ctx.proteinDays,
      usedIds: ctx.usedIds,
      usedNames: ctx.usedNames,
      dayCuisines,
      usedIngredients: ctx.usedIngredients,
      fridge: ctx.fridge,
      preferFiber,
      boost: ctx.boost,
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
const MACRO_WEIGHTS: Macros = { cal: 4, protein: 3, carbs: 1, fat: 1, fiber: 0.5 };
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
function dayTargetMacros(p: UserProfile): Macros {
  return { cal: p.targetCalories, protein: p.proteinGrams, carbs: p.carbsGrams, fat: p.fatGrams, fiber: DAY_FIBER_TARGET };
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
  const scored: { r: Recipe; kw: number }[] = [];
  for (const r of RECIPES) {
    if (type && r.type !== type) continue;
    if (!passesDiet(r, profile.diet) || blockedByExclusions(r, tokens) || r.approxCost > cap) continue;
    if (
      respectSoft &&
      (r.timeMinutes > profile.maxCookTime + 5 || r.ingredients.length > profile.maxIngredients + 1)
    )
      continue;
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

const weekAverages = (plan: WeekPlan) => {
  const n = plan.days.length || 1;
  const t = plan.days.map(dayTotals);
  return {
    kcal: Math.round(t.reduce((s, x) => s + x.kcal, 0) / n),
    protein: Math.round(t.reduce((s, x) => s + x.protein, 0) / n),
  };
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
function achievementNote(label: string, got: { kcal: number; protein: number }, p: UserProfile): string {
  let note = `${label} ${got.kcal} kcal and ${got.protein}g protein.`;
  const short = p.proteinGrams - got.protein;
  if (short > PROTEIN_MISS)
    note += ` I couldn't reach ${p.proteinGrams}g protein within your diet, budget and time limits — ${got.protein}g is the most these recipes allow.`;
  // Calories were only ever reported, never admitted as missed. A user setting 4000 kcal was
  // told "your week averages 2100 kcal" as though that were success.
  const calMiss = got.kcal - p.targetCalories;
  if (Math.abs(calMiss) > p.targetCalories * 0.1)
    note += ` That's ${Math.abs(calMiss)} kcal ${calMiss < 0 ? "below" : "above"} your ${p.targetCalories} kcal target — these recipes can't stretch further without unrealistic portions.`;
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
function weeklyReportNote(plan: WeekPlan, p: UserProfile): string {
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
): { plan: WeekPlan; profile: UserProfile; notes: string[]; replyOverride?: string } {
  const p: UserProfile = { ...profile };
  let curPlan = plan;
  let profileChanged = false;
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
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAverages(curPlan), p));
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
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAverages(curPlan), p));
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
        const finalDay = curPlan.days.find((d) => d.day === op.day)!;
        if (keepMacros(op)) notes.push(achievementNote(`${op.day} now has`, dayTotals(finalDay), tp));
        break;
      }
      case "swap_meal": {
        if (!op.day || !op.dish) break;
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
        notes.push(achievementNote("Your week now averages", weekAverages(curPlan), p));
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
        const withEaten = origDay.meals.map((m) => (m.type === op.mealType ? eaten! : m));
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

  return { plan: curPlan, profile: profileChanged ? p : profile, notes, replyOverride };
}
