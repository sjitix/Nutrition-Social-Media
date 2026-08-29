import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { agentModelFn, resolveProvider, withTargetDefaults } from "@/lib/ai";
import { runAgent, MAX_STEPS, type TranscriptEntry } from "@/lib/agentLoop";
import { DEMO_ASSISTANT_REPLY } from "@/lib/demo";
import type { ChatMessage, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 300;

/**
 * The v2 assistant endpoint — now an AGENT LOOP rather than a single call.
 *
 * It used to be: model → apply → respond. One move, no matter what was asked, and no way for the
 * model to find out what its own change actually did. It is now `runAgent`, which lets the model
 * look things up, act, read the engine's response, and go again until it is done or hits MAX_STEPS.
 * See VISION.md ("Conversational assistant") and ASSISTANT-SCHEMA.md v3.
 *
 * What has NOT changed, and must not:
 *  - The two-layer rule. Writes still go through `applyPrimitives`; the model does no arithmetic
 *    and the engine remains the only thing that may claim something changed.
 *  - This route stays SEPARATE from `/api/assistant`, so the live assistant keeps working until
 *    the client is deliberately flipped over.
 *  - The server stays stateless. The transcript is the memory and it rides the request.
 */
interface AssistantV2Request {
  profile: UserProfile;
  plan: WeekPlan;
  history: ChatMessage[];
  /** State from before the last change, so an `undo` op can restore it. The server keeps none. */
  previous?: PlanSnapshot;
  /**
   * Saved recipe names. Passed IN because saves live in the browser (and will live in an account),
   * and this route has no localStorage — see `agentTools.ts`.
   */
  saved?: string[];
}

// Best-effort log of a full agent RUN — every step, every tool result. Richer than the old
// single-turn log on purpose: a multi-step transcript is what future training data looks like.
async function logRun(record: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "data");
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await fs.appendFile(path.join(dir, "edit-log-v2.jsonl"), line, "utf8");
  } catch {
    /* logging is best-effort */
  }
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

    // Everything before the current message becomes the loop's history. The last user message is
    // passed separately as the thing being acted on.
    const priorTurns = body.history.slice(0, -1);
    const history: TranscriptEntry[] = priorTurns.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.text }
        : { role: "assistant", turn: { thinking: "", reply: m.text, operations: [] } },
    );

    const result = await runAgent({
      profile,
      plan: body.plan,
      message,
      history,
      saved: body.saved,
      today: new Date().toISOString().slice(0, 10),
      previous: body.previous,
      model: agentModelFn(),
    });

    await logRun({
      message,
      steps: result.steps,
      gaveUp: result.gaveUp,
      transcript: result.transcript,
      planChanged: result.planChanged,
    });

    return NextResponse.json({
      reply: result.reply,
      planChanged: result.planChanged,
      plan: result.plan,
      profile: result.profile,
      previous: result.previous,
      provider,
      // Surfaced so the client can show the work, and so "it gave up" is visible in the response
      // rather than only inferable from a vague reply.
      steps: result.steps,
      maxSteps: MAX_STEPS,
      gaveUp: result.gaveUp,
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
