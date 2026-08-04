import { NextResponse } from "next/server";
import { importRecipeFromUrl } from "@/lib/import";
import { videoPlatform, importRecipeFromVideo } from "@/lib/videoImport";

// The video path makes a model call after fetching the page, so allow more headroom than the
// deterministic JSON-LD path needs.
export const maxDuration = 60;

/**
 * Phase 2 — import a recipe from a pasted URL. Two paths, chosen by the link:
 *  - a recipe PAGE  -> deterministic schema.org/Recipe JSON-LD, no model (fast, reliable).
 *  - a VIDEO (YouTube/TikTok/IG) -> read the caption, let the model extract the recipe from prose.
 * Returns a plan-ready recipe or a plain-English reason it couldn't.
 */
export async function POST(request: Request) {
  let url: string;
  try {
    ({ url } = (await request.json()) as { url: string });
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Paste a recipe link to import." }, { status: 400 });
  }

  try {
    const trimmed = url.trim();
    const recipe = videoPlatform(trimmed)
      ? await importRecipeFromVideo(trimmed)
      : await importRecipeFromUrl(trimmed);
    return NextResponse.json({ recipe });
  } catch (error) {
    // importRecipeFromUrl throws user-facing messages ("I couldn't find a recipe…"); surface them.
    const msg =
      error instanceof Error
        ? /aborted|timed out|ETIMEDOUT/i.test(error.message)
          ? "That link took too long to load — try again, or a different recipe."
          : error.message
        : "Something went wrong importing that link.";
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
