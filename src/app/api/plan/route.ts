import { NextResponse } from "next/server";
import { generatePlan, resolveProvider } from "@/lib/ai";
import { buildDemoPlan } from "@/lib/demo";
import type { UserProfile } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  let profile: UserProfile;
  try {
    profile = (await request.json()) as UserProfile;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const provider = resolveProvider();
  if (provider === "demo") {
    return NextResponse.json({ plan: buildDemoPlan(profile), demo: true });
  }

  try {
    const plan = await generatePlan(profile);
    return NextResponse.json({ plan, demo: false, provider });
  } catch (error) {
    console.error("Plan generation failed:", error);
    const message =
      error instanceof Error && provider === "local"
        ? error.message
        : "Plan generation failed. Please try again.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
