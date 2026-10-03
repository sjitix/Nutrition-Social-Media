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

/**
 * The key to look an ingredient up by in the USDA and unit tables — THE rule every nutrition lookup
 * uses (D5 step 4).
 *
 * NAME FIRST, slug as the fallback. The first version tried the slug first, and an adversarial review
 * (2026-10-03) showed why that is wrong: a slug can arrive from outside — a model generating a plan
 * (the plan schema now carries the field), an imported or synced file — and a slug that disagrees
 * with the name would then decide the nutrition while the allergen check, which reads the name, saw a
 * different food. With the name first, a supplied slug can never contradict what the user sees and
 * what the allergen matcher reads. Nothing is lost for the library: every recipe's name resolves to
 * its own slug (check:ingredients asserts they agree), and the slug still carries a recipe the day a
 * curated name is renamed and the old display name stops resolving — the rename-safety D5 is for.
 * An ingredient we do not curate (an imported recipe's "za'atar") keeps today's trim-lowercase name,
 * which misses the tables and lowers coverage, exactly as before. A slug that is not a string (bad
 * imported data) is ignored rather than crashing every report that reads micronutrients.
 */
export function tableKey(ing: { name: string; slug?: unknown }): string {
  const name = typeof ing.name === "string" ? ing.name : "";
  const s = resolveIngredient(name) ?? (typeof ing.slug === "string" ? resolveIngredient(ing.slug) : null);
  return s ? INGREDIENTS[s].name : name.trim().toLowerCase();
}
