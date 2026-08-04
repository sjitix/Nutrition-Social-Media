/**
 * Phase 2 — the share-a-reel importer, MVP.
 *
 * Paste a recipe URL and get back a plan-ready meal. The reliable, DETERMINISTIC path is
 * schema.org/Recipe JSON-LD, which almost every recipe site embeds (name, ingredients, steps, and
 * usually per-serving nutrition). That sidesteps the model AND our nutrient table's limited coverage
 * of exotic ingredients: when the page states its own macros, we trust them; when it doesn't, we
 * compute from the ingredients we recognise and say the coverage is partial.
 *
 * Two-layer rule still holds: no arithmetic here beyond dividing the site's own numbers by servings.
 * Video platforms (TikTok/IG/YouTube) need transcript fetching and are a later layer — this handles
 * the URL case, which is most of the value and none of the fragility.
 */
import type { Meal } from "./types";

export interface ImportedRecipe {
  name: string;
  sourceUrl: string;
  servings: number;
  ingredients: { name: string; quantity: string }[];
  steps: string[];
  timeMinutes?: number;
  // Per-serving, when we could establish them.
  calories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
  fiberGrams?: number;
  macrosSource: "site" | "none";
}

/** Only http(s), and never a private/loopback host — this fetches a URL the user pasted. */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  // Block obvious private / link-local / loopback IP literals.
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === "0.0.0.0" || host === "::1" || host.startsWith("[")) return false;
  return true;
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        // A plain UA — some sites 403 an empty one. We identify honestly.
        "User-Agent": "Mozilla/5.0 (compatible; NutriFlow/1.0; +recipe-import)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`the site returned ${res.status}`);
    // Cap the body so a huge/streaming response can't exhaust memory.
    const buf = await res.arrayBuffer();
    return new TextDecoder("utf-8").decode(buf.slice(0, 3_000_000));
  } finally {
    clearTimeout(timer);
  }
}

/** Find the first schema.org Recipe object across all ld+json blocks (handles @graph nesting). */
function findRecipe(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findRecipe(v);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return obj;
    for (const v of Object.values(obj)) {
      const r = findRecipe(v);
      if (r) return r;
    }
  }
  return null;
}

function extractRecipeJsonLd(html: string): Record<string, unknown> | null {
  // The quotes around the type value are OPTIONAL. Yoast SEO — one of the most common WordPress
  // plugins, so a huge share of recipe blogs — minifies its output to `<script
  // type=application/ld+json class=yoast-schema-graph>` with NO quotes. Requiring quotes silently
  // skipped every one of those sites (found live on loveandlemons.com). `["']?` accepts both.
  const blocks = html.match(/<script[^>]*\btype=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      continue; // one malformed block shouldn't sink the rest
    }
    const r = findRecipe(data);
    if (r) return r;
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°",
  frac12: "½", frac14: "¼", frac34: "¾", frac13: "⅓", frac23: "⅔", frac18: "⅛",
  ndash: "-", mdash: "—", hellip: "…", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Split "2 tbsp cumin seeds" into a quantity ("2 tbsp") and a name ("cumin seeds"). Best effort. */
export function parseIngredient(raw: string): { name: string; quantity: string } {
  const text = stripTags(raw);
  // Leading amount: numbers, fractions, ranges, and an optional unit word.
  const m = text.match(
    /^([\d¼-¾⅐-⅞./-]+(?:\s*[\d¼-¾⅐-⅞./-]+)?)\s*(tbsp|tbs|tsp|teaspoons?|tablespoons?|cups?|g|kg|ml|l|oz|lb|lbs|cloves?|pieces?|slices?|cans?|handfuls?|pinch(?:es)?|sprigs?)?\s+(.*)$/i,
  );
  if (m && m[3]) {
    let qty = [m[1], m[2]].filter(Boolean).join(" ").trim();
    let name = m[3].trim();
    // Dual-unit ingredients ("1.2 kg / 2.4lb chuck beef", common on RecipeTinEats and other blogs
    // that print metric AND imperial) strand the alternate measure at the FRONT of the name. A real
    // food name never starts with "/ 2.4lb", so this only fires on that stranded case: fold it back
    // into the quantity and let the name be just the food.
    const alt = name.match(
      /^\/\s*([\d¼-¾⅐-⅞.,]+\s*(?:tbsp|tbs|tsp|cups?|g|kg|ml|l|oz|lb|lbs)?)\s+(.+)$/i,
    );
    if (alt) {
      qty = `${qty} / ${alt[1].trim()}`.trim();
      name = alt[2].trim();
    }
    return { name, quantity: qty };
  }
  return { name: text, quantity: "" };
}

function parseSteps(instructions: unknown): string[] {
  if (typeof instructions === "string") return stripTags(instructions).split(/\.\s+(?=[A-Z])/).filter(Boolean);
  if (!Array.isArray(instructions)) return [];
  const out: string[] = [];
  for (const step of instructions) {
    if (typeof step === "string") out.push(stripTags(step));
    else if (step && typeof step === "object") {
      const s = step as Record<string, unknown>;
      // HowToSection -> itemListElement of HowToStep; HowToStep -> text
      if (Array.isArray(s.itemListElement)) out.push(...parseSteps(s.itemListElement));
      else if (typeof s.text === "string") out.push(stripTags(s.text));
      else if (typeof s.name === "string") out.push(stripTags(s.name));
    }
  }
  return out.filter(Boolean);
}

const numFrom = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const m = String(v).match(/[\d.]+/);
  return m ? Math.round(Number(m[0])) : undefined;
};

function parseYield(y: unknown): number {
  if (Array.isArray(y)) y = y.find((x) => /\d/.test(String(x))) ?? y[0];
  const n = numFrom(y);
  return n && n > 0 && n < 100 ? n : 1;
}

/** ISO-8601 duration (PT1H30M) or a plain "45 mins" -> minutes. */
function parseDuration(d: unknown): number | undefined {
  if (!d) return undefined;
  const s = String(d);
  const iso = s.match(/P(?:T?)(?:(\d+)H)?(?:(\d+)M)?/);
  if (iso && (iso[1] || iso[2])) return (Number(iso[1] ?? 0) * 60) + Number(iso[2] ?? 0);
  return numFrom(s);
}

export async function importRecipeFromUrl(url: string): Promise<ImportedRecipe> {
  if (!isSafePublicUrl(url)) throw new Error("That doesn't look like a public recipe link.");
  const html = await fetchHtml(url);
  return parseRecipeHtml(html, url);
}

/** The pure part: HTML string + source URL -> recipe. Separated from the fetch so it's testable
 *  with fixtures and has no network dependency. */
export function parseRecipeHtml(html: string, url: string): ImportedRecipe {
  const r = extractRecipeJsonLd(html);
  if (!r) throw new Error("I couldn't find a recipe on that page. It works best with a link to a recipe (not a video).");

  const rawIngredients = Array.isArray(r.recipeIngredient) ? (r.recipeIngredient as unknown[]) : [];
  const ingredients = rawIngredients.map((i) => parseIngredient(String(i))).filter((i) => i.name);
  if (!ingredients.length) throw new Error("I found the page but couldn't read its ingredient list.");

  const servings = parseYield(r.recipeYield);
  const nutrition = (r.nutrition && typeof r.nutrition === "object" ? r.nutrition : {}) as Record<string, unknown>;
  // schema.org NutritionInformation is PER SERVING already.
  const cal = numFrom(nutrition.calories);
  const macrosSource: ImportedRecipe["macrosSource"] = cal != null ? "site" : "none";

  return {
    name: stripTags(String(r.name ?? "Imported recipe")).slice(0, 120) || "Imported recipe",
    sourceUrl: url,
    servings,
    ingredients,
    steps: parseSteps(r.recipeInstructions).slice(0, 25),
    timeMinutes: parseDuration(r.totalTime) ?? parseDuration(r.cookTime),
    calories: cal,
    proteinGrams: numFrom(nutrition.proteinContent),
    carbsGrams: numFrom(nutrition.carbohydrateContent),
    fatGrams: numFrom(nutrition.fatContent),
    fiberGrams: numFrom(nutrition.fiberContent),
    macrosSource,
  };
}

/** Turn an imported recipe into a plan Meal for a given slot. Macros are the site's PER-SERVING
 *  values; they default to 0 when the site gave none (the UI flags that), never guessed. */
export function importedToMeal(r: ImportedRecipe, type: Meal["type"]): Meal {
  return {
    type,
    name: r.name,
    description: `Imported from ${new URL(r.sourceUrl).hostname.replace(/^www\./, "")}`,
    sourceUrl: r.sourceUrl,
    calories: r.calories ?? 0,
    proteinGrams: r.proteinGrams ?? 0,
    carbsGrams: r.carbsGrams ?? 0,
    fatGrams: r.fatGrams ?? 0,
    ...(r.fiberGrams != null ? { fiberGrams: r.fiberGrams } : {}),
    timeMinutes: r.timeMinutes ?? 0, // required by the schema; 0 renders as no time badge
    // The ingredient list is the whole batch; the macros are per serving. servings lets any
    // ingredient-derived nutrient math divide correctly.
    ...(r.servings > 1 ? { servings: r.servings } : {}),
    ingredients: r.ingredients,
    steps: r.steps.length ? r.steps : ["See the original recipe for the method."],
  };
}
