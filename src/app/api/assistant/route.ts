import { NextResponse } from "next/server";
import { hasApiKey, runAssistant } from "@/lib/ai";
import { DEMO_ASSISTANT_REPLY } from "@/lib/demo";
import type { ChatMessage, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 300;

interface AssistantRequest {
  profile: UserProfile;
  plan: WeekPlan;
  history: ChatMessage[];
}

export async function POST(request: Request) {
  let body: AssistantRequest;
  try {
    body = (await request.json()) as AssistantRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body?.profile || !body?.plan || !Array.isArray(body?.history)) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  if (!hasApiKey()) {
    return NextResponse.json({
      reply: DEMO_ASSISTANT_REPLY,
      planChanged: false,
      plan: body.plan,
      demo: true,
    });
  }

  try {
    const result = await runAssistant(body.profile, body.plan, body.history);
    return NextResponse.json({ ...result, demo: false });
  } catch (error) {
    console.error("Assistant call failed:", error);
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again." },
      { status: 502 },
    );
  }
}
