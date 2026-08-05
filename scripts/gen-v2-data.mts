/**
 * Build data/finetune-v2.jsonl for the 7B QLoRA train.
 *
 * generate → VALIDATE against the real engine → write only the correct ones, in the trainer's chat
 * format ({"messages":[system, …turns, assistant]}, loss on the assistant turn). The assistant turn
 * is the JSON {thinking, reply, operations}. A few distinct plans are cycled through the system
 * prompt so the model doesn't overfit one week's context.
 *
 *   npx esbuild scripts/gen-v2-data.mts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile=node_modules/.cache/gen-v2.mjs && node node_modules/.cache/gen-v2.mjs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectWeekFromDb, rebalanceWeek } from "@/lib/recipeDb";
import { validateExample } from "@/lib/dataValidate";
import { generateExamples } from "@/lib/genV2";
import { assistantV2SystemPrompt } from "@/lib/promptV2";
import type { UserProfile } from "@/lib/types";

const BASE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const freshWeek = (p: UserProfile) => rebalanceWeek(selectWeekFromDb(p), p);

const examples = generateExamples();
const plans = Array.from({ length: 5 }, () => freshWeek(BASE)); // a little plan variety in the prompt
const defaults = { profile: BASE, plan: plans[0] };

const lines: string[] = [];
let rejected = 0;
const reasons: Record<string, number> = {};
examples.forEach((ex, i) => {
  const v = validateExample(ex, defaults);
  if (!v.ok) {
    rejected++;
    reasons[v.reason ?? "?"] = (reasons[v.reason ?? "?"] ?? 0) + 1;
    return;
  }
  const plan = ex.plan ?? plans[i % plans.length];
  const messages = [
    { role: "system", content: assistantV2SystemPrompt(ex.profile ?? BASE, plan) },
    ...ex.turns.map((t) => ({ role: t.role, content: t.text })),
    { role: "assistant", content: JSON.stringify({ thinking: ex.thinking, reply: ex.reply, operations: ex.operations }) },
  ];
  lines.push(JSON.stringify({ messages }));
});

writeFileSync(join(process.cwd(), "data", "finetune-v2.jsonl"), lines.join("\n") + "\n", "utf-8");
console.log(`wrote ${lines.length} examples (rejected ${rejected}) -> data/finetune-v2.jsonl`);
if (rejected) console.log("reject reasons:", JSON.stringify(reasons));
