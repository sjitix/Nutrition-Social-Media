/**
 * Phase 2, the "share a reel" layer — import a recipe from a YouTube / TikTok / Instagram link.
 *
 * These pages carry no schema.org/Recipe JSON-LD, so the deterministic path can't read them. Instead
 * we pull the video's caption/description text off the page (deterministic) and let the MODEL extract
 * the recipe structure from that prose (the one non-deterministic step). The model extracts structure
 * only — never nutrition — so a video-imported meal comes in without macros, honestly, rather than
 * with guessed ones. The fragile parts (a private video, a caption with no written recipe, a platform
 * that blocks us) all fail with a plain-English reason, never a crash.
 */
import { extractRecipeFromText } from "./ai";
import { isSafePublicUrl, fetchHtml, decodeEntities, type ImportedRecipe } from "./import";

export type VideoPlatform = "youtube" | "tiktok" | "instagram";

/** Which video platform a URL belongs to, or null if it's not one we handle. */
export function videoPlatform(url: string): VideoPlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) return "youtube";
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  return null;
}

/** Best-effort JSON string unescape ("&", "\n", '\\"') without eval. */
function jsonUnescape(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

/**
 * Pull the recipe-bearing text off a video page: the caption / description. Pure and fixture-testable
 * (no network). og:description covers all three platforms; YouTube also embeds the FULL description
 * (og is truncated) as "shortDescription" in its player JSON, which is where a recipe usually lives.
 */
export function extractVideoText(html: string, platform: VideoPlatform): string {
  const candidates: string[] = [];
  const og =
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
  if (og) candidates.push(decodeEntities(og[1]));
  if (platform === "youtube") {
    const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (m) candidates.push(jsonUnescape(m[1]));
  }
  // The longest candidate is the most complete text.
  return candidates.sort((a, b) => b.length - a.length)[0]?.trim() ?? "";
}

const MIN_TEXT = 40; // below this there's nothing a recipe could live in

/** Fetch a video page, read its caption, and let the model extract a recipe. Throws user-facing errors. */
export async function importRecipeFromVideo(url: string): Promise<ImportedRecipe> {
  if (!isSafePublicUrl(url)) throw new Error("That doesn't look like a public video link.");
  const platform = videoPlatform(url);
  if (!platform) throw new Error("I can read recipes from YouTube, TikTok and Instagram links.");

  const html = await fetchHtml(url);
  const text = extractVideoText(html, platform);
  if (text.length < MIN_TEXT) {
    throw new Error(
      "I couldn't read this video's caption — it may be private, or the recipe might be spoken aloud rather than written. Paste the recipe text, or a link to a recipe page, instead.",
    );
  }

  const extracted = await extractRecipeFromText(text);
  if (!extracted.found || extracted.ingredients.length === 0) {
    throw new Error(
      "That video's caption didn't include a written recipe I could read. Reels that list their ingredients in the caption work best.",
    );
  }

  return {
    name: (extracted.name || "Imported recipe").slice(0, 120),
    sourceUrl: url,
    servings: extracted.servings && extracted.servings > 0 ? extracted.servings : 1,
    ingredients: extracted.ingredients
      .map((i) => ({ name: i.name.trim(), quantity: (i.quantity ?? "").trim() }))
      .filter((i) => i.name),
    steps: extracted.steps.map((s) => s.trim()).filter(Boolean).slice(0, 25),
    timeMinutes: extracted.timeMinutes ?? undefined,
    // We never guess nutrition, and a caption gives none. The UI already discloses a no-macros import.
    macrosSource: "none",
  };
}
