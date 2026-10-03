/**
 * Group a grocery list by supermarket aisle, so shopping is one walk through the store instead of
 * criss-crossing it. Pure and keyword-based — best-effort, but it gets the common items right, and
 * anything unmatched lands in "Other" rather than being lost.
 */
export type Aisle =
  | "Produce"
  | "Meat & Fish"
  | "Dairy & Eggs"
  | "Bakery"
  | "Frozen"
  | "Pantry"
  | "Other";

// The order to show aisles in — roughly a sensible path through a shop (fresh first, frozen last).
export const AISLE_ORDER: Aisle[] = [
  "Produce",
  "Meat & Fish",
  "Dairy & Eggs",
  "Bakery",
  "Pantry",
  "Frozen",
  "Other",
];

// First rule that matches wins, so ORDER MATTERS: more specific / higher-confidence rules first.
// Word boundaries (\b) matter — "eggplant" must not read as "egg" (dairy); "peppercorn" must not
// read as a bell "pepper" (produce).
const RULES: [Aisle, RegExp][] = [
  ["Frozen", /\bfrozen\b|ice cream/i],
  // Compounds that would otherwise be captured by a broader rule below and filed in the WRONG aisle:
  // "peanut butter" isn't dairy butter, plant milks aren't dairy milk, "chicken stock" isn't meat,
  // "egg noodles" aren't eggs. Pin them to Pantry first. Same idea for spice/produce collisions.
  ["Pantry", /\b(peanut|almond|cashew|sunflower) butter\b|\b(coconut|almond|oat|soy|rice|cashew) milk\b|\b(chicken|beef|vegetable|fish|bone) (stock|broth)\b|\begg noodles\b|\bcocoa butter\b/i],
  ["Pantry", /\b(black|white) pepper|peppercorn|chilli flakes|chili flakes|chili powder|paprika|cumin|garlic powder|onion powder|dried \w+/i],
  ["Meat & Fish", /\b(chicken|beef|pork|lamb|turkey|bacon|ham|sausage|mince|steak|salmon|tuna|cod|haddock|tilapia|shrimp|prawns?|fish|anchov|sardines?|trout|mackerel|chorizo)\b/i],
  ["Dairy & Eggs", /\b(milk|yogurt|yoghurt|cheese|butter|cream|eggs?|kefir|feta|mozzarella|parmesan|ricotta|paneer|halloumi)\b/i],
  ["Bakery", /\b(bread|toast|buns?|bagels?|tortillas?|pita|wraps?|rolls?|baguette|sourdough|naan|croissant|brioche)\b/i],
  ["Produce", /\b(lettuce|spinach|kale|rocket|arugula|tomato(es)?|onions?|garlic|bell pepper|peppers?|carrots?|broccoli|cucumber|avocado|bananas?|apples?|berry|berries|lemons?|limes?|cabbage|zucchini|courgette|potato(es)?|mushrooms?|celery|ginger|herbs?|basil|cilantro|coriander|parsley|mint|scallions?|spring onion|leeks?|sweetcorn|cauliflower|asparagus|eggplant|aubergine|squash|oranges?|grapes?|mango|pineapple|greens|salad|shallots?|jalapeño|jalapeno|beetroot|radish|edamame|corn|sweetcorn|green beans?|snap peas?|peas?)\b/i],
  ["Pantry", /\b(rice|pasta|penne|spaghetti|noodles?|oats?|flour|sugar|salt|spice|oil|vinegar|sauce|stock|broth|beans?|lentils?|chickpeas?|quinoa|couscous|honey|syrup|nuts?|seeds?|peanut|almond|cashew|walnut|tahini|soy|tofu|tempeh|canned|coconut|cocoa|protein powder|yeast|baking|cornstarch|cornflour|breadcrumbs?|raisins?|dates?|olives?|mustard|ketchup|mayo|curry|stock cube)\b/i],
];

/** Which aisle an ingredient belongs to. Unknown items -> "Other" (never dropped). */
export function aisleFor(name: string): Aisle {
  const n = name.trim().toLowerCase();
  for (const [aisle, re] of RULES) if (re.test(n)) return aisle;
  return "Other";
}

/** Bucket a flat grocery list into aisle groups, in AISLE_ORDER, skipping empty aisles. Generic over
 *  the item shape (needs only a `name`), so callers keep their own fields (quantity, price, key).
 *  Items keep their incoming order (callers sort first). */
export function groupByAisle<T extends { name: string }>(items: T[]): { aisle: Aisle; items: T[] }[] {
  const buckets = new Map<Aisle, T[]>();
  for (const item of items) {
    const aisle = aisleFor(item.name);
    const list = buckets.get(aisle) ?? [];
    list.push(item);
    buckets.set(aisle, list);
  }
  return AISLE_ORDER.filter((a) => buckets.has(a)).map((aisle) => ({ aisle, items: buckets.get(aisle)! }));
}
