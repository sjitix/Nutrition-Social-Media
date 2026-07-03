import { NextResponse } from "next/server";
import { resolveProvider, runAssistant } from "@/lib/ai";
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

  const provider = resolveProvider();
  if (provider === "demo") {
    return NextResponse.json({
      reply: DEMO_ASSISTANT_REPLY,
      planChanged: false,
      plan: body.plan,
      demo: true,
    });
  }

  try {
    const result = await runAssistant(body.profile, body.plan, body.history);
    const changed = new Map(result.changedDays.map((d) => [d.day, d]));
    const mergedPlan = {
      ...body.plan,
      days: body.plan.days.map((d) => changed.get(d.day) ?? d),
    };
    return NextResponse.json({
      reply: result.reply,
      planChanged: changed.size > 0,
      plan: mergedPlan,
      demo: false,
      provider,
    });
  } catch (error) {
    console.error("Assistant call failed:", error);
    const message =
      error instanceof Error && provider === "local"
        ? error.message
        : "The assistant is unavailable right now. Please try again.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
