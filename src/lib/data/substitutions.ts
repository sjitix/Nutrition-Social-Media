/**
 * "I don't have Greek yogurt — what can I use?"
 *
 * Two halves, deliberately:
 *
 *  - WHICH swaps are sane is CURATED. Macro similarity alone would happily propose lentils for
 *    chicken breast (close on protein per calorie, absurd on the plate) or egg white for cod.
 *    Cooking sense doesn't fall out of a nutrient table, so the candidate lists are hand-written
 *    and grouped by culinary role.
 *  - WHAT the swap costs is COMPUTED, from the same USDA table as everything else. No entry here
 *    states a calorie or a gram; the engine reads those from NUTRIENT_TABLE at the portion the
 *    recipe actually calls for.
 *
 * Candidates are ordered best-first. Every name on both sides must exist in NUTRIENT_TABLE —
 * a test enforces that, so a typo can never silently drop a substitution.
 */
export const SUBSTITUTES: Record<string, string[]> = {
  // dairy + protein
  "greek yogurt": ["cottage cheese", "yogurt", "ricotta"],
  yogurt: ["greek yogurt", "cottage cheese", "milk"],
  "cottage cheese": ["greek yogurt", "ricotta", "yogurt"],
  ricotta: ["cottage cheese", "greek yogurt", "cream cheese"],
  "cream cheese": ["light cream cheese", "ricotta", "greek yogurt"],
  milk: ["yogurt", "greek yogurt"],
  feta: ["goat cheese", "halloumi", "mozzarella"],
  "goat cheese": ["feta", "ricotta", "mozzarella"],
  halloumi: ["feta", "firm tofu", "mozzarella"],
  mozzarella: ["cheddar", "feta", "halloumi"],
  cheddar: ["mozzarella", "parmesan", "feta"],
  parmesan: ["cheddar", "mozzarella"],

  // poultry / meat / fish — swap within cooking role, not just macros
  "chicken breast": ["turkey breast", "chicken thigh", "pork tenderloin", "firm tofu"],
  "chicken thigh": ["chicken breast", "turkey breast", "pork tenderloin"],
  "turkey breast": ["chicken breast", "chicken thigh"],
  "ground turkey": ["lean ground beef", "chicken breast", "tempeh"],
  "lean ground beef": ["ground turkey", "lean beef", "tempeh"],
  "lean beef": ["lean steak", "beef strips", "pork tenderloin"],
  "lean steak": ["lean beef", "beef strips", "chicken breast"],
  "beef strips": ["chicken breast", "lean steak", "firm tofu"],
  "pork tenderloin": ["chicken breast", "turkey breast", "lean beef"],
  "salmon fillet": ["smoked trout", "smoked mackerel", "cod fillet"],
  "cod fillet": ["salmon fillet", "shrimp", "canned tuna"],
  "canned tuna": ["cod fillet", "shrimp", "chicken breast"],
  "smoked salmon": ["smoked trout", "smoked mackerel"],
  "smoked mackerel": ["smoked trout", "smoked salmon", "salmon fillet"],
  "smoked trout": ["smoked salmon", "smoked mackerel"],
  shrimp: ["prawns", "cod fillet", "canned tuna"],
  prawns: ["shrimp", "cod fillet"],

  // plant protein
  "firm tofu": ["tempeh", "chickpeas", "edamame"],
  tempeh: ["firm tofu", "chickpeas", "edamame"],
  chickpeas: ["cannellini beans", "black beans", "lentils"],
  "black beans": ["kidney beans", "chickpeas", "cannellini beans"],
  "kidney beans": ["black beans", "cannellini beans", "chickpeas"],
  "cannellini beans": ["chickpeas", "kidney beans", "black beans"],
  lentils: ["green lentils", "red lentils", "chickpeas"],
  "green lentils": ["lentils", "red lentils", "chickpeas"],
  "red lentils": ["green lentils", "lentils", "chickpeas"],
  edamame: ["peas", "chickpeas", "firm tofu"],
  eggs: ["egg whites", "firm tofu"],
  "egg whites": ["eggs", "firm tofu"],

  // grains + starch
  quinoa: ["bulgur", "couscous", "brown rice"],
  "brown rice": ["quinoa", "bulgur", "rice"],
  rice: ["brown rice", "quinoa", "couscous"],
  bulgur: ["quinoa", "couscous", "brown rice"],
  couscous: ["bulgur", "quinoa", "orzo"],
  "rolled oats": ["muesli", "quinoa"],
  "whole-wheat pasta": ["whole-wheat penne", "whole-wheat spaghetti", "orzo"],
  "whole-wheat penne": ["whole-wheat pasta", "whole-wheat spaghetti"],
  "whole-wheat spaghetti": ["whole-wheat pasta", "soba noodles"],
  "soba noodles": ["rice noodles", "whole-wheat spaghetti", "egg noodles"],
  "rice noodles": ["soba noodles", "egg noodles"],
  "egg noodles": ["soba noodles", "rice noodles"],
  "sweet potato": ["baby potatoes", "carrot"],
  "baby potatoes": ["sweet potato"],

  // fats, nuts, seeds
  "olive oil": ["sesame oil"],
  "sesame oil": ["olive oil"],
  butter: ["olive oil"],
  "peanut butter": ["almond butter", "tahini"],
  "almond butter": ["peanut butter", "tahini"],
  tahini: ["almond butter", "peanut butter"],
  almonds: ["walnuts", "pecans", "peanuts"],
  walnuts: ["pecans", "almonds", "peanuts"],
  pecans: ["walnuts", "almonds"],
  peanuts: ["almonds", "walnuts"],
  "chia seeds": ["sesame seeds", "pumpkin seeds"],
  "pumpkin seeds": ["sesame seeds", "chia seeds"],
  "sesame seeds": ["pumpkin seeds", "chia seeds"],
  avocado: ["olives", "olive oil"],

  // vegetables
  spinach: ["kale", "rocket", "mixed greens"],
  kale: ["spinach", "cabbage", "mixed greens"],
  rocket: ["mixed greens", "spinach", "romaine"],
  romaine: ["lettuce", "mixed greens", "rocket"],
  lettuce: ["romaine", "mixed greens"],
  "mixed greens": ["spinach", "rocket", "romaine"],
  broccoli: ["cauliflower", "green beans", "asparagus"],
  cauliflower: ["broccoli", "cabbage"],
  "bok choy": ["pak choi", "cabbage", "spinach"],
  "pak choi": ["bok choy", "cabbage"],
  asparagus: ["green beans", "broccoli"],
  "green beans": ["asparagus", "broccoli", "peas"],
  zucchini: ["eggplant", "bell pepper"],
  eggplant: ["zucchini", "portobello mushrooms"],
  mushrooms: ["portobello mushrooms", "eggplant"],
  "portobello mushrooms": ["mushrooms", "eggplant"],
  "bell pepper": ["bell peppers", "roasted peppers", "zucchini"],
  "cherry tomatoes": ["tomatoes"],
  tomatoes: ["cherry tomatoes", "chopped tomatoes"],
  "chopped tomatoes": ["tomatoes", "tomato sauce"],
  onion: ["red onion"],
  "red onion": ["onion"],
  carrot: ["sweet potato", "bell pepper"],
  cabbage: ["kale", "cauliflower", "bok choy"],

  // fruit
  banana: ["apple", "mango"],
  apple: ["banana", "berries"],
  berries: ["mixed berries", "blueberries", "raspberries"],
  blueberries: ["raspberries", "mixed berries", "berries"],
  raspberries: ["blueberries", "mixed berries"],
  "mixed berries": ["frozen berries", "berries", "blueberries"],
  "frozen berries": ["mixed berries", "berries"],

  // bread + wraps
  "sourdough bread": ["whole-grain bread", "rye bread"],
  "whole-grain bread": ["sourdough bread", "rye bread"],
  "rye bread": ["whole-grain bread", "sourdough bread"],
  "whole-grain toast": ["whole-grain bread", "sourdough bread"],
  tortillas: ["corn tortillas", "whole-wheat tortilla", "whole-wheat wrap"],
  "corn tortillas": ["tortillas", "whole-wheat tortilla"],
  "whole-wheat tortilla": ["whole-wheat wrap", "tortillas", "corn tortillas"],
  "whole-wheat wrap": ["whole-wheat tortilla", "tortillas"],

  // pantry
  "soy sauce": ["teriyaki sauce", "miso paste"],
  hummus: ["tahini", "chickpeas"],
};

/** Spellings and everyday names that aren't the table's key. */
export const INGREDIENT_ALIASES: Record<string, string> = {
  yoghurt: "yogurt",
  "greek yoghurt": "greek yogurt",
  "natural yoghurt": "yogurt",
  aubergine: "eggplant",
  courgette: "zucchini",
  coriander: "parsley",
  scallions: "onion",
  "spring onion": "onion",
  "spring onions": "onion",
  "peppers": "bell pepper",
  "capsicum": "bell pepper",
  "garbanzo beans": "chickpeas",
  "white beans": "cannellini beans",
  "cheddar cheese": "cheddar",
  "parmesan cheese": "parmesan",
  "tuna": "canned tuna",
  "salmon": "salmon fillet",
  "cod": "cod fillet",
  "oats": "rolled oats",
  "porridge oats": "rolled oats",
  "pasta": "whole-wheat pasta",
  "spaghetti": "whole-wheat spaghetti",
  "potatoes": "baby potatoes",
  "sweet potatoes": "sweet potato",
  "tofu": "firm tofu",
};
