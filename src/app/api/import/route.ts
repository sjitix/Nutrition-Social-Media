import { NextResponse } from "next/server";
import { importRecipeFromUrl } from "@/lib/import";

export const maxDuration = 30;

/**
 * Phase 2 — import a recipe from a pasted URL. Deterministic: reads the page's schema.org/Recipe
 * JSON-LD, no model involved. Returns a plan-ready recipe or a plain-English reason it couldn't.
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
    const recipe = await importRecipeFromUrl(url.trim());
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
