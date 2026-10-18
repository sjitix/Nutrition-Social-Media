/**
 * Does a remembered allergy reach the plate whatever LABEL the model gave it? Model-free: each case drives
 * the real agent loop with a scripted model that sends one `remember`, then grades what the ENGINE did to
 * the week (the loop eval's fixed profile and week).
 *
 *   npx esbuild scripts/models/probe-allergy-labels.mts --bundle --platform=node --format=esm \
 *     --tsconfig=tsconfig.json --outfile=<tmp>/models-probe-allergy.mjs && node <tmp>/models-probe-allergy.mjs
 *
 * Why (2026-10-18): the engine blocks a remembered allergen only when the model labels the fact
 * `kind: "allergy"`, and the prompt shows `kind` as optional without saying so. A gpt-oss-20b turn sent
 * `{op:"remember", fact:"allergic to shellfish"}` with no kind, and Shrimp & Tomato Rice stayed in the
 * week. "Enforced" cases must leave no meal the allergen blocks; "unchanged" cases (facts that are not
 * allergies, or name no food) must leave the allergies and the week alone. Exit code = failures.
 *
 * Measured 2026-10-18: 7/12 on main (the five unlabelled or mislabelled allergies fail), 12/12 with the
 * patch on models-exp 49385e5. It is evidence for v1, not a gate: it fails on main until that patch lands.
 */
import { runAgent, type AgentTurn, type ModelFn } from "@/lib/assistant";
import { selectWeekFromDb, rebalanceWeek, withSeed } from "@/lib/plan";
import { haystackBlocked } from "@/lib/nutrition";
import type { Meal, UserProfile, WeekPlan } from "@/lib/core";

const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const PLAN: WeekPlan = withSeed(20261003, () => rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE));

const meals = (p: WeekPlan) => p.days.flatMap((d) => d.meals);
const blockedBy = (p: WeekPlan, token: string) =>
  meals(p).filter((m: Meal) => haystackBlocked([m.name, ...m.ingredients.map((i) => i.name)].join(" "), [token]));

type Remember = { op: "remember"; fact: string; kind?: string };
interface Case { remember: Remember; expect: "enforced" | "unchanged"; allergen?: string; note?: string }
const CASES: Case[] = [
  { remember: { op: "remember", fact: "allergic to peanuts", kind: "allergy" }, expect: "enforced", allergen: "peanut", note: "control: labelled" },
  { remember: { op: "remember", fact: "allergic to peanuts" }, expect: "enforced", allergen: "peanut", note: "no kind (the 20B's shape)" },
  { remember: { op: "remember", fact: "severe nut allergy", kind: "context" }, expect: "enforced", allergen: "nut" },
  { remember: { op: "remember", fact: "has coeliac disease", kind: "condition" }, expect: "enforced", allergen: "gluten" },
  { remember: { op: "remember", fact: "lactose intolerant", kind: "condition" }, expect: "enforced", allergen: "lactose" },
  { remember: { op: "remember", fact: "my son is allergic to eggs", kind: "context" }, expect: "enforced", allergen: "egg", note: "a household member: errs toward excluding" },
  { remember: { op: "remember", fact: "loves peanut butter", kind: "preference" }, expect: "unchanged", note: "no cue: must not become an allergy" },
  { remember: { op: "remember", fact: "wants a high-protein afternoon snack daily", kind: "preference" }, expect: "unchanged", note: "no cue (the parser alone would read 'protein')" },
  { remember: { op: "remember", fact: "not allergic to anything", kind: "context" }, expect: "unchanged" },
  { remember: { op: "remember", fact: "no allergies" }, expect: "unchanged" },
  { remember: { op: "remember", fact: "allergic to penicillin", kind: "condition" }, expect: "unchanged", note: "a cue, but no food" },
  { remember: { op: "remember", fact: "hay fever allergy in spring", kind: "condition" }, expect: "unchanged", note: "a cue, but no food" },
];

const turn = (reply: string, operations: unknown[] = []): AgentTurn => ({ thinking: "", reply, operations }) as unknown as AgentTurn;
let failed = 0;
for (const c of CASES) {
  let calls = 0;
  const model: ModelFn = async () => (calls++ === 0 ? turn("Noted.", [c.remember]) : turn(""));
  const r = await runAgent({ profile: structuredClone(PROFILE), plan: structuredClone(PLAN), message: c.remember.fact, model });
  const label = `${JSON.stringify(c.remember.fact)}${c.remember.kind ? ` (${c.remember.kind})` : " (no kind)"}`;
  let why: string | null = null;
  if (c.expect === "enforced") {
    const start = blockedBy(PLAN, c.allergen!).length;
    const left = blockedBy(r.plan, c.allergen!).map((m) => m.name);
    if (start === 0) why = `the fixed week has no ${c.allergen} meal, so this case proves nothing`;
    else if (left.length) why = `${left.length}/${start} ${c.allergen} meal(s) still in the week: ${[...new Set(left)].slice(0, 3).join(", ")}`;
  } else {
    if ((r.profile.allergies ?? "") !== "") why = `allergies became "${r.profile.allergies}"`;
    else if (meals(r.plan).map((m) => m.name).join() !== meals(PLAN).map((m) => m.name).join()) why = "the week changed";
  }
  if (why) failed++;
  console.log(`${why ? "FAIL" : "pass"}  ${c.expect.padEnd(9)} ${label.padEnd(58)} ${why ?? ""}${c.note ? `  [${c.note}]` : ""}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} cases pass`);
process.exit(failed);
