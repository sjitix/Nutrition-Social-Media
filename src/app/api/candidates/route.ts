import { NextResponse } from "next/server";
import { swapCandidates } from "@/lib/recipeDb";
import type { DayPlan, Meal, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 30;

/**
 * The dishes that could take one slot, each with the change it would make to the day.
 *
 * Read-only and model-free: it changes nothing and answers from the engine's own candidate pool, so
 * a swap control can show consequences rather than names. It exists as a route, rather than the
 * browser filtering the library itself, for the reason the whole direct-manipulation layer exists
 * (docs/v1/05-direct-manipulation.md, E1): `recipeDb` carries all 501 recipes with their ingredients
 * and steps, and importing it into a client component would serialise the lot into the bundle.
 *
 * The safety argument for offering a list at all: the pool comes from the engine's own filter, which
 * already applies the diet, the allergen and dislike exclusions, the cook-time and budget limits,
 * and drops anything rated 1. A candidate the executor would refuse must never be offered — being
 * shown a dish and then told no is worse than not being shown it.
 */
interface CandidatesRequest {
  profile: UserProfile;
  plan: WeekPlan;
  day: DayPlan["day"];
  mealType: Meal["type"];
  limit?: number;
  /** A protein floor for this meal — "I want at least 45 g here". */
  minProtein?: number;
}

export async function POST(request: Request) {
  let body: CandidatesRequest;
  try {
    body = (await request.json()) as CandidatesRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body?.profile || !body?.plan?.days || !body?.day || !body?.mealType) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  // Cap the list here as well as in the engine: an unbounded limit from a client is how a read
  // endpoint becomes a way to dump the library.
  const want = Number(body.limit);
  const limit = Math.min(Number.isFinite(want) && want >= 1 ? Math.floor(want) : 6, 12);

  try {
    const floor = Number(body.minProtein);
    return NextResponse.json(
      swapCandidates(body.profile, body.plan, body.day, body.mealType, limit,
        Number.isFinite(floor) && floor > 0 ? floor : undefined),
    );
  } catch {
    // A malformed plan shouldn't 500 — the UI just shows no alternatives.
    return NextResponse.json({ error: "Couldn't work out alternatives for that slot." }, { status: 422 });
  }
}
