import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { parseAssistantTurnV2, resolveProvider, withTargetDefaults } from "@/lib/ai";
import { applyPrimitives, type PrimitiveOp } from "@/lib/primitives";
import { composeReply } from "@/lib/reply";
import { DEMO_ASSISTANT_REPLY } from "@/lib/demo";
import type { ChatMessage, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 300;

/**
 * The v2 assistant endpoint — the reason-then-act pipeline for the retrained 7B. It is a SEPARATE
 * route on purpose: the live /api/assistant keeps running the current model + old schema until the
 * 7B is trained and validated, at which point the client flips to this one. Same two-layer contract
 * as the live route — the model only decides; the deterministic engine (applyPrimitives) does every
 * bit of math and owns the truth of what changed.
 */
interface AssistantV2Request {
  profile: UserProfile;
  plan: WeekPlan;
  history: ChatMessage[];
  /** State from before the last change, so an `undo` op can restore it. The server keeps no state. */
  previous?: PlanSnapshot;
}

// Best-effort log of a full v2 turn (prompt input + the model's {thinking,reply,operations}). Kept
// in its own file so it never mixes with the v1 fine-tune log.
async function logTurn(record: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "data");
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await fs.appendFile(path.join(dir, "edit-log-v2.jsonl"), line, "utf8");
  } catch {
    /* logging is best-effort */
  }
}

/** A short label for the undo snapshot, built from the primitive ops (which carry `op`, not `tool`). */
function labelOps(ops: PrimitiveOp[]): string {
  const names = ops.map((o) => (o as { op?: string; tool?: string }).op ?? (o as { tool?: string }).tool).filter(Boolean);
  return names.length ? `your last change (${names.join(", ")})` : "your last change";
}

export async function POST(request: Request) {
  let body: AssistantV2Request;
  try {
    body = (await request.json()) as AssistantV2Request;
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
    const profile = withTargetDefaults(body.profile);
    // 1) The model REASONS then ACTS: {thinking, reply, operations}. thinking is internal only.
    const turn = await parseAssistantTurnV2(profile, body.plan, body.history);
    const ops = turn.operations as PrimitiveOp[];
    await logTurn({ message, history: body.history, completion: turn });

    // 2) The deterministic engine runs the primitives and MEASURES what actually changed.
    const today = new Date().toISOString().slice(0, 10);
    const { plan, profile: newProfile, notes, replyOverride, planChanged, profileChanged, undone } =
      applyPrimitives(profile, body.plan, ops, today, body.previous);

    // 3) Engine notes are authoritative; the model's prose only fills in when the engine is silent.
    const reply = composeReply({ modelReply: turn.reply, notes, replyOverride, planChanged });

    // One level of undo: after an undo there's nothing further back; a no-op turn keeps the old snapshot.
    const previous: PlanSnapshot | undefined = undone
      ? undefined
      : planChanged || profileChanged
        ? { plan: body.plan, profile, label: labelOps(ops) }
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
    console.error("Assistant v2 call failed:", error);
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
