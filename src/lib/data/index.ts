// data — the recipe seeds, ingredient identity, the USDA table and the curated tables. Server only.
// V1 D5a part 3 (2026-10-03). Only what someone outside this folder uses is here; everything else in
// the folder is private, and check:boundaries fails an import that reaches past this file.
export { SEED_RECIPES, type Recipe, type RecipeSeed, type Cuisine, type DietTag, type MainProtein } from "./seeds";
export { INGREDIENTS, INGREDIENT_SLUGS, resolveIngredient, ingredientName, tableKey, type IngredientSlug } from "./ingredients";
export { NUTRIENT_TABLE, type Per100g } from "./nutrientTable.generated";
export { SUBSTITUTES, INGREDIENT_ALIASES } from "./substitutions";
export { SYMPTOMS, CRISIS_FLAGS, URGENT_FLAGS, PHRASE_NOISE } from "./symptoms";
export { conditionBoosts } from "./conditions";
