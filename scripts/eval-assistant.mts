/**
 * Evaluate the assistant model against an OpenAI-compatible endpoint (LM Studio).
 *
 *   npm run eval:assistant
 *   MODEL=qwen2.5-7b-instruct-1m npm run eval:assistant     # compare vs the prompted base
 *
 * It sends the REAL system prompt the app sends (imported, not copy-pasted), against a real
 * generated week, so we measure what production actually does.
 *
 * Metrics, not vibes:
 *   validJson        - parseable JSON at all
 *   schemaOk         - matches AssistantTurn (reply + operations[])
 *   noHallucination  - never invents a tool name or a field outside the schema
 *   toolAccuracy     - correct tool chosen
 *   fieldAccuracy    - correct key fields (day/mealType/diet/budget/targets/excludeFoods)
 *   clarify/answer   - stays hands-off when the request is a question or ambiguous
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assistantTurnSystemPrompt } from "@/lib/ai";
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

const TOOLS = new Set(["update_profile", "regenerate_week", "regenerate_day", "swap_meal", "compute_targets",
  "log_meal", "weekly_report", "eating_out", "explain_meal", "substitute_ingredient", "symptom_check", "lock_meal", "unlock_meal", "rate_meal", "answer"]);
const FIELDS = new Set([
  "tool", "day", "mealType", "dish", "cuisine", "diet", "budget", "excludeFoods",
  "targetCalories", "targetProtein", "targetCarbs", "targetFat", "targetFiber",
  "maxCookTime", "preserveMacros", "useIngredients", "boostNutrient",
  "age", "heightCm", "weightKg", "sex", "activity", "goal",
  "loggedCalories", "loggedProtein", "estimatedCalories", "ingredient", "symptom", "rating",
]);

interface Case {
  msg: string;
  tool?: string;              // expected tool; absent => must NOT change the plan
  want?: Record<string, unknown>;
  expectExcludeMethod?: boolean;
  expectExclude?: string;
  expectUseIngredients?: boolean;
}

// The cases live in data/eval-cases.json, NOT here, so gen-synthetic.mjs and check-data.mjs can
// read the same list and guarantee no training example collides with an eval message. They used to
// live inline, and 24 of the 56 were verbatim training strings: the model had memorized the answers.
const CASES: Case[] = JSON.parse(
  readFileSync(join(ROOT, "data", "eval-cases.json"), "utf8"),
).cases as Case[];

const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const PLAN = rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE);
const SYSTEM = assistantTurnSystemPrompt(PROFILE, PLAN);

// The app enforces a JSON schema for local models. Comparing an unconstrained base against
// a fine-tune that natively emits the envelope is unfair: most of the base's "bad schema"
// failures have the right tool and fields, just no wrapper. ENFORCE=1 levels the field.
const ENFORCE = process.env.ENFORCE === "1";
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "assistant_turn",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reply: { type: "string" },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: [...TOOLS] },
              day: { type: ["string", "null"] },
              mealType: { type: ["string", "null"] },
              dish: { type: ["string", "null"] },
              cuisine: { type: ["string", "null"] },
              diet: { type: ["string", "null"] },
              budget: { type: ["string", "null"] },
              excludeFoods: { type: "array", items: { type: "string" } },
              targetCalories: { type: ["number", "null"] },
              targetProtein: { type: ["number", "null"] },
              targetFiber: { type: ["number", "null"] },
              maxCookTime: { type: ["number", "null"] },
              preserveMacros: { type: ["boolean", "null"] },
              useIngredients: { type: "array", items: { type: "string" } },
              boostNutrient: { type: ["string", "null"] },
              age: { type: ["number", "null"] },
              heightCm: { type: ["number", "null"] },
              weightKg: { type: ["number", "null"] },
              sex: { type: ["string", "null"] },
              activity: { type: ["string", "null"] },
              goal: { type: ["string", "null"] },
              loggedCalories: { type: ["number", "null"] },
              loggedProtein: { type: ["number", "null"] },
              estimatedCalories: { type: ["number", "null"] },
              ingredient: { type: ["string", "null"] },
              symptom: { type: ["string", "null"] },
              rating: { type: ["number", "null"] },
            },
            required: ["tool"],
          },
        },
      },
      required: ["reply", "operations"],
    },
  },
};

async function ask(message: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: 400,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: message }],
      ...(ENFORCE ? { response_format: RESPONSE_FORMAT } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

const stat = { n: 0, validJson: 0, schemaOk: 0, noHalluc: 0, toolAcc: 0, fieldAcc: 0, handsOff: 0 };
const handsOffTotal = CASES.filter((c) => !c.tool).length;
const failures: string[] = [];

for (const c of CASES) {
  stat.n++;
  let raw: string;
  try {
    raw = await ask(c.msg);
  } catch (e) {
    failures.push(`[${c.msg}] request failed: ${(e as Error).message}`);
    continue;
  }

  const m = raw.match(/\{[\s\S]*\}/); // models sometimes wrap JSON in prose/fences
  let turn: { reply?: unknown; operations?: unknown };
  try {
    turn = JSON.parse(m ? m[0] : raw);
    stat.validJson++;
  } catch {
    failures.push(`[${c.msg}] invalid JSON: ${raw.slice(0, 100)}`);
    continue;
  }

  const ops = Array.isArray(turn.operations) ? (turn.operations as Record<string, unknown>[]) : null;
  if (typeof turn.reply === "string" && ops) stat.schemaOk++;
  else {
    failures.push(`[${c.msg}] bad schema: ${JSON.stringify(turn).slice(0, 100)}`);
    continue;
  }

  const halluc = ops.some((o) => !TOOLS.has(String(o.tool))) || ops.some((o) => Object.keys(o).some((k) => !FIELDS.has(k)));
  if (!halluc) stat.noHalluc++;
  else failures.push(`[${c.msg}] hallucinated tool/field: ${JSON.stringify(ops).slice(0, 110)}`);

  if (!c.tool) {
    const acted = ops.some((o) => o.tool !== "answer");
    if (!acted) { stat.handsOff++; stat.toolAcc++; stat.fieldAcc++; }
    else failures.push(`[${c.msg}] acted when it should have answered: ${ops.map((o) => o.tool).join(",")}`);
    continue;
  }

  const got = ops[0] ?? {};
  if (got.tool === c.tool) stat.toolAcc++;
  else failures.push(`[${c.msg}] tool "${got.tool}" != "${c.tool}"`);

  // `&&=`, not `=`. These used to overwrite the `want` result, so a case carrying both a `want`
  // and an `expectExclude` silently scored on the exclusion alone.
  let ok = true;
  for (const [k, v] of Object.entries(c.want ?? {}))
    if (String(got[k] ?? "").toLowerCase() !== String(v).toLowerCase()) ok = false;
  if (c.expectExcludeMethod) ok &&= (got.excludeFoods as string[] | undefined ?? []).some((f) => /bake|roast|oven/i.test(f));
  if (c.expectExclude) ok &&= (got.excludeFoods as string[] | undefined ?? []).some((f) => f.toLowerCase().includes(c.expectExclude!));
  if (c.expectUseIngredients) ok &&= ((got.useIngredients as string[] | undefined) ?? []).length > 0;
  if (ok) stat.fieldAcc++;
  else failures.push(`[${c.msg}] fields off: ${JSON.stringify(got).slice(0, 130)}`);
}

const pct = (x: number) => `${((x / stat.n) * 100).toFixed(0)}%`.padStart(4);
console.log(`\nmodel: ${MODEL}\nendpoint: ${BASE_URL}\ncases: ${stat.n}\nschema enforcement: ${ENFORCE ? "ON (as the app does for local models)" : "OFF (raw instruction-following)"}\n`);
console.log(`validJson        ${pct(stat.validJson)}`);
console.log(`schemaOk         ${pct(stat.schemaOk)}`);
console.log(`noHallucination  ${pct(stat.noHalluc)}`);
console.log(`toolAccuracy     ${pct(stat.toolAcc)}`);
console.log(`fieldAccuracy    ${pct(stat.fieldAcc)}`);
console.log(`clarify/answer   ${stat.handsOff}/${handsOffTotal}`);
if (failures.length) {
  console.log(`\n--- failures (${failures.length}) ---`);
  for (const f of failures.slice(0, 25)) console.log("  " + f);
}
