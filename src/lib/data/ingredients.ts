/**
 * Which curated ingredient is this? — the ONE rule, for every lookup (V1 D5,
 * docs/v1/06-ingredient-identity.md).
 *
 * Seven places used to answer it on their own, all with `name.trim().toLowerCase()` as the key into
 * the USDA and unit tables. This is that rule, made explicit and shared, plus the new primary path:
 * a recipe that comes from the library carries its ingredient's permanent SLUG, and a slug resolves
 * to itself. A name only matters for meals that did not come from the library — an imported recipe,
 * a logged "burger and chips" — and for those the old rule still applies, unchanged.
 */
import { INGREDIENTS, INGREDIENT_SLUGS, type IngredientSlug } from "./ingredients.generated";

export { INGREDIENT_SLUGS, INGREDIENTS, type IngredientSlug };

const SLUG_SET = new Set<string>(INGREDIENT_SLUGS);
/** The curated name -> its slug. Curated names are lowercase, which is exactly today's lookup key. */
const BY_NAME = new Map<string, IngredientSlug>(
  (Object.entries(INGREDIENTS) as [IngredientSlug, { name: string }][]).map(([slug, v]) => [v.name, slug]),
);

/** The curated ingredient a slug or a written name refers to, or null when it is not one we know. */
export function resolveIngredient(nameOrSlug: string): IngredientSlug | null {
  const s = nameOrSlug.trim();
  if (SLUG_SET.has(s)) return s as IngredientSlug;
  return BY_NAME.get(s.toLowerCase()) ?? null;
}

/** The curated name of a slug — today still the key the USDA and unit tables are indexed by. */
export const ingredientName = (slug: IngredientSlug): string => INGREDIENTS[slug].name;
