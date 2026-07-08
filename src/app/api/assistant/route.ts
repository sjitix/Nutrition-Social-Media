import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { parseEditIntent, resolveProvider, withTargetDefaults } from "@/lib/ai";
import { applyEdit } from "@/lib/recipeDb";
import { DEMO_ASSISTANT_REPLY } from "@/lib/demo";
import type { ChatMessage, UserProfile, WeekPlan } from "@/lib/types";

export const maxDuration = 300;

interface AssistantRequest {
  profile: UserProfile;
  plan: WeekPlan;
  history: ChatMessage[];
}

// Best-effort append of each request to a JSONL file — this is the automatic
// training-data collection: {message, interpreted intent}. Never fails a request.
async function logEdit(message: string, intent: unknown): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "data");
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), message, intent }) + "\n";
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
    // 1) LLM interprets the message into a structured edit.
    const profile = withTargetDefaults(body.profile);
    const intent = await parseEditIntent(profile, body.plan, body.history);
    // 2) Log the raw model output (automatic dataset — captures its mistakes too).
    await logEdit(message, intent);

    // Deterministic safety net: the small model sometimes misses "no oven"-style
    // method exclusions, so catch them straight from the message.
    const lower = message.toLowerCase();
    if (
      /(baked|baking|\bbake\b|roast|\boven\b)/.test(lower) &&
      /(no |without|don'?t have|do not have|avoid|swap|remove|replace|can'?t use|cannot use|get rid)/.test(
        lower,
      )
    ) {
      intent.changePlan = true;
      if (intent.scope !== "day") intent.scope = "week";
      intent.excludeFoods = [...new Set([...intent.excludeFoods, "bake", "roast", "oven"])];
    }

    // 3) Database executes the edit — accurate, cheap, real recipes.
    const { plan, profile: newProfile } = applyEdit(profile, body.plan, intent);

    // For a change, compose the confirmation from what ACTUALLY happened (never
    // from the LLM's narration, which can invent meals). Questions keep the
    // LLM's reply (the prompt already fed it the correct numbers).
    let reply = intent.reply?.trim() || "Happy to help.";
    if (intent.changePlan) {
      if (intent.scope === "day" && intent.day) {
        const d = plan.days.find((x) => x.day === intent.day);
        const dk = d ? d.meals.reduce((s, m) => s + m.calories, 0) : 0;
        const df = d ? d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0) : 0;
        reply = `Done — updated ${intent.day}: now ${dk} kcal and ${df}g fiber for the day.`;
      } else {
        const n = plan.days.length || 1;
        const k = Math.round(
          plan.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + m.calories, 0), 0) / n,
        );
        const pr = Math.round(
          plan.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + m.proteinGrams, 0), 0) / n,
        );
        const fi = Math.round(
          plan.days.reduce((s, d) => s + d.meals.reduce((a, m) => a + (m.fiberGrams ?? 0), 0), 0) / n,
        );
        reply = `Done — your week now averages ${k} kcal, ${pr}g protein and ${fi}g fiber per day.`;
      }
    }

    return NextResponse.json({
      reply,
      planChanged: intent.changePlan,
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
