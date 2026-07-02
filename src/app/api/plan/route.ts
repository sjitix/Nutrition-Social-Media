import { NextResponse } from "next/server";
import { generatePlan, hasApiKey } from "@/lib/ai";
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

  if (!hasApiKey()) {
    return NextResponse.json({ plan: buildDemoPlan(profile), demo: true });
  }

  try {
    const plan = await generatePlan(profile);
    return NextResponse.json({ plan, demo: false });
  } catch (error) {
    console.error("Plan generation failed:", error);
    return NextResponse.json(
      { error: "Plan generation failed. Please try again." },
      { status: 502 },
    );
  }
}
