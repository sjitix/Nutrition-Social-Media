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
// A keyed hosted route (NVIDIA NIM, OpenRouter, Moonshot) needs a bearer token; a bare LM Studio does
// not. Only sent when present, so the local path is byte-for-byte unchanged. Reasoning models emit more
// tokens before the JSON, so the cap is higher for hosted runs and overridable.
const API_KEY = process.env.LOCAL_AI_API_KEY ?? env.LOCAL_AI_API_KEY ?? "";
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? (API_KEY ? 2000 : 900));
// A per-request deadline (bare fetch has none) and a concurrency pool. Both default to the old behaviour
// for local runs; hosted queues (NVIDIA NIM sits ~200s deep on the free tier but serves requests in
// parallel) want a long timeout and EVAL_CONCURRENCY high to keep the wall-clock sane.
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS ?? (API_KEY ? 300000 : 120000));
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 1));

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

// Constrain the model to the v2 envelope exactly as the app does for local models. Hosted keyed routes
// don't all accept strict json_schema — some take only {type:"json_object"}, some neither — so ask()
// walks a fallback ladder and remembers the first format that works. The system prompt already asks for
// one bare JSON object and the parser below extracts it from prose, so even the no-format call grades.
const SCHEMA_FORMAT = {
  type: "json_schema",
  json_schema: { name: "assistant_turn_v2", strict: true, schema: z.toJSONSchema(AssistantTurnV2Schema) },
};
const OBJECT_FORMAT = { type: "json_object" };
type Fmt = typeof SCHEMA_FORMAT | typeof OBJECT_FORMAT | null;

/** A connection/no-model error means "nothing to grade yet" — detected so we can exit 0, not crash. */
function isNoModel(msg: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|no models? loaded|model_not_found|connect|failed to fetch|\b404\b|\b503\b/i.test(msg);
}

async function post(turns: HardCase["turns"], fmt: Fmt): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const body: Record<string, unknown> = {
    model: MODEL, temperature: 0, max_tokens: MAX_TOKENS,
    messages: [{ role: "system", content: SYSTEM }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
  };
  if (fmt) body.response_format = fmt;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    return await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

let workingFmt: Fmt | undefined; // undefined = not yet probed; then pinned to the first format that worked

async function ask(turns: HardCase["turns"]): Promise<string> {
  const ladder: Fmt[] = workingFmt === undefined ? [SCHEMA_FORMAT, OBJECT_FORMAT, null] : [workingFmt];
  let lastErr = "";
  for (const fmt of ladder) {
    const res = await post(turns, fmt);
    if (res.ok) {
      workingFmt = fmt;
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    }
    lastErr = `${res.status} ${(await res.text()).slice(0, 160)}`;
    // Only step down the ladder on a format-related 400; any other error is real — surface it.
    if (!(res.status === 400 && /response_format|json_schema|schema|guided|structured/i.test(lastErr))) {
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "request failed");
}

const stat = { n: 0, schemaOk: 0, actedRight: 0, changed: 0 };
const byBucket: Record<string, { n: number; right: number }> = {};
const lines: string[] = [];

console.log(`\nmodel: ${MODEL}\nendpoint: ${BASE_URL}\ncases: ${CASES.length}   concurrency: ${CONCURRENCY}\n`);

type CaseResult = { bucket: string; schemaOk: boolean; actedRight: boolean; changed: boolean; line: string; fatal?: string };

/** Grade ONE case: ask the model, parse the envelope, run the ops through the real engine. Never throws
 *  — a request/parse failure returns a result the tally counts as a miss, so one bad case can't sink the run. */
async function runCase(c: HardCase): Promise<CaseResult> {
  let raw: string;
  try {
    raw = await ask(c.turns);
  } catch (e) {
    const msg = (e as Error).message;
    return {
      bucket: c.bucket, schemaOk: false, actedRight: false, changed: false,
      fatal: isNoModel(msg) ? msg : undefined,
      line: `✗ ${c.id.padEnd(22)} [${c.bucket}] request failed: ${msg.slice(0, 60)}`,
    };
  }
  const m = raw.match(/\{[\s\S]*\}/); // models sometimes wrap the JSON in prose/fences
  let parsed: z.infer<typeof AssistantTurnV2Schema> | null = null;
  try {
    const obj = JSON.parse(m ? m[0] : raw);
    const v = AssistantTurnV2Schema.safeParse(obj);
    if (v.success) parsed = v.data;
  } catch {
    /* schema miss falls through to the failure line below */
  }
  if (!parsed) {
    return {
      bucket: c.bucket, schemaOk: false, actedRight: false, changed: false,
      line: `✗ ${c.id.padEnd(22)} [${c.bucket}] bad schema: ${raw.replace(/\s+/g, " ").slice(0, 70)}`,
    };
  }
  const ops = parsed.operations as PrimitiveOp[];
  const acted = ops.length > 0;
  const expectAct = c.bucket === "do";
  const actedRight = acted === expectAct;
  let changed = false;
  try {
    const res = applyPrimitives(PROFILE, PLAN, ops);
    changed = res.planChanged || res.profileChanged;
  } catch {
    /* an op the engine rejects still counts as a wrong action below */
  }
  const mark = actedRight ? "✓" : "✗";
  const did = acted ? (changed ? "acted+changed" : "acted") : "held";
  return {
    bucket: c.bucket, schemaOk: true, actedRight, changed,
    line: `${mark} ${c.id.padEnd(22)} [${c.bucket}] want ${expectAct ? "ACT " : "HOLD"} · got ${did.padEnd(13)} · "${parsed.reply.replace(/\s+/g, " ").slice(0, 64)}"`,
  };
}

// Warm up on the first case alone: pins the working response_format before the pool fires (so workers
// don't each re-probe the ladder) and, if nothing is reachable, exits 0 cleanly exactly like before.
const results: CaseResult[] = new Array(CASES.length);
results[0] = await runCase(CASES[0]);
if (results[0].fatal) {
  console.log(`No model reachable at ${BASE_URL} (${results[0].fatal.slice(0, 80)}).`);
  console.log("Load the trained model in LM Studio and re-run — nothing to grade yet.");
  process.exit(0);
}

// Bounded-concurrency pool over the rest; index-keyed so per-case output stays in case order regardless
// of completion order. CONCURRENCY defaults to 1 (sequential, unchanged for local runs).
let next = 1;
async function worker(): Promise<void> {
  for (let i = next++; i < CASES.length; i = next++) {
    results[i] = await runCase(CASES[i]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(0, CASES.length - 1)) }, worker));

for (const r of results) {
  stat.n++;
  const b = (byBucket[r.bucket] ??= { n: 0, right: 0 });
  b.n++;
  if (r.schemaOk) stat.schemaOk++;
  if (r.actedRight) { stat.actedRight++; b.right++; }
  if (r.changed) stat.changed++;
  lines.push(r.line);
}

const pct = (x: number, d = stat.n) => (d ? `${((x / d) * 100).toFixed(0)}%` : "—").padStart(4);
console.log(`schemaOk      ${pct(stat.schemaOk)}   (valid {thinking,reply,operations})`);
console.log(`actedRight    ${pct(stat.actedRight)}   (DO acts · clarify/decline/refuse hold)`);
console.log(`changedState  ${stat.changed}/${byBucket["do"]?.n ?? 0} DO-cases moved the plan/profile\n`);
console.log("by bucket:");
for (const [k, v] of Object.entries(byBucket)) console.log(`  ${k.padEnd(9)} ${v.right}/${v.n}`);
console.log("\nper-case (eyeball the reply for clarify/decline/refuse nuance):");
for (const l of lines) console.log("  " + l);
