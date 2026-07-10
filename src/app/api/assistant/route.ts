import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import {
  assistantTurnSystemPrompt,
  parseAssistantTurn,
  resolveProvider,
  withTargetDefaults,
} from "@/lib/ai";
import { applyOperations } from "@/lib/recipeDb";
import { composeReply, describeOperations } from "@/lib/reply";
import { DEMO_ASSISTANT_REPLY } from "@/lib/demo";
import type { ChatMessage, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 300;

interface AssistantRequest {
  profile: UserProfile;
  plan: WeekPlan;
  history: ChatMessage[];
  /** State from before the last change, so "undo" can restore it. The server keeps no state. */
  previous?: PlanSnapshot;
}

// Best-effort append of a COMPLETE training example per line — exactly what the
// model saw (systemPrompt + conversation) and what it should output (completion).
// This is the fine-tuning dataset; prep-finetune.mjs turns it into training data.
async function logTurn(record: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "data");
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
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
    // 2) Log a complete training example: the exact model input (system prompt +
    //    conversation) and the target output (the tool-call JSON).
    await logTurn({
      message,
      systemPrompt: assistantTurnSystemPrompt(profile, body.plan),
      history: body.history,
      completion: turn,
    });
    // 3) The database executes the tool calls — accurate, cheap, real recipes.
    const { plan, profile: newProfile, notes, replyOverride, planChanged, profileChanged, undone } =
      applyOperations(profile, body.plan, turn.operations, body.previous);

    // planChanged is now what the engine MEASURED, not which tools the model named. A swap for a
    // dish we don't stock is a no-op, and it used to answer "Done — I updated your plan."
    // The engine owns the reply outright on a crisis; that rule lives in lib/reply.ts.
    const reply = composeReply({ modelReply: turn.reply, notes, replyOverride, planChanged });

    // The snapshot the client hands back on the next turn. Undo is one level deep: after an undo
    // there is nothing further to step back to, and a turn that changed nothing must not overwrite
    // a snapshot the user can still use.
    const previous: PlanSnapshot | undefined = undone
      ? undefined
      : planChanged || profileChanged
        ? { plan: body.plan, profile, label: describeOperations(turn.operations) }
        : body.previous;

    return NextResponse.json({
      reply,
      planChanged,
      plan,
      profile: newProfile,
      previous,
      provider,
    });
  } catch (error) {
    console.error("Assistant call failed:", error);
    // Never leak the raw provider error to the user — LM Studio's "No models loaded. Please load a
    // model in the developer page or use the 'lms load' command" is meaningless to them and exposes
    // internals. Classify the common "model isn't there right now" cases and say so plainly, with a
    // flag the client uses to point at the direct actions (rate/pin/resize/undo) that still work.
    const raw = error instanceof Error ? error.message : String(error);
    const offline = /no models? loaded|model_not_found|ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|connect|502|503|404/i.test(raw);
    if (offline) {
      return NextResponse.json(
        {
          error: "The chat assistant is offline right now. You can still rate, pin and resize meals directly, or regenerate your plan — those work without it.",
          offline: true,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "The assistant hit a snag. Please try that again." },
      { status: 502 },
    );
  }
}
