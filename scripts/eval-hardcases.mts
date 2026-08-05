/**
 * Grade a v2 model against the HARD eval (data/hard-cases.json) — the ruler for the retrained 7B.
 *
 *   npm run eval:hardcases
 *   MODEL=nutriflow-assistant-7b npm run eval:hardcases
 *
 * It sends the REAL v2 system prompt (assistantV2SystemPrompt, imported not copied) plus each case's
 * turn history to an OpenAI-compatible endpoint (LM Studio), constrains the reply to the v2 schema,
 * then runs the returned operations through the REAL engine (applyPrimitives) to see what actually
 * moved. Two-layer to the core: the model only decides; the engine measures truth.
 *
 * What it auto-scores (no judge model needed):
 *   schemaOk     — a valid {thinking, reply, operations} envelope
 *   actedRight   — DO cases emit operations; clarify/decline/refuse emit none (held)
 *   changedState — for DO cases, whether the plan/profile actually moved
 * The nuanced split among clarify vs decline vs refuse is semantic (all emit no ops), so the harness
 * prints every reply for a human to eyeball — it grades the coarse act/hold correctly and hands you
 * the material for the rest. If no model is reachable, it says so and exits 0 (nothing to grade yet).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assistantV2SystemPrompt } from "@/lib/promptV2";
import { AssistantTurnV2Schema, applyPrimitives, type PrimitiveOp } from "@/lib/primitives";
import { selectWeekFromDb, rebalanceWeek } from "@/lib/recipeDb";
import type { UserProfile } from "@/lib/types";

const ROOT = process.cwd();

function envLocal(): Record<string, string> {
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = envLocal();
const BASE_URL = process.env.BASE_URL ?? env.LOCAL_AI_URL ?? "http://localhost:1234/v1";
const MODEL = process.env.MODEL ?? env.LOCAL_AI_MODEL ?? "nutriflow-assistant";

interface HardCase {
  id: string;
  category: string;
  bucket: "do" | "clarify" | "decline" | "refuse";
  turns: { role: "user" | "assistant"; text: string }[];
  expected: string;
  why_hard: string;
}
const CASES: HardCase[] = JSON.parse(readFileSync(join(ROOT, "data", "hard-cases.json"), "utf8")).cases;

const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const PLAN = rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE);
const SYSTEM = assistantV2SystemPrompt(PROFILE, PLAN);

// Constrain the model to the v2 envelope exactly as the app does for local models.
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "assistant_turn_v2", strict: true, schema: z.toJSONSchema(AssistantTurnV2Schema) },
};

/** A connection/no-model error means "nothing to grade yet" — detected so we can exit 0, not crash. */
function isNoModel(msg: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|no models? loaded|model_not_found|connect|failed to fetch|\b404\b|\b503\b/i.test(msg);
}

async function ask(turns: HardCase["turns"]): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: 900,
      messages: [{ role: "system", content: SYSTEM }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
      response_format: RESPONSE_FORMAT,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

const stat = { n: 0, schemaOk: 0, actedRight: 0, changed: 0 };
const byBucket: Record<string, { n: number; right: number }> = {};
const lines: string[] = [];

console.log(`\nmodel: ${MODEL}\nendpoint: ${BASE_URL}\ncases: ${CASES.length}\n`);

for (const c of CASES) {
  let raw: string;
  try {
    raw = await ask(c.turns);
  } catch (e) {
    const msg = (e as Error).message;
    if (stat.n === 0 && isNoModel(msg)) {
      console.log(`No model reachable at ${BASE_URL} (${msg.slice(0, 80)}).`);
      console.log("Load the trained model in LM Studio and re-run — nothing to grade yet.");
      process.exit(0);
    }
    lines.push(`✗ ${c.id.padEnd(22)} [${c.bucket}] request failed: ${msg.slice(0, 60)}`);
    stat.n++;
    (byBucket[c.bucket] ??= { n: 0, right: 0 }).n++;
    continue;
  }
  stat.n++;
  const b = (byBucket[c.bucket] ??= { n: 0, right: 0 });
  b.n++;

  const m = raw.match(/\{[\s\S]*\}/); // models sometimes wrap the JSON in prose/fences
  let parsed: z.infer<typeof AssistantTurnV2Schema> | null = null;
  try {
    const obj = JSON.parse(m ? m[0] : raw);
    const v = AssistantTurnV2Schema.safeParse(obj);
    if (v.success) { parsed = v.data; stat.schemaOk++; }
  } catch {
    /* schema miss falls through to the failure line below */
  }
  if (!parsed) {
    lines.push(`✗ ${c.id.padEnd(22)} [${c.bucket}] bad schema: ${raw.replace(/\s+/g, " ").slice(0, 70)}`);
    continue;
  }

  const ops = parsed.operations as PrimitiveOp[];
  const acted = ops.length > 0;
  const expectAct = c.bucket === "do";
  const actedRight = acted === expectAct;
  if (actedRight) { stat.actedRight++; b.right++; }

  let changed = false;
  try {
    const res = applyPrimitives(PROFILE, PLAN, ops);
    changed = res.planChanged || res.profileChanged;
    if (changed) stat.changed++;
  } catch {
    /* an op the engine rejects still counts as a wrong action below */
  }

  const mark = actedRight ? "✓" : "✗";
  const did = acted ? (changed ? "acted+changed" : "acted") : "held";
  lines.push(`${mark} ${c.id.padEnd(22)} [${c.bucket}] want ${expectAct ? "ACT " : "HOLD"} · got ${did.padEnd(13)} · "${parsed.reply.replace(/\s+/g, " ").slice(0, 64)}"`);
}

const pct = (x: number, d = stat.n) => (d ? `${((x / d) * 100).toFixed(0)}%` : "—").padStart(4);
console.log(`schemaOk      ${pct(stat.schemaOk)}   (valid {thinking,reply,operations})`);
console.log(`actedRight    ${pct(stat.actedRight)}   (DO acts · clarify/decline/refuse hold)`);
console.log(`changedState  ${stat.changed}/${byBucket["do"]?.n ?? 0} DO-cases moved the plan/profile\n`);
console.log("by bucket:");
for (const [k, v] of Object.entries(byBucket)) console.log(`  ${k.padEnd(9)} ${v.right}/${v.n}`);
console.log("\nper-case (eyeball the reply for clarify/decline/refuse nuance):");
for (const l of lines) console.log("  " + l);
