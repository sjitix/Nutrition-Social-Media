

import {
  DAYS,
  type DayPlan,
  type Meal,
  type Operation,
  type UserProfile,
  type WeekPlan,
} from "./types";
import { haystackBlocked, parseExclusionTokens } from "./exclusions";
import {
  microsForIngredients,
  microDensity,
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
export const RECIPES: Recipe[] = [
  // ---- Breakfasts ----
  {
    id: "b-greek-yogurt", name: "Greek Yogurt & Berry Bowl", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    calories: 380, proteinGrams: 22, carbsGrams: 48, fatGrams: 10, timeMinutes: 8, approxCost: 2,
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
    calories: 420, proteinGrams: 27, carbsGrams: 12, fatGrams: 28, timeMinutes: 12, approxCost: 1,
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
    calories: 410, proteinGrams: 14, carbsGrams: 62, fatGrams: 12, timeMinutes: 10, approxCost: 1,
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
    calories: 400, proteinGrams: 24, carbsGrams: 34, fatGrams: 16, timeMinutes: 15, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Turmeric tofu scramble with veggies in a warm tortilla.",
    ingredients: [
      { name: "Firm tofu", quantity: "150 g" },
      { name: "Whole-wheat tortilla", quantity: "1 piece" },
      { name: "Spinach", quantity: "40 g" },
      { name: "Turmeric", quantity: "1 tsp" },
    ],
    steps: ["Crumble and fry tofu with turmeric and spinach.", "Wrap in the tortilla."],
  },
  {
    id: "b-shakshuka", name: "Shakshuka", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    calories: 430, proteinGrams: 22, carbsGrams: 28, fatGrams: 24, timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Eggs poached in a spiced tomato and pepper sauce.",
    ingredients: [
      { name: "Eggs", quantity: "2 pieces" },
      { name: "Chopped tomatoes", quantity: "1 can" },
      { name: "Bell pepper", quantity: "1 piece" },
      { name: "Paprika", quantity: "1 tsp" },
    ],
    steps: ["Simmer peppers, tomatoes and paprika.", "Crack in eggs; cook until set."],
  },
  {
    id: "b-salmon-bagel", name: "Smoked Salmon Bagel", type: "breakfast",
    cuisine: "american", mainProtein: "fish",
    calories: 450, proteinGrams: 28, carbsGrams: 40, fatGrams: 18, timeMinutes: 8, approxCost: 3,
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
    calories: 390, proteinGrams: 16, carbsGrams: 42, fatGrams: 17, timeMinutes: 10, approxCost: 1,
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
    calories: 560, proteinGrams: 42, carbsGrams: 50, fatGrams: 16, timeMinutes: 20, approxCost: 2,
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
    calories: 480, proteinGrams: 34, carbsGrams: 30, fatGrams: 22, timeMinutes: 15, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Tuna, egg, green beans and potatoes with a light dressing.",
    ingredients: [
      { name: "Canned tuna", quantity: "1 can" },
      { name: "Egg", quantity: "1 piece" },
      { name: "Green beans", quantity: "100 g" },
      { name: "Baby potatoes", quantity: "150 g" },
    ],
    steps: ["Boil egg, beans and potatoes.", "Flake tuna over; dress and toss."],
  },
  {
    id: "l-beef-burrito", name: "Beef Burrito Bowl", type: "lunch",
    cuisine: "mexican", mainProtein: "beef",
    calories: 620, proteinGrams: 38, carbsGrams: 60, fatGrams: 22, timeMinutes: 25, approxCost: 3,
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
    calories: 480, proteinGrams: 24, carbsGrams: 70, fatGrams: 10, timeMinutes: 30, approxCost: 1,
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
    calories: 520, proteinGrams: 26, carbsGrams: 68, fatGrams: 14, timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crispy tofu and vegetables in teriyaki over rice.",
    ingredients: [
      { name: "Firm tofu", quantity: "150 g" },
      { name: "Rice", quantity: "70 g dry" },
      { name: "Mixed stir-fry veg", quantity: "150 g" },
      { name: "Teriyaki sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook rice; fry tofu until golden.", "Stir-fry veg with sauce; combine."],
  },
  {
    id: "l-turkey-wrap", name: "Turkey Avocado Wrap", type: "lunch",
    cuisine: "american", mainProtein: "turkey",
    calories: 540, proteinGrams: 38, carbsGrams: 42, fatGrams: 22, timeMinutes: 10, approxCost: 2,
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
    calories: 560, proteinGrams: 32, carbsGrams: 70, fatGrams: 16, timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Wok-fried rice with shrimp, egg and peas.",
    ingredients: [
      { name: "Shrimp", quantity: "120 g" },
      { name: "Cooked rice", quantity: "200 g" },
      { name: "Egg", quantity: "1 piece" },
      { name: "Peas", quantity: "60 g" },
    ],
    steps: ["Scramble egg; set aside.", "Fry shrimp and rice with peas; combine."],
  },

  // ---- Dinners ----
  {
    id: "d-baked-salmon", name: "Baked Salmon & Potatoes", type: "dinner",
    cuisine: "mediterranean", mainProtein: "fish",
    calories: 590, proteinGrams: 38, carbsGrams: 45, fatGrams: 26, timeMinutes: 30, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Oven salmon with baby potatoes and broccoli.",
    ingredients: [
      { name: "Salmon fillet", quantity: "150 g" },
      { name: "Baby potatoes", quantity: "250 g" },
      { name: "Broccoli", quantity: "150 g" },
      { name: "Lemon", quantity: "1/2 piece" },
    ],
    steps: ["Roast potatoes 25 min.", "Add salmon and broccoli for the last 12 min."],
  },
  {
    id: "d-turkey-chili", name: "Turkey Chili", type: "dinner",
    cuisine: "american", mainProtein: "turkey",
    calories: 540, proteinGrams: 40, carbsGrams: 50, fatGrams: 16, timeMinutes: 30, approxCost: 2,
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
    calories: 560, proteinGrams: 44, carbsGrams: 30, fatGrams: 26, timeMinutes: 30, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Roast pork tenderloin with asparagus and garlic.",
    ingredients: [
      { name: "Pork tenderloin", quantity: "160 g" },
      { name: "Asparagus", quantity: "150 g" },
      { name: "Garlic", quantity: "2 cloves" },
      { name: "Olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Sear pork, then roast 15 min.", "Roast asparagus alongside; rest and slice."],
  },
  {
    id: "d-chickpea-curry", name: "Chickpea Curry", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    calories: 520, proteinGrams: 20, carbsGrams: 78, fatGrams: 14, timeMinutes: 25, approxCost: 1,
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
    calories: 640, proteinGrams: 40, carbsGrams: 70, fatGrams: 22, timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Beef and vegetables tossed with noodles in soy-ginger sauce.",
    ingredients: [
      { name: "Beef strips", quantity: "140 g" },
      { name: "Egg noodles", quantity: "90 g dry" },
      { name: "Mixed veg", quantity: "150 g" },
      { name: "Soy sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook noodles.", "Stir-fry beef and veg with soy; toss with noodles."],
  },
  {
    id: "d-chicken-fajitas", name: "Chicken Fajitas", type: "dinner",
    cuisine: "mexican", mainProtein: "chicken",
    calories: 580, proteinGrams: 44, carbsGrams: 48, fatGrams: 22, timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "Sizzling chicken and peppers with warm tortillas.",
    ingredients: [
      { name: "Chicken breast", quantity: "160 g" },
      { name: "Bell peppers", quantity: "2 pieces" },
      { name: "Tortillas", quantity: "2 pieces" },
      { name: "Fajita spice", quantity: "1 tbsp" },
    ],
    steps: ["Sear spiced chicken and peppers.", "Serve in warm tortillas."],
  },
  {
    id: "d-eggplant-parm", name: "Eggplant Parmesan", type: "dinner",
    cuisine: "italian", mainProtein: "dairy",
    calories: 520, proteinGrams: 24, carbsGrams: 48, fatGrams: 26, timeMinutes: 30, approxCost: 2,
    dietTags: ["vegetarian"],
    description: "Baked eggplant layered with tomato sauce and mozzarella.",
    ingredients: [
      { name: "Eggplant", quantity: "1 piece" },
      { name: "Tomato sauce", quantity: "200 g" },
      { name: "Mozzarella", quantity: "60 g" },
      { name: "Parmesan", quantity: "15 g" },
    ],
    steps: ["Roast eggplant slices.", "Layer with sauce and cheese; bake 15 min."],
  },

  // ---- Snacks ----
  {
    id: "s-yogurt-honey", name: "Greek Yogurt & Honey", type: "snack",
    cuisine: "mediterranean", mainProtein: "dairy",
    calories: 210, proteinGrams: 16, carbsGrams: 22, fatGrams: 6, timeMinutes: 3, approxCost: 1,
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
    calories: 290, proteinGrams: 22, carbsGrams: 38, fatGrams: 6, timeMinutes: 5, approxCost: 2,
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
    calories: 360, proteinGrams: 28, carbsGrams: 14, fatGrams: 22, fiberGrams: 5, timeMinutes: 25, approxCost: 1,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Baked egg muffins with spinach and feta — meal-prep friendly.",
    ingredients: [
      { name: "eggs", quantity: "4" },
      { name: "spinach", quantity: "80 g" },
      { name: "feta", quantity: "40 g" },
      { name: "cherry tomatoes", quantity: "60 g" },
    ],
    steps: ["Whisk eggs with chopped spinach, feta and tomatoes.", "Pour into a muffin tin; bake at 190°C for 18 minutes."],
  },
  {
    id: "b-protein-oats", name: "Overnight Protein Oats with Berries", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    calories: 420, proteinGrams: 32, carbsGrams: 52, fatGrams: 10, fiberGrams: 9, timeMinutes: 5, approxCost: 1,
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
    calories: 400, proteinGrams: 30, carbsGrams: 42, fatGrams: 12, fiberGrams: 6, timeMinutes: 15, approxCost: 2,
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
    calories: 390, proteinGrams: 31, carbsGrams: 22, fatGrams: 20, fiberGrams: 5, timeMinutes: 10, approxCost: 3,
    dietTags: ["mediterranean"],
    description: "Soft scrambled eggs folded with smoked salmon on rye.",
    ingredients: [
      { name: "eggs", quantity: "3" },
      { name: "smoked salmon", quantity: "60 g" },
      { name: "rye bread", quantity: "1 slice" },
      { name: "chives", quantity: "1 tbsp" },
    ],
    steps: ["Softly scramble the eggs.", "Fold in salmon and chives; serve on toasted rye."],
  },
  {
    id: "b-chickpea-omelette", name: "Savory Chickpea Flour Omelette", type: "breakfast",
    cuisine: "indian", mainProtein: "legumes",
    calories: 370, proteinGrams: 22, carbsGrams: 44, fatGrams: 12, fiberGrams: 11, timeMinutes: 15, approxCost: 1,
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
    calories: 430, proteinGrams: 33, carbsGrams: 40, fatGrams: 16, fiberGrams: 8, timeMinutes: 20, approxCost: 2,
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
    calories: 410, proteinGrams: 34, carbsGrams: 44, fatGrams: 12, fiberGrams: 7, timeMinutes: 5, approxCost: 1,
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
    calories: 440, proteinGrams: 26, carbsGrams: 52, fatGrams: 15, fiberGrams: 13, timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Turmeric tofu scramble with black beans in a wrap.",
    ingredients: [
      { name: "firm tofu", quantity: "120 g" },
      { name: "black beans", quantity: "80 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "salsa", quantity: "2 tbsp" },
    ],
    steps: ["Scramble crumbled tofu with turmeric; warm the beans.", "Fill the wrap with tofu, beans and salsa; roll."],
  },
  {
    id: "b-yogurt-bark", name: "Greek Yogurt Bark with Almonds", type: "breakfast",
    cuisine: "mediterranean", mainProtein: "dairy",
    calories: 340, proteinGrams: 24, carbsGrams: 30, fatGrams: 14, fiberGrams: 6, timeMinutes: 10, approxCost: 2,
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
    calories: 430, proteinGrams: 25, carbsGrams: 40, fatGrams: 20, fiberGrams: 10, timeMinutes: 15, approxCost: 2,
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
    calories: 560, proteinGrams: 45, carbsGrams: 48, fatGrams: 18, fiberGrams: 11, timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Herby quinoa tabbouleh with sliced grilled chicken.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "parsley", quantity: "30 g" },
      { name: "cucumber", quantity: "1/2" },
      { name: "lemon", quantity: "1/2" },
    ],
    steps: ["Cook quinoa; toss with chopped parsley, cucumber and lemon.", "Grill the chicken and slice over the top."],
  },
  {
    id: "l-salmon-poke", name: "Salmon Poke Bowl with Edamame", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    calories: 580, proteinGrams: 40, carbsGrams: 56, fatGrams: 20, fiberGrams: 10, timeMinutes: 15, approxCost: 3,
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
    calories: 520, proteinGrams: 26, carbsGrams: 70, fatGrams: 14, fiberGrams: 18, timeMinutes: 30, approxCost: 1,
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
    calories: 500, proteinGrams: 40, carbsGrams: 44, fatGrams: 18, fiberGrams: 10, timeMinutes: 10, approxCost: 2,
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
    calories: 560, proteinGrams: 40, carbsGrams: 62, fatGrams: 14, fiberGrams: 14, timeMinutes: 20, approxCost: 3,
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
    calories: 480, proteinGrams: 42, carbsGrams: 38, fatGrams: 16, fiberGrams: 12, timeMinutes: 10, approxCost: 2,
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
    calories: 540, proteinGrams: 27, carbsGrams: 66, fatGrams: 16, fiberGrams: 12, timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Glazed tofu with pickled carrot over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "carrot", quantity: "1" },
      { name: "soy sauce", quantity: "2 tbsp" },
    ],
    steps: ["Pan-fry tofu and glaze with soy.", "Serve over rice with quick-pickled carrot."],
  },
  {
    id: "l-chicken-shawarma", name: "Chicken Shawarma Bowl with Tahini", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "chicken",
    calories: 580, proteinGrams: 46, carbsGrams: 48, fatGrams: 20, fiberGrams: 11, timeMinutes: 25, approxCost: 2,
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
    calories: 600, proteinGrams: 44, carbsGrams: 58, fatGrams: 20, fiberGrams: 9, timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Classic beef and broccoli in soy-ginger over rice.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook rice.", "Stir-fry beef and broccoli with the sauce; serve over rice."],
  },
  {
    id: "l-chickpea-spinach-curry", name: "Chickpea & Spinach Curry with Rice", type: "lunch",
    cuisine: "indian", mainProtein: "legumes",
    calories: 540, proteinGrams: 22, carbsGrams: 82, fatGrams: 12, fiberGrams: 16, timeMinutes: 25, approxCost: 1,
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
    calories: 540, proteinGrams: 45, carbsGrams: 42, fatGrams: 18, fiberGrams: 10, timeMinutes: 25, approxCost: 3,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Flaky baked cod with lemony quinoa and asparagus.",
    ingredients: [
      { name: "cod fillet", quantity: "170 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "asparagus", quantity: "150 g" },
      { name: "lemon", quantity: "1/2" },
    ],
    steps: ["Bake cod and asparagus at 200°C for 15 min.", "Serve over lemon-dressed quinoa."],
  },
  {
    id: "d-turkey-meatballs", name: "Turkey Meatballs with Whole-Wheat Pasta", type: "dinner",
    cuisine: "italian", mainProtein: "turkey",
    calories: 620, proteinGrams: 46, carbsGrams: 62, fatGrams: 18, fiberGrams: 12, timeMinutes: 30, approxCost: 2,
    dietTags: [],
    description: "Lean turkey meatballs in tomato sauce over whole-wheat pasta.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "whole-wheat pasta", quantity: "80 g dry" },
      { name: "tomato sauce", quantity: "150 g" },
      { name: "parmesan", quantity: "15 g" },
    ],
    steps: ["Roll and bake turkey meatballs 15 min.", "Simmer in sauce; serve over pasta with parmesan."],
  },
  {
    id: "d-sheet-fajitas", name: "Sheet-Pan Chicken Fajitas", type: "dinner",
    cuisine: "mexican", mainProtein: "chicken",
    calories: 560, proteinGrams: 46, carbsGrams: 48, fatGrams: 18, fiberGrams: 11, timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "One-pan chicken and peppers with warm tortillas.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "bell peppers", quantity: "2" },
      { name: "corn tortillas", quantity: "2" },
      { name: "black beans", quantity: "60 g" },
      { name: "fajita spice", quantity: "1 tbsp" },
    ],
    steps: ["Roast spiced chicken and peppers on a sheet 20 min.", "Serve in tortillas with beans."],
  },
  {
    id: "d-lentil-bolognese", name: "Lentil Bolognese over Whole-Wheat Spaghetti", type: "dinner",
    cuisine: "italian", mainProtein: "legumes",
    calories: 560, proteinGrams: 26, carbsGrams: 88, fatGrams: 10, fiberGrams: 18, timeMinutes: 30, approxCost: 1,
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
    calories: 600, proteinGrams: 42, carbsGrams: 58, fatGrams: 20, fiberGrams: 9, timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Glazed salmon with steamed broccoli over rice.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "broccoli", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
    ],
    steps: ["Bake salmon glazed with teriyaki 12 min.", "Serve with steamed broccoli and rice."],
  },
  {
    id: "d-beef-chili", name: "Beef & Bean Chili with Sweet Potato", type: "dinner",
    cuisine: "american", mainProtein: "beef",
    calories: 580, proteinGrams: 42, carbsGrams: 56, fatGrams: 18, fiberGrams: 16, timeMinutes: 35, approxCost: 2,
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
    calories: 560, proteinGrams: 28, carbsGrams: 62, fatGrams: 18, fiberGrams: 12, timeMinutes: 30, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Crispy baked tofu cutlet with a crunchy slaw and rice.",
    ingredients: [
      { name: "firm tofu", quantity: "160 g" },
      { name: "panko", quantity: "40 g" },
      { name: "cabbage", quantity: "100 g" },
      { name: "brown rice", quantity: "70 g dry" },
    ],
    steps: ["Coat tofu slabs in panko; bake at 210°C for 20 min.", "Serve with slaw and rice."],
  },
  {
    id: "d-chickpea-tagine", name: "Moroccan Chickpea & Vegetable Tagine", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "legumes",
    calories: 520, proteinGrams: 20, carbsGrams: 84, fatGrams: 10, fiberGrams: 18, timeMinutes: 30, approxCost: 1,
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
    calories: 580, proteinGrams: 46, carbsGrams: 46, fatGrams: 22, fiberGrams: 12, timeMinutes: 30, approxCost: 3,
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
    calories: 560, proteinGrams: 48, carbsGrams: 38, fatGrams: 24, fiberGrams: 9, timeMinutes: 25, approxCost: 2,
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
    calories: 370, proteinGrams: 27, carbsGrams: 12, fatGrams: 24, fiberGrams: 4, timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "keto", "gluten_free"],
    description: "Oven frittata with mushrooms, spinach and goat cheese.",
    ingredients: [
      { name: "eggs", quantity: "4" },
      { name: "mushrooms", quantity: "100 g" },
      { name: "spinach", quantity: "50 g" },
      { name: "goat cheese", quantity: "40 g" },
    ],
    steps: ["Sauté mushrooms and spinach.", "Add whisked eggs and goat cheese; bake at 190°C for 12 min."],
  },
  {
    id: "b-apple-porridge", name: "Apple Cinnamon Protein Porridge", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    calories: 410, proteinGrams: 30, carbsGrams: 56, fatGrams: 8, fiberGrams: 9, timeMinutes: 10, approxCost: 1,
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
    calories: 420, proteinGrams: 24, carbsGrams: 44, fatGrams: 18, fiberGrams: 12, timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Fried eggs over black beans and salsa on a corn tortilla.",
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "black beans", quantity: "100 g" },
      { name: "corn tortillas", quantity: "2" },
      { name: "salsa", quantity: "3 tbsp" },
    ],
    steps: ["Warm beans and tortillas.", "Top with fried eggs and salsa."],
  },
  {
    id: "b-tofu-kale-toast", name: "Scrambled Tofu & Kale Toast", type: "breakfast",
    cuisine: "american", mainProtein: "tofu",
    calories: 380, proteinGrams: 25, carbsGrams: 34, fatGrams: 16, fiberGrams: 9, timeMinutes: 12, approxCost: 1,
    dietTags: ["vegan", "vegetarian"],
    description: "Turmeric tofu scramble with kale on whole-grain toast.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "kale", quantity: "50 g" },
      { name: "whole-grain toast", quantity: "1 slice" },
      { name: "turmeric", quantity: "1 tsp" },
    ],
    steps: ["Scramble crumbled tofu with turmeric and kale.", "Serve on toasted bread."],
  },
  {
    id: "b-salmon-breakfast-bowl", name: "Savory Salmon & Avocado Breakfast Bowl", type: "breakfast",
    cuisine: "asian", mainProtein: "fish",
    calories: 440, proteinGrams: 30, carbsGrams: 38, fatGrams: 20, fiberGrams: 8, timeMinutes: 12, approxCost: 3,
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
    calories: 360, proteinGrams: 24, carbsGrams: 42, fatGrams: 12, fiberGrams: 7, timeMinutes: 25, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Oat-based banana muffins boosted with protein and walnuts.",
    ingredients: [
      { name: "oat flour", quantity: "80 g" },
      { name: "banana", quantity: "2" },
      { name: "eggs", quantity: "2" },
      { name: "protein powder", quantity: "1 scoop" },
      { name: "walnuts", quantity: "20 g" },
    ],
    steps: ["Mash bananas; mix with all ingredients.", "Bake in a muffin tin at 180°C for 18 min."],
  },
  {
    id: "b-menemen", name: "Turkish Menemen", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    calories: 380, proteinGrams: 22, carbsGrams: 26, fatGrams: 22, fiberGrams: 7, timeMinutes: 15, approxCost: 1,
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
    calories: 400, proteinGrams: 30, carbsGrams: 36, fatGrams: 16, fiberGrams: 10, timeMinutes: 12, approxCost: 2,
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
    calories: 390, proteinGrams: 26, carbsGrams: 44, fatGrams: 13, fiberGrams: 9, timeMinutes: 5, approxCost: 2,
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
    calories: 520, proteinGrams: 44, carbsGrams: 42, fatGrams: 18, fiberGrams: 9, timeMinutes: 15, approxCost: 2,
    dietTags: [],
    description: "Grilled chicken, romaine and light Caesar in a wrap.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "romaine", quantity: "60 g" },
      { name: "light Caesar dressing", quantity: "1 tbsp" },
      { name: "parmesan", quantity: "10 g" },
    ],
    steps: ["Grill and slice the chicken.", "Toss with romaine, dressing and parmesan; wrap."],
  },
  {
    id: "l-miso-soba", name: "Miso Salmon Soba Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "fish",
    calories: 580, proteinGrams: 40, carbsGrams: 62, fatGrams: 18, fiberGrams: 10, timeMinutes: 20, approxCost: 3,
    dietTags: [],
    description: "Miso-glazed salmon over soba noodles with greens.",
    ingredients: [
      { name: "salmon fillet", quantity: "140 g" },
      { name: "soba noodles", quantity: "80 g dry" },
      { name: "pak choi", quantity: "100 g" },
      { name: "miso paste", quantity: "1 tbsp" },
    ],
    steps: ["Cook soba; glaze and bake salmon with miso.", "Serve over noodles with wilted greens."],
  },
  {
    id: "l-falafel-plate", name: "Falafel & Tabbouleh Plate", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "legumes",
    calories: 540, proteinGrams: 22, carbsGrams: 68, fatGrams: 18, fiberGrams: 16, timeMinutes: 25, approxCost: 1,
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
    calories: 520, proteinGrams: 42, carbsGrams: 48, fatGrams: 15, fiberGrams: 12, timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Bell peppers stuffed with turkey, quinoa and tomato.",
    ingredients: [
      { name: "ground turkey", quantity: "140 g" },
      { name: "quinoa", quantity: "60 g dry" },
      { name: "bell peppers", quantity: "2" },
      { name: "tomato sauce", quantity: "100 g" },
    ],
    steps: ["Brown turkey; mix with cooked quinoa and sauce.", "Stuff peppers; bake at 190°C for 20 min."],
  },
  {
    id: "l-thai-peanut-chicken", name: "Thai Peanut Chicken Rice Bowl", type: "lunch",
    cuisine: "asian", mainProtein: "chicken",
    calories: 600, proteinGrams: 44, carbsGrams: 58, fatGrams: 22, fiberGrams: 9, timeMinutes: 20, approxCost: 2,
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
    calories: 500, proteinGrams: 40, carbsGrams: 46, fatGrams: 16, fiberGrams: 11, timeMinutes: 15, approxCost: 2,
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
    calories: 520, proteinGrams: 20, carbsGrams: 82, fatGrams: 12, fiberGrams: 18, timeMinutes: 25, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Roasted sweet potato and black bean tacos with slaw.",
    ingredients: [
      { name: "sweet potato", quantity: "1" },
      { name: "black beans", quantity: "120 g" },
      { name: "corn tortillas", quantity: "3" },
      { name: "cabbage", quantity: "60 g" },
    ],
    steps: ["Roast diced sweet potato with spices.", "Fill tortillas with beans, potato and slaw."],
  },
  {
    id: "l-beef-kofta-bulgur", name: "Beef Kofta & Bulgur Bowl", type: "lunch",
    cuisine: "middle_eastern", mainProtein: "beef",
    calories: 600, proteinGrams: 42, carbsGrams: 52, fatGrams: 22, fiberGrams: 11, timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Spiced beef kofta over bulgur with cucumber-yogurt.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "bulgur", quantity: "70 g dry" },
      { name: "cucumber", quantity: "1/2" },
      { name: "yogurt", quantity: "2 tbsp" },
    ],
    steps: ["Shape spiced beef into kofta; grill.", "Serve over bulgur with cucumber-yogurt."],
  },
  {
    id: "l-egg-avocado-salad", name: "Egg & Avocado Protein Salad", type: "lunch",
    cuisine: "american", mainProtein: "eggs",
    calories: 480, proteinGrams: 30, carbsGrams: 30, fatGrams: 28, fiberGrams: 12, timeMinutes: 12, approxCost: 1,
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
    calories: 560, proteinGrams: 30, carbsGrams: 64, fatGrams: 18, fiberGrams: 12, timeMinutes: 20, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Caramelized tempeh with broccoli over rice.",
    ingredients: [
      { name: "tempeh", quantity: "140 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "broccoli", quantity: "120 g" },
      { name: "teriyaki sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook rice; pan-fry tempeh and glaze with teriyaki.", "Serve with steamed broccoli."],
  },

  // ---- Dinners ----
  {
    id: "d-chicken-parm", name: "Baked Chicken Parmesan with Zucchini", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    calories: 580, proteinGrams: 50, carbsGrams: 40, fatGrams: 22, fiberGrams: 9, timeMinutes: 30, approxCost: 2,
    dietTags: [],
    description: "Lighter baked chicken parm with roasted zucchini.",
    ingredients: [
      { name: "chicken breast", quantity: "170 g" },
      { name: "tomato sauce", quantity: "120 g" },
      { name: "mozzarella", quantity: "40 g" },
      { name: "zucchini", quantity: "1" },
      { name: "panko", quantity: "30 g" },
    ],
    steps: ["Coat chicken in panko; bake 15 min.", "Top with sauce and mozzarella; bake 8 min with zucchini."],
  },
  {
    id: "d-garlic-shrimp-quinoa", name: "Garlic Shrimp & Quinoa with Spinach", type: "dinner",
    cuisine: "mediterranean", mainProtein: "shrimp",
    calories: 520, proteinGrams: 40, carbsGrams: 46, fatGrams: 16, fiberGrams: 10, timeMinutes: 20, approxCost: 3,
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
    calories: 560, proteinGrams: 44, carbsGrams: 54, fatGrams: 16, fiberGrams: 15, timeMinutes: 25, approxCost: 2,
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
    calories: 500, proteinGrams: 42, carbsGrams: 48, fatGrams: 12, fiberGrams: 8, timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Sweet-savory miso cod with bok choy over rice.",
    ingredients: [
      { name: "cod fillet", quantity: "170 g" },
      { name: "bok choy", quantity: "120 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "miso paste", quantity: "1 tbsp" },
    ],
    steps: ["Glaze cod with miso; bake 12 min.", "Serve with steamed bok choy and rice."],
  },
  {
    id: "d-red-lentil-dahl", name: "Red Lentil Dahl with Brown Rice", type: "dinner",
    cuisine: "indian", mainProtein: "legumes",
    calories: 540, proteinGrams: 24, carbsGrams: 88, fatGrams: 8, fiberGrams: 18, timeMinutes: 30, approxCost: 1,
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
    calories: 620, proteinGrams: 46, carbsGrams: 46, fatGrams: 26, fiberGrams: 11, timeMinutes: 30, approxCost: 3,
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
    calories: 580, proteinGrams: 26, carbsGrams: 74, fatGrams: 18, fiberGrams: 10, timeMinutes: 25, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Rice noodles with tofu, bean sprouts and peanuts.",
    ingredients: [
      { name: "firm tofu", quantity: "150 g" },
      { name: "rice noodles", quantity: "80 g dry" },
      { name: "bean sprouts", quantity: "80 g" },
      { name: "peanuts", quantity: "15 g" },
      { name: "tamarind sauce", quantity: "2 tbsp" },
    ],
    steps: ["Soak noodles; stir-fry tofu.", "Toss with noodles, sprouts and sauce; top with peanuts."],
  },
  {
    id: "d-harissa-salmon", name: "Harissa Salmon Traybake with Chickpeas", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "fish",
    calories: 600, proteinGrams: 42, carbsGrams: 44, fatGrams: 26, fiberGrams: 13, timeMinutes: 30, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Spicy harissa salmon roasted with chickpeas and peppers.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "chickpeas", quantity: "120 g" },
      { name: "bell pepper", quantity: "1" },
      { name: "harissa", quantity: "1 tbsp" },
    ],
    steps: ["Toss chickpeas and peppers with harissa; roast 15 min.", "Add salmon; roast 12 min more."],
  },
  {
    id: "d-chicken-veg-stirfry", name: "Chicken & Vegetable Stir-Fry with Rice", type: "dinner",
    cuisine: "asian", mainProtein: "chicken",
    calories: 560, proteinGrams: 46, carbsGrams: 56, fatGrams: 14, fiberGrams: 10, timeMinutes: 20, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Quick chicken stir-fry with mixed vegetables over rice.",
    ingredients: [
      { name: "chicken breast", quantity: "160 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "mixed stir-fry veg", quantity: "160 g" },
      { name: "soy-ginger sauce", quantity: "2 tbsp" },
    ],
    steps: ["Cook rice.", "Stir-fry chicken and veg with sauce; serve over rice."],
  },
  {
    id: "d-stuffed-portobello", name: "Stuffed Portobello with Quinoa & Feta", type: "dinner",
    cuisine: "mediterranean", mainProtein: "dairy",
    calories: 500, proteinGrams: 24, carbsGrams: 52, fatGrams: 20, fiberGrams: 12, timeMinutes: 30, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Roasted portobello caps stuffed with quinoa, spinach and feta.",
    ingredients: [
      { name: "portobello mushrooms", quantity: "2 large" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "spinach", quantity: "60 g" },
      { name: "feta", quantity: "40 g" },
    ],
    steps: ["Cook quinoa; mix with wilted spinach and feta.", "Fill mushrooms; roast at 200°C for 18 min."],
  },

  // ===== Batch 4 — curated, high-protein & high-fiber =====

  // ---- Breakfasts ----
  {
    id: "b-egg-bean-quesadilla", name: "Cheesy Egg & Black Bean Quesadilla", type: "breakfast",
    cuisine: "mexican", mainProtein: "eggs",
    calories: 430, proteinGrams: 27, carbsGrams: 44, fatGrams: 18, fiberGrams: 11, timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Griddled quesadilla with scrambled egg, beans and cheese.",
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "black beans", quantity: "80 g" },
      { name: "whole-wheat tortilla", quantity: "1" },
      { name: "cheddar", quantity: "30 g" },
    ],
    steps: ["Scramble eggs; mash beans.", "Fill tortilla with egg, beans and cheese; griddle until crisp."],
  },
  {
    id: "b-protein-french-toast", name: "Protein French Toast with Berries", type: "breakfast",
    cuisine: "american", mainProtein: "eggs",
    calories: 420, proteinGrams: 30, carbsGrams: 46, fatGrams: 12, fiberGrams: 7, timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Egg-and-protein soaked toast topped with berries.",
    ingredients: [
      { name: "whole-grain bread", quantity: "2 slices" },
      { name: "eggs", quantity: "2" },
      { name: "milk", quantity: "60 ml" },
      { name: "mixed berries", quantity: "80 g" },
    ],
    steps: ["Soak bread in egg-milk mix.", "Pan-fry until golden; top with berries."],
  },
  {
    id: "b-trout-bagel", name: "Smoked Trout & Cream Cheese Bagel", type: "breakfast",
    cuisine: "american", mainProtein: "fish",
    calories: 440, proteinGrams: 30, carbsGrams: 42, fatGrams: 18, fiberGrams: 6, timeMinutes: 8, approxCost: 3,
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
    calories: 400, proteinGrams: 24, carbsGrams: 40, fatGrams: 17, fiberGrams: 9, timeMinutes: 20, approxCost: 1,
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
    calories: 330, proteinGrams: 28, carbsGrams: 32, fatGrams: 8, fiberGrams: 6, timeMinutes: 5, approxCost: 2,
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
    calories: 360, proteinGrams: 22, carbsGrams: 22, fatGrams: 20, fiberGrams: 6, timeMinutes: 18, approxCost: 1,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Pan-fried zucchini and feta fritters bound with egg.",
    ingredients: [
      { name: "zucchini", quantity: "1" },
      { name: "eggs", quantity: "2" },
      { name: "feta", quantity: "40 g" },
      { name: "chickpea flour", quantity: "2 tbsp" },
    ],
    steps: ["Grate and squeeze zucchini; mix with egg, feta and flour.", "Fry spoonfuls until golden."],
  },
  {
    id: "b-ab-banana-toast", name: "Almond Butter & Banana Protein Toast", type: "breakfast",
    cuisine: "american", mainProtein: "dairy",
    calories: 400, proteinGrams: 24, carbsGrams: 46, fatGrams: 16, fiberGrams: 8, timeMinutes: 6, approxCost: 1,
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
    calories: 410, proteinGrams: 24, carbsGrams: 46, fatGrams: 15, fiberGrams: 12, timeMinutes: 15, approxCost: 1,
    dietTags: ["vegan", "vegetarian", "gluten_free"],
    description: "Spiced tofu crumble with beans in corn tortillas.",
    ingredients: [
      { name: "firm tofu", quantity: "140 g" },
      { name: "corn tortillas", quantity: "2" },
      { name: "black beans", quantity: "60 g" },
      { name: "smoked paprika", quantity: "1 tsp" },
    ],
    steps: ["Fry crumbled tofu with paprika and spices.", "Fill tortillas with tofu and beans."],
  },
  {
    id: "b-matcha-chia", name: "Matcha Chia Protein Pudding", type: "breakfast",
    cuisine: "asian", mainProtein: "dairy",
    calories: 350, proteinGrams: 26, carbsGrams: 34, fatGrams: 12, fiberGrams: 12, timeMinutes: 5, approxCost: 2,
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
    calories: 350, proteinGrams: 28, carbsGrams: 34, fatGrams: 10, fiberGrams: 8, timeMinutes: 12, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Fluffy egg whites with peppers and spinach in a wrap.",
    ingredients: [
      { name: "egg whites", quantity: "5" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "bell pepper", quantity: "1/2" },
      { name: "spinach", quantity: "40 g" },
    ],
    steps: ["Scramble egg whites with peppers and spinach.", "Fill the wrap and roll."],
  },
  {
    id: "b-ricotta-toast", name: "Ricotta & Honey Toast with Walnuts", type: "breakfast",
    cuisine: "italian", mainProtein: "dairy",
    calories: 380, proteinGrams: 20, carbsGrams: 40, fatGrams: 16, fiberGrams: 6, timeMinutes: 6, approxCost: 2,
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
    calories: 390, proteinGrams: 26, carbsGrams: 36, fatGrams: 16, fiberGrams: 9, timeMinutes: 12, approxCost: 2,
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
    calories: 410, proteinGrams: 22, carbsGrams: 54, fatGrams: 13, fiberGrams: 9, timeMinutes: 30, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Warm baked oats with apple, cinnamon and pecans.",
    ingredients: [
      { name: "rolled oats", quantity: "70 g" },
      { name: "milk", quantity: "200 ml" },
      { name: "egg", quantity: "1" },
      { name: "apple", quantity: "1" },
      { name: "pecans", quantity: "15 g" },
    ],
    steps: ["Mix oats, milk, egg and apple.", "Bake at 180°C for 25 min; top with pecans."],
  },
  {
    id: "b-lentil-egg-skillet", name: "Lentil & Egg Breakfast Skillet", type: "breakfast",
    cuisine: "middle_eastern", mainProtein: "eggs",
    calories: 420, proteinGrams: 26, carbsGrams: 40, fatGrams: 18, fiberGrams: 13, timeMinutes: 18, approxCost: 1,
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
    calories: 400, proteinGrams: 30, carbsGrams: 48, fatGrams: 10, fiberGrams: 7, timeMinutes: 15, approxCost: 1,
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
    calories: 560, proteinGrams: 46, carbsGrams: 52, fatGrams: 16, fiberGrams: 12, timeMinutes: 22, approxCost: 2,
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
    calories: 540, proteinGrams: 42, carbsGrams: 40, fatGrams: 22, fiberGrams: 14, timeMinutes: 20, approxCost: 3,
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
    calories: 580, proteinGrams: 46, carbsGrams: 58, fatGrams: 16, fiberGrams: 10, timeMinutes: 20, approxCost: 2,
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
    calories: 520, proteinGrams: 20, carbsGrams: 68, fatGrams: 16, fiberGrams: 16, timeMinutes: 25, approxCost: 1,
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
    calories: 520, proteinGrams: 44, carbsGrams: 22, fatGrams: 28, fiberGrams: 9, timeMinutes: 15, approxCost: 2,
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
    calories: 560, proteinGrams: 40, carbsGrams: 58, fatGrams: 18, fiberGrams: 9, timeMinutes: 12, approxCost: 2,
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
    calories: 480, proteinGrams: 42, carbsGrams: 44, fatGrams: 12, fiberGrams: 14, timeMinutes: 30, approxCost: 2,
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
    calories: 580, proteinGrams: 44, carbsGrams: 60, fatGrams: 16, fiberGrams: 9, timeMinutes: 25, approxCost: 2,
    dietTags: ["mediterranean"],
    description: "Lemon-oregano chicken over orzo with cucumber and feta.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "orzo", quantity: "70 g dry" },
      { name: "cucumber", quantity: "1/2" },
      { name: "feta", quantity: "30 g" },
    ],
    steps: ["Cook orzo; grill lemon-oregano chicken.", "Combine with cucumber and feta."],
  },
  {
    id: "l-smoky-bean-quinoa", name: "Smoky Black Bean & Corn Quinoa Salad", type: "lunch",
    cuisine: "mexican", mainProtein: "legumes",
    calories: 500, proteinGrams: 20, carbsGrams: 78, fatGrams: 12, fiberGrams: 17, timeMinutes: 15, approxCost: 1,
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
    calories: 520, proteinGrams: 34, carbsGrams: 66, fatGrams: 12, fiberGrams: 9, timeMinutes: 18, approxCost: 3,
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
    calories: 520, proteinGrams: 42, carbsGrams: 42, fatGrams: 18, fiberGrams: 9, timeMinutes: 8, approxCost: 3,
    dietTags: [],
    description: "Lean roast beef with horseradish and rocket in a wrap.",
    ingredients: [
      { name: "lean roast beef", quantity: "120 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "rocket", quantity: "40 g" },
      { name: "horseradish", quantity: "1 tsp" },
    ],
    steps: ["Spread horseradish on the wrap.", "Layer beef and rocket; roll and slice."],
  },
  {
    id: "l-halloumi-grain-bowl", name: "Halloumi & Chickpea Grain Bowl", type: "lunch",
    cuisine: "mediterranean", mainProtein: "dairy",
    calories: 560, proteinGrams: 28, carbsGrams: 56, fatGrams: 24, fiberGrams: 13, timeMinutes: 20, approxCost: 2,
    dietTags: ["vegetarian", "gluten_free"],
    description: "Grilled halloumi with chickpeas and roasted veg over grains.",
    ingredients: [
      { name: "halloumi", quantity: "80 g" },
      { name: "chickpeas", quantity: "100 g" },
      { name: "quinoa", quantity: "60 g dry" },
      { name: "roasted peppers", quantity: "80 g" },
    ],
    steps: ["Grill halloumi; warm chickpeas.", "Serve over quinoa with peppers."],
  },
  {
    id: "l-chicken-tikka-wrap", name: "Chicken Tikka Wrap with Yogurt Slaw", type: "lunch",
    cuisine: "indian", mainProtein: "chicken",
    calories: 540, proteinGrams: 44, carbsGrams: 48, fatGrams: 18, fiberGrams: 9, timeMinutes: 22, approxCost: 2,
    dietTags: [],
    description: "Tikka-spiced chicken with a yogurt slaw in a wrap.",
    ingredients: [
      { name: "chicken breast", quantity: "150 g" },
      { name: "whole-wheat wrap", quantity: "1" },
      { name: "cabbage", quantity: "60 g" },
      { name: "yogurt", quantity: "2 tbsp" },
      { name: "tikka spice", quantity: "1 tbsp" },
    ],
    steps: ["Sear tikka-spiced chicken.", "Fill wrap with chicken and yogurt slaw."],
  },
  {
    id: "l-lentil-feta-tabbouleh", name: "Lentil & Feta Tabbouleh", type: "lunch",
    cuisine: "mediterranean", mainProtein: "legumes",
    calories: 480, proteinGrams: 22, carbsGrams: 56, fatGrams: 16, fiberGrams: 15, timeMinutes: 15, approxCost: 1,
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
    calories: 500, proteinGrams: 40, carbsGrams: 42, fatGrams: 18, fiberGrams: 9, timeMinutes: 18, approxCost: 3,
    dietTags: [],
    description: "Ginger-soy beef in lettuce cups with a side of rice.",
    ingredients: [
      { name: "lean beef", quantity: "130 g" },
      { name: "lettuce", quantity: "6 leaves" },
      { name: "brown rice", quantity: "50 g dry" },
      { name: "ginger-soy sauce", quantity: "2 tbsp" },
    ],
    steps: ["Stir-fry beef with ginger-soy.", "Spoon into lettuce cups; serve with rice."],
  },
  {
    id: "l-mackerel-beetroot", name: "Smoked Mackerel & Beetroot Salad", type: "lunch",
    cuisine: "mediterranean", mainProtein: "fish",
    calories: 500, proteinGrams: 34, carbsGrams: 34, fatGrams: 26, fiberGrams: 10, timeMinutes: 10, approxCost: 2,
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
    calories: 560, proteinGrams: 48, carbsGrams: 48, fatGrams: 16, fiberGrams: 13, timeMinutes: 20, approxCost: 2,
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
    calories: 560, proteinGrams: 48, carbsGrams: 44, fatGrams: 18, fiberGrams: 10, timeMinutes: 30, approxCost: 2,
    dietTags: ["mediterranean", "gluten_free"],
    description: "Roast chicken with baby potatoes and green beans.",
    ingredients: [
      { name: "chicken breast", quantity: "180 g" },
      { name: "baby potatoes", quantity: "200 g" },
      { name: "green beans", quantity: "120 g" },
      { name: "lemon", quantity: "1/2" },
    ],
    steps: ["Roast potatoes 20 min.", "Add chicken and beans; roast 15 min with lemon."],
  },
  {
    id: "d-shrimp-zoodle-scampi", name: "Shrimp & Zucchini Noodle Scampi", type: "dinner",
    cuisine: "italian", mainProtein: "shrimp",
    calories: 480, proteinGrams: 38, carbsGrams: 30, fatGrams: 22, fiberGrams: 8, timeMinutes: 20, approxCost: 3,
    dietTags: ["keto", "gluten_free"],
    description: "Garlic-butter shrimp over zucchini noodles.",
    ingredients: [
      { name: "shrimp", quantity: "160 g" },
      { name: "zucchini", quantity: "2" },
      { name: "garlic", quantity: "3 cloves" },
      { name: "olive oil", quantity: "1 tbsp" },
    ],
    steps: ["Spiralize zucchini.", "Sauté shrimp with garlic; toss with zoodles."],
  },
  {
    id: "d-turkey-meatball-bowl", name: "Turkey & Spinach Meatball Bowl", type: "dinner",
    cuisine: "mediterranean", mainProtein: "turkey",
    calories: 580, proteinGrams: 46, carbsGrams: 52, fatGrams: 18, fiberGrams: 11, timeMinutes: 28, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Turkey-spinach meatballs over quinoa with tomato.",
    ingredients: [
      { name: "ground turkey", quantity: "150 g" },
      { name: "spinach", quantity: "50 g" },
      { name: "quinoa", quantity: "70 g dry" },
      { name: "tomato sauce", quantity: "120 g" },
    ],
    steps: ["Bake turkey-spinach meatballs 15 min.", "Simmer in sauce; serve over quinoa."],
  },
  {
    id: "d-black-bean-enchilada", name: "Black Bean Enchilada Bake", type: "dinner",
    cuisine: "mexican", mainProtein: "legumes",
    calories: 560, proteinGrams: 24, carbsGrams: 80, fatGrams: 16, fiberGrams: 18, timeMinutes: 35, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Baked enchiladas filled with black beans and cheese.",
    ingredients: [
      { name: "black beans", quantity: "150 g" },
      { name: "corn tortillas", quantity: "3" },
      { name: "enchilada sauce", quantity: "150 g" },
      { name: "cheddar", quantity: "40 g" },
    ],
    steps: ["Fill and roll tortillas with beans.", "Top with sauce and cheese; bake 20 min."],
  },
  {
    id: "d-ginger-tofu-bokchoy", name: "Ginger-Soy Baked Tofu with Bok Choy & Rice", type: "dinner",
    cuisine: "asian", mainProtein: "tofu",
    calories: 540, proteinGrams: 28, carbsGrams: 60, fatGrams: 18, fiberGrams: 11, timeMinutes: 30, approxCost: 2,
    dietTags: ["vegan", "vegetarian"],
    description: "Baked ginger-soy tofu with bok choy over rice.",
    ingredients: [
      { name: "firm tofu", quantity: "160 g" },
      { name: "bok choy", quantity: "120 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "ginger-soy sauce", quantity: "2 tbsp" },
    ],
    steps: ["Bake glazed tofu 22 min.", "Serve with steamed bok choy and rice."],
  },
  {
    id: "d-cajun-salmon", name: "Cajun Salmon with Dirty Rice & Beans", type: "dinner",
    cuisine: "american", mainProtein: "fish",
    calories: 620, proteinGrams: 44, carbsGrams: 58, fatGrams: 22, fiberGrams: 12, timeMinutes: 25, approxCost: 3,
    dietTags: ["gluten_free"],
    description: "Cajun-spiced salmon over rice with kidney beans.",
    ingredients: [
      { name: "salmon fillet", quantity: "150 g" },
      { name: "brown rice", quantity: "70 g dry" },
      { name: "kidney beans", quantity: "100 g" },
      { name: "cajun spice", quantity: "1 tbsp" },
    ],
    steps: ["Pan-sear cajun salmon.", "Stir beans through cooked rice; plate together."],
  },
  {
    id: "d-beef-kebabs-couscous", name: "Beef & Vegetable Kebabs with Couscous", type: "dinner",
    cuisine: "middle_eastern", mainProtein: "beef",
    calories: 600, proteinGrams: 44, carbsGrams: 52, fatGrams: 22, fiberGrams: 10, timeMinutes: 25, approxCost: 3,
    dietTags: [],
    description: "Grilled beef and pepper kebabs over couscous.",
    ingredients: [
      { name: "lean beef", quantity: "140 g" },
      { name: "bell peppers", quantity: "1" },
      { name: "red onion", quantity: "1/2" },
      { name: "couscous", quantity: "60 g dry" },
    ],
    steps: ["Thread beef and veg; grill.", "Serve over fluffed couscous."],
  },
  {
    id: "d-chicken-tikka-masala", name: "Chicken Tikka Masala with Brown Rice", type: "dinner",
    cuisine: "indian", mainProtein: "chicken",
    calories: 620, proteinGrams: 46, carbsGrams: 60, fatGrams: 20, fiberGrams: 9, timeMinutes: 30, approxCost: 2,
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
    calories: 500, proteinGrams: 42, carbsGrams: 44, fatGrams: 14, fiberGrams: 15, timeMinutes: 25, approxCost: 3,
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
    calories: 600, proteinGrams: 30, carbsGrams: 66, fatGrams: 24, fiberGrams: 12, timeMinutes: 22, approxCost: 2,
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
    calories: 560, proteinGrams: 42, carbsGrams: 58, fatGrams: 16, fiberGrams: 15, timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "Baked sweet potato loaded with lean turkey chili.",
    ingredients: [
      { name: "sweet potato", quantity: "1 large" },
      { name: "ground turkey", quantity: "130 g" },
      { name: "kidney beans", quantity: "80 g" },
      { name: "chopped tomatoes", quantity: "1/2 can" },
    ],
    steps: ["Bake sweet potato until soft.", "Simmer turkey chili; spoon over the split potato."],
  },
  {
    id: "d-pesto-chicken-penne", name: "Pesto Chicken with Whole-Wheat Penne & Peas", type: "dinner",
    cuisine: "italian", mainProtein: "chicken",
    calories: 620, proteinGrams: 48, carbsGrams: 60, fatGrams: 20, fiberGrams: 11, timeMinutes: 25, approxCost: 2,
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
    calories: 560, proteinGrams: 22, carbsGrams: 74, fatGrams: 18, fiberGrams: 18, timeMinutes: 30, approxCost: 1,
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
    calories: 540, proteinGrams: 40, carbsGrams: 50, fatGrams: 18, fiberGrams: 11, timeMinutes: 25, approxCost: 3,
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
    calories: 620, proteinGrams: 40, carbsGrams: 48, fatGrams: 28, fiberGrams: 14, timeMinutes: 35, approxCost: 2,
    dietTags: ["gluten_free"],
    description: "One-tray lean pork sausage with peppers and white beans.",
    ingredients: [
      { name: "lean pork sausage", quantity: "140 g" },
      { name: "cannellini beans", quantity: "150 g" },
      { name: "bell peppers", quantity: "2" },
      { name: "red onion", quantity: "1" },
    ],
    steps: ["Toss sausage, peppers and onion on a tray; roast 25 min.", "Stir in beans; roast 8 min more."],
  },

  // ---- Snacks ----
  {
    id: "s-roasted-chickpeas", name: "Crunchy Roasted Chickpeas", type: "snack",
    cuisine: "mediterranean", mainProtein: "legumes",
    calories: 200, proteinGrams: 11, carbsGrams: 28, fatGrams: 6, fiberGrams: 8, timeMinutes: 5, approxCost: 1,
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
    calories: 180, proteinGrams: 22, carbsGrams: 8, fatGrams: 7, fiberGrams: 4, timeMinutes: 5, approxCost: 2,
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
    calories: 220, proteinGrams: 14, carbsGrams: 22, fatGrams: 10, fiberGrams: 5, timeMinutes: 8, approxCost: 1,
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
    calories: 300, proteinGrams: 15, carbsGrams: 6, fatGrams: 25, fiberGrams: 6, timeMinutes: 10, approxCost: 1,
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
    calories: 300, proteinGrams: 14, carbsGrams: 5, fatGrams: 26, fiberGrams: 3, timeMinutes: 2, approxCost: 2,
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
    calories: 780, proteinGrams: 32, carbsGrams: 82, fatGrams: 34, fiberGrams: 4, timeMinutes: 20, approxCost: 2,
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
    calories: 850, proteinGrams: 40, carbsGrams: 70, fatGrams: 44, fiberGrams: 5, timeMinutes: 25, approxCost: 2,
    dietTags: [],
    description: "Beef patty, melted cheddar, soft bun and oven fries.",
    ingredients: [
      { name: "lean ground beef", quantity: "150 g" },
      { name: "burger bun", quantity: "1" },
      { name: "cheddar", quantity: "30 g" },
      { name: "baby potatoes", quantity: "200 g" },
    ],
    steps: ["Roast the potato fries 20 min.", "Sear the patty 3 min a side; melt cheddar on top.", "Build the burger."],
  },
  {
    id: "t-mac-cheese", name: "Baked Mac and Cheese", type: "dinner",
    cuisine: "american", mainProtein: "dairy", treatOnly: true,
    calories: 720, proteinGrams: 28, carbsGrams: 78, fatGrams: 32, fiberGrams: 4, timeMinutes: 30, approxCost: 1,
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
    calories: 760, proteinGrams: 45, carbsGrams: 48, fatGrams: 42, fiberGrams: 3, timeMinutes: 30, approxCost: 2,
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
    calories: 700, proteinGrams: 24, carbsGrams: 68, fatGrams: 36, fiberGrams: 9, timeMinutes: 15, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Tortilla chips buried under cheddar, beans and salsa.",
    ingredients: [
      { name: "corn tortillas", quantity: "4 pieces" },
      { name: "cheddar", quantity: "60 g" },
      { name: "black beans", quantity: "100 g" },
      { name: "salsa", quantity: "60 g" },
    ],
    steps: ["Cut and bake the tortillas into chips.", "Layer with beans and cheddar; bake until melted.", "Spoon over salsa."],
  },
  {
    id: "t-ice-cream", name: "Chocolate Ice Cream Sundae", type: "snack",
    cuisine: "american", mainProtein: "dairy", treatOnly: true,
    calories: 420, proteinGrams: 7, carbsGrams: 52, fatGrams: 20, fiberGrams: 2, timeMinutes: 3, approxCost: 1,
    dietTags: ["vegetarian"],
    description: "Ice cream, chocolate sauce, done.",
    ingredients: [
      { name: "ice cream", quantity: "150 g" },
      { name: "cocoa", quantity: "1 tbsp" },
      { name: "peanuts", quantity: "15 g" },
    ],
    steps: ["Scoop the ice cream.", "Dust with cocoa and scatter peanuts."],
  },
];

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
// totals hit the macro targets. `lockedType` (the meal the user just asked to swap
// in) keeps its chosen portion; the OTHER meals absorb the difference. Only meals
// traceable to a library recipe are rescaled; anything else is left untouched.
function scaleToTargets(meals: Meal[], profile: UserProfile, lockedType?: Recipe["type"]): Meal[] {
  const target = dayTargetMacros(profile);
  const adj = meals
    .map((m) => ({ m, base: baseRecipeOf(m) }))
    .filter((x): x is { m: Meal; base: Recipe } => !!x.base && x.m.type !== lockedType)
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

const dayProtein = (meals: Meal[]) => meals.reduce((s, m) => s + m.proteinGrams, 0);
const PROTEIN_SLACK = 8; // g/day we'll tolerate before reaching for lever 2

// Re-solve one day onto the macro targets. Two levers, in order — exactly what a
// nutritionist does:
//  1) SCALE the meals' portions to hold calories + macros.
//  2) if the day is still protein-short (scaling can't raise protein at fixed
//     calories), UPGRADE the weakest eligible meal to a higher-protein same-type
//     recipe to "make room" — then scale again.
// `lockedType` protects the meal the user just swapped in (never rescaled/upgraded).
// `avoidNames` are dishes used elsewhere in the week, so an upgrade doesn't create a
// cross-day repeat.
function rebalanceDay(
  meals: Meal[],
  profile: UserProfile,
  lockedType?: Recipe["type"],
  avoidNames?: Set<string>,
): Meal[] {
  let work = meals;
  const split = localSplit(profile.mealsPerDay);
  const cap = budgetCap(profile.budget);
  const tokens = exclusionTokens(profile);
  // At most two upgrades so we change as few meals as needed.
  for (let pass = 0; pass < 2; pass++) {
    const scaled = scaleToTargets(work, profile, lockedType);
    const gap = profile.proteinGrams - dayProtein(scaled);
    if (gap <= PROTEIN_SLACK) {
      work = scaled;
      break;
    }
    let best: { i: number; r: Recipe; calTarget: number; gap: number } | null = null;
    for (let i = 0; i < work.length; i++) {
      const cur = work[i];
      if (cur.type === lockedType || !baseRecipeOf(cur)) continue;
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
        const trialGap = Math.abs(profile.proteinGrams - dayProtein(scaleToTargets(trial, profile, lockedType)));
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
  return scaleToTargets(work, profile, lockedType);
}

// Re-solve every day of a week onto the macro targets. Used for the initial plan
// and after a week/profile change so the plan the user sees respects their macros
// from the start. Threads a running set of used dish names so a protein upgrade on
// one day never introduces a dish already on another day.
export const rebalanceWeek = (plan: WeekPlan, profile: UserProfile): WeekPlan => {
  const used = new Set(plan.days.flatMap((d) => d.meals.map((m) => m.name.toLowerCase())));
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

// Dish names used on days OTHER than `day` — so a single-day rebalance/upgrade
// doesn't introduce a dish already on the plate elsewhere in the week.
function namesOnOtherDays(plan: WeekPlan, day: DayPlan["day"]): Set<string> {
  return new Set(
    plan.days.filter((d) => d.day !== day).flatMap((d) => d.meals.map((m) => m.name.toLowerCase())),
  );
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
): { plan: WeekPlan; profile: UserProfile; notes: string[] } {
  const p: UserProfile = { ...profile };
  let curPlan = plan;
  let profileChanged = false;
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
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
          if (keepMacros(op)) notes.push(achievementNote("Your week now averages", weekAverages(curPlan), p));
          if (op.boostNutrient) notes.push(microNote(curPlan, op.boostNutrient));
        }
        break;
      }
      case "regenerate_week": {
        {
          const rep = newReport();
          const built = selectWeekFromDb(p, normalizeCuisine(op.cuisine ?? null), fiberOn(op), op.useIngredients, op.boostNutrient ?? undefined, rep);
          curPlan = keepMacros(op) ? rebalanceWeek(built, p) : built;
          notes.push(...reportNotes(rep, p));
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
          ? rebalanceDay(newDay.meals, tp, undefined, namesOnOtherDays(curPlan, op.day))
          : newDay.meals;
        curPlan = { ...curPlan, days: curPlan.days.map((d) => (d.day === op.day ? { ...newDay, meals } : d)) };
        if (keepMacros(op)) notes.push(achievementNote(`${op.day} now has`, dayTotals({ ...newDay, meals }), tp));
        break;
      }
      case "swap_meal": {
        if (!op.day || !op.dish) break;
        // Macro-aware pick: matches the requested dish, tie-broken toward the slot's
        // macro profile (e.g. the protein-forward pancake on a high-protein plan).
        const match = findRecipeForSwap(op.dish, op.mealType ?? undefined, p);
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
          ? rebalanceDay(swapped, p, match.type, namesOnOtherDays(curPlan, op.day))
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
      case "answer":
        break;
    }
  }

  return { plan: curPlan, profile: profileChanged ? p : profile, notes };
}
