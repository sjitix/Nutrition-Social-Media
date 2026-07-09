/**
 * Print the model's RAW tool-call output for one message, using the app's real system prompt.
 *   npm run probe -- "swap monday breakfast for oatmeal, but keep me on my macros"
 * Use when the app's behaviour is surprising and you need to see what the model actually emitted.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assistantTurnSystemPrompt } from "@/lib/ai";
import { selectWeekFromDb, rebalanceWeek, applyOperations } from "@/lib/recipeDb";
import type { UserProfile } from "@/lib/types";

const ROOT = process.cwd();
const env: Record<string, string> = {};
if (existsSync(join(ROOT, ".env.local")))
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
const BASE_URL = process.env.BASE_URL ?? env.LOCAL_AI_URL ?? "http://localhost:1234/v1";
const MODEL = process.env.MODEL ?? env.LOCAL_AI_MODEL ?? "nutriflow-assistant";

const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const PLAN = rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE);
const msg = process.argv.slice(2).join(" ") || "swap monday breakfast for oatmeal, but keep me on my macros";

const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL, temperature: 0, max_tokens: 400,
    messages: [
      { role: "system", content: assistantTurnSystemPrompt(PROFILE, PLAN) },
      { role: "user", content: msg },
    ],
  }),
});
const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
const raw = j.choices?.[0]?.message?.content ?? "";
console.log(`\nUSER: ${msg}\n`);
console.log(`RAW MODEL OUTPUT:\n${raw}\n`);

try {
  const turn = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  const r = applyOperations(PROFILE, PLAN, turn.operations);
  console.log(`ENGINE NOTES: ${r.notes.length ? r.notes.join(" | ") : "(none)"}`);
  const mon = r.plan.days.find((d) => d.day === "Monday")!;
  console.log(`Monday: ${mon.meals.reduce((s, m) => s + m.calories, 0)} kcal, ${mon.meals.reduce((s, m) => s + m.proteinGrams, 0)}g protein`);
} catch (e) {
  console.log("could not parse/apply:", (e as Error).message);
}
