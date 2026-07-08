import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { parseAssistantTurn, resolveProvider, withTargetDefaults } from "@/lib/ai";
import { applyOperations } from "@/lib/recipeDb";
import { DEMO_ASSISTANT_REPLY } from "@/lib/demo";
import type { ChatMessage, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 300;

interface AssistantRequest {
  profile: UserProfile;
  plan: WeekPlan;
  history: ChatMessage[];
}

// Best-effort append of each request to a JSONL file — the automatic training set:
// {message, the tool calls it produced}. Never fails a request.
async function logTurn(message: string, turn: unknown): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "data");
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), message, turn }) + "\n";
    await fs.appendFile(path.join(dir, "edit-log.jsonl"), line, "utf8");
  } catch {
    /* logging is best-effort */
  }
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

  const message = [...body.history].reverse().find((m) => m.role === "user")?.text?.trim();
  if (!message) {
    return NextResponse.json({ error: "No message to act on." }, { status: 400 });
  }

  const provider = resolveProvider();
  if (provider === "demo") {
    return NextResponse.json({
      reply: DEMO_ASSISTANT_REPLY,
      planChanged: false,
      plan: body.plan,
      profile: body.profile,
      demo: true,
    });
  }

  try {
    // 1) The LLM interprets the conversation into a reply + a list of tool calls.
    const profile = withTargetDefaults(body.profile);
    const turn = await parseAssistantTurn(profile, body.plan, body.history);
    // 2) Log it (message -> tool calls) as the fine-tuning dataset.
    await logTurn(message, turn);
    // 3) The database executes the tool calls — accurate, cheap, real recipes.
    const { plan, profile: newProfile } = applyOperations(profile, body.plan, turn.operations);

    const planChanged = turn.operations.some((o) => o.tool !== "answer");
    return NextResponse.json({
      reply: turn.reply?.trim() || (planChanged ? "Done — I updated your plan." : "Happy to help."),
      planChanged,
      plan,
      profile: newProfile,
      provider,
    });
  } catch (error) {
    console.error("Assistant call failed:", error);
    const msg =
      error instanceof Error && provider === "local"
        ? error.message
        : "The assistant is unavailable right now. Please try again.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
