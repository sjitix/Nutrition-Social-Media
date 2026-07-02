import { DAYS, type Meal, type UserProfile, type WeekPlan } from "./types";

// Demo mode: used when no ANTHROPIC_API_KEY is configured, so the app can be
// demoed end-to-end without AI costs. Meals rotate from a small pool.

const BREAKFASTS: Meal[] = [
  {
    name: "Greek Yogurt Bowl",
    type: "breakfast",
    description: "Creamy yogurt with honey, berries and crunchy granola.",
    calories: 380,
    proteinGrams: 22,
    carbsGrams: 48,
    fatGrams: 10,
    ingredients: [
      { name: "Greek yogurt", quantity: "200 g" },
      { name: "Granola", quantity: "40 g" },
      { name: "Mixed berries", quantity: "100 g" },
      { name: "Honey", quantity: "1 tsp" },
    ],
    steps: [
      "Spoon the yogurt into a bowl.",
      "Top with granola and berries.",
      "Drizzle with honey and serve.",
    ],
  },
  {
    name: "Veggie Omelette & Toast",
    type: "breakfast",
    description: "Fluffy three-egg omelette with peppers and spinach.",
    calories: 420,
    proteinGrams: 27,
    carbsGrams: 30,
    fatGrams: 20,
    ingredients: [
      { name: "Eggs", quantity: "3 pieces" },
      { name: "Bell pepper", quantity: "1/2 piece" },
      { name: "Spinach", quantity: "50 g" },
      { name: "Whole-grain bread", quantity: "1 slice" },
      { name: "Olive oil", quantity: "1 tsp" },
    ],
    steps: [
      "Whisk the eggs with a pinch of salt.",
      "Saute pepper and spinach in olive oil for 2 minutes.",
      "Pour in eggs, cook until set, fold and serve with toast.",
    ],
  },
  {
    name: "Banana Oatmeal",
    type: "breakfast",
    description: "Warm oats with banana, cinnamon and peanut butter.",
    calories: 410,
    proteinGrams: 14,
    carbsGrams: 62,
    fatGrams: 12,
    ingredients: [
      { name: "Rolled oats", quantity: "60 g" },
      { name: "Milk", quantity: "250 ml" },
      { name: "Banana", quantity: "1 piece" },
      { name: "Peanut butter", quantity: "1 tbsp" },
      { name: "Cinnamon", quantity: "1 pinch" },
    ],
    steps: [
      "Simmer oats in milk for 5 minutes.",
      "Slice the banana on top.",
      "Finish with peanut butter and cinnamon.",
    ],
  },
];

const LUNCHES: Meal[] = [
  {
    name: "Chicken Rice Bowl",
    type: "lunch",
    description: "Grilled chicken over rice with roasted vegetables.",
    calories: 560,
    proteinGrams: 42,
    carbsGrams: 60,
    fatGrams: 14,
    ingredients: [
      { name: "Chicken breast", quantity: "150 g" },
      { name: "Rice", quantity: "80 g dry" },
      { name: "Zucchini", quantity: "1/2 piece" },
      { name: "Carrot", quantity: "1 piece" },
      { name: "Olive oil", quantity: "1 tbsp" },
    ],
    steps: [
      "Cook the rice according to the package.",
      "Season and grill the chicken 5-6 minutes per side.",
      "Roast the chopped vegetables with olive oil, assemble the bowl.",
    ],
  },
  {
    name: "Tuna Pasta Salad",
    type: "lunch",
    description: "Cold pasta with tuna, corn, and a lemon-yogurt dressing.",
    calories: 520,
    proteinGrams: 34,
    carbsGrams: 65,
    fatGrams: 12,
    ingredients: [
      { name: "Pasta", quantity: "80 g dry" },
      { name: "Canned tuna", quantity: "1 can" },
      { name: "Corn", quantity: "80 g" },
      { name: "Greek yogurt", quantity: "2 tbsp" },
      { name: "Lemon", quantity: "1/2 piece" },
    ],
    steps: [
      "Cook and cool the pasta.",
      "Mix yogurt with lemon juice, salt and pepper.",
      "Toss pasta with tuna, corn and the dressing.",
    ],
  },
  {
    name: "Lentil Soup & Bread",
    type: "lunch",
    description: "Hearty red lentil soup with carrots and cumin.",
    calories: 480,
    proteinGrams: 24,
    carbsGrams: 70,
    fatGrams: 10,
    ingredients: [
      { name: "Red lentils", quantity: "100 g" },
      { name: "Carrot", quantity: "1 piece" },
      { name: "Onion", quantity: "1 piece" },
      { name: "Cumin", quantity: "1 tsp" },
      { name: "Whole-grain bread", quantity: "2 slices" },
    ],
    steps: [
      "Saute chopped onion and carrot for 3 minutes.",
      "Add lentils, cumin and 700 ml water; simmer 20 minutes.",
      "Blend lightly, season, and serve with bread.",
    ],
  },
];

const DINNERS: Meal[] = [
  {
    name: "Baked Salmon & Potatoes",
    type: "dinner",
    description: "Oven-baked salmon fillet with baby potatoes and broccoli.",
    calories: 590,
    proteinGrams: 38,
    carbsGrams: 45,
    fatGrams: 26,
    ingredients: [
      { name: "Salmon fillet", quantity: "150 g" },
      { name: "Baby potatoes", quantity: "250 g" },
      { name: "Broccoli", quantity: "150 g" },
      { name: "Olive oil", quantity: "1 tbsp" },
      { name: "Lemon", quantity: "1/2 piece" },
    ],
    steps: [
      "Roast potatoes at 200°C for 25 minutes.",
      "Add salmon and broccoli for the last 12 minutes.",
      "Finish with lemon juice.",
    ],
  },
  {
    name: "Turkey Stir-Fry",
    type: "dinner",
    description: "Quick turkey and vegetable stir-fry with soy and ginger.",
    calories: 510,
    proteinGrams: 40,
    carbsGrams: 50,
    fatGrams: 14,
    ingredients: [
      { name: "Turkey breast", quantity: "150 g" },
      { name: "Rice", quantity: "70 g dry" },
      { name: "Bell pepper", quantity: "1 piece" },
      { name: "Soy sauce", quantity: "2 tbsp" },
      { name: "Ginger", quantity: "1 tsp" },
    ],
    steps: [
      "Cook the rice.",
      "Stir-fry sliced turkey on high heat for 4 minutes.",
      "Add vegetables, soy and ginger; cook 3 more minutes and serve over rice.",
    ],
  },
  {
    name: "Veggie Chili",
    type: "dinner",
    description: "Smoky bean chili with tomatoes, served with rice.",
    calories: 540,
    proteinGrams: 22,
    carbsGrams: 82,
    fatGrams: 12,
    ingredients: [
      { name: "Kidney beans", quantity: "1 can" },
      { name: "Chopped tomatoes", quantity: "1 can" },
      { name: "Onion", quantity: "1 piece" },
      { name: "Rice", quantity: "70 g dry" },
      { name: "Smoked paprika", quantity: "1 tsp" },
    ],
    steps: [
      "Saute the onion, add paprika.",
      "Add beans and tomatoes; simmer 15 minutes.",
      "Serve over rice.",
    ],
  },
];

const SNACKS: Meal[] = [
  {
    name: "Apple & Almonds",
    type: "snack",
    description: "Crisp apple with a handful of almonds.",
    calories: 220,
    proteinGrams: 6,
    carbsGrams: 26,
    fatGrams: 11,
    ingredients: [
      { name: "Apple", quantity: "1 piece" },
      { name: "Almonds", quantity: "25 g" },
    ],
    steps: ["Slice the apple and enjoy with the almonds."],
  },
  {
    name: "Cottage Cheese & Crackers",
    type: "snack",
    description: "Protein-rich cottage cheese on whole-grain crackers.",
    calories: 210,
    proteinGrams: 16,
    carbsGrams: 22,
    fatGrams: 6,
    ingredients: [
      { name: "Cottage cheese", quantity: "100 g" },
      { name: "Whole-grain crackers", quantity: "4 pieces" },
    ],
    steps: ["Spread the cottage cheese on the crackers."],
  },
];

export function buildDemoPlan(profile: UserProfile): WeekPlan {
  const days = DAYS.map((day, i) => {
    const meals: Meal[] = [
      BREAKFASTS[i % BREAKFASTS.length],
      LUNCHES[i % LUNCHES.length],
      DINNERS[i % DINNERS.length],
    ];
    if (profile.mealsPerDay === 4) {
      meals.push(SNACKS[i % SNACKS.length]);
    }
    return { day, meals };
  });
  return {
    days,
    weekSummary:
      "This is a sample plan (demo mode — add your Anthropic API key to unlock real AI planning). Balanced meals around 1,500-1,800 kcal per day with affordable, repeating ingredients.",
  };
}

export const DEMO_ASSISTANT_REPLY =
  "I'm running in demo mode right now, so I can't edit your plan yet. Add an ANTHROPIC_API_KEY to .env.local and restart the app to unlock the real AI assistant.";
