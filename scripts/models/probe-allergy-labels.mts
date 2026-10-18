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
 * week. "Enforced" cases must leave no meal the allergen blocks. "Binds nothing" cases (facts that are
 * not allergies, deny one, or name no food) must leave the week alone, and whatever they store must block
 * no recipe in the library: storing "tea tree oil" honestly is fine, storing "oil" is not. Exit code =
 * failures.
 *
 * Measured 2026-10-18: 7/12 on main before 09f325f (the five unlabelled or mislabelled allergies fail);
 * 12/12 with this lane's patch (models-exp 49385e5). That patch over-bound DENIALS ("No allergies; eats
 * dairy and gluten" bound dairy and gluten) and carrier words ("tea tree oil" stored "oil"), which these
 * twelve could not see: their negatives were bare negations. v1's adversarial review found it, and
 * 09f325f lands the patch with a denial check and a carrier filter; the regression rows below are that
 * review's cases.
 */
import { runAgent, type AgentTurn, type ModelFn } from "@/lib/assistant";
import { selectWeekFromDb, rebalanceWeek, withSeed, RECIPES } from "@/lib/plan";
import { haystackBlocked, parseExclusionTokens } from "@/lib/nutrition";
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
interface Case { remember: Remember; expect: "enforced" | "binds nothing"; allergen?: string | string[]; note?: string }
const CASES: Case[] = [
  { remember: { op: "remember", fact: "allergic to peanuts", kind: "allergy" }, expect: "enforced", allergen: "peanut", note: "control: labelled" },
  { remember: { op: "remember", fact: "allergic to peanuts" }, expect: "enforced", allergen: "peanut", note: "no kind (the 20B's shape)" },
  { remember: { op: "remember", fact: "severe nut allergy", kind: "context" }, expect: "enforced", allergen: "nut" },
  { remember: { op: "remember", fact: "has coeliac disease", kind: "condition" }, expect: "enforced", allergen: "gluten" },
  { remember: { op: "remember", fact: "lactose intolerant", kind: "condition" }, expect: "enforced", allergen: "lactose" },
  { remember: { op: "remember", fact: "my son is allergic to eggs", kind: "context" }, expect: "enforced", allergen: "egg", note: "a household member: errs toward excluding" },
  { remember: { op: "remember", fact: "loves peanut butter", kind: "preference" }, expect: "binds nothing", note: "no cue: must not become an allergy" },
  { remember: { op: "remember", fact: "wants a high-protein afternoon snack daily", kind: "preference" }, expect: "binds nothing", note: "no cue (the parser alone would read 'protein')" },
  { remember: { op: "remember", fact: "not allergic to anything", kind: "context" }, expect: "binds nothing" },
  { remember: { op: "remember", fact: "no allergies" }, expect: "binds nothing" },
  { remember: { op: "remember", fact: "allergic to penicillin", kind: "condition" }, expect: "binds nothing", note: "a cue, but no food" },
  { remember: { op: "remember", fact: "hay fever allergy in spring", kind: "condition" }, expect: "binds nothing", note: "a cue, but no food" },
  // Regression rows from v1's review of 49385e5: a DENIAL with food words, and a carrier word.
  { remember: { op: "remember", fact: "No allergies; eats dairy and gluten" }, expect: "binds nothing", note: "denial + food words (bound 59% of the library)" },
  { remember: { op: "remember", fact: "Not lactose intolerant, drinks milk every day", kind: "context" }, expect: "binds nothing", note: "denial + food words" },
  { remember: { op: "remember", fact: "used to be lactose intolerant", kind: "context" }, expect: "binds nothing", note: "a past allergy" },
  { remember: { op: "remember", fact: "allergic to tea tree oil", kind: "condition" }, expect: "binds nothing", note: "carrier word (stored 'oil')" },
  // ...and what the denial check must NOT swallow: an exception, and a labelled reaction.
  { remember: { op: "remember", fact: "no allergies except peanuts" }, expect: "enforced", allergen: "peanut", note: "an exception still binds" },
  { remember: { op: "remember", fact: "dairy makes me sick", kind: "allergy" }, expect: "enforced", allergen: "dairy", note: "a labelled reaction, no cue word" },
  // Rows for v1's B1 (ba23884): misspelt cues, plural cues and categories, and every cue sentence read.
  { remember: { op: "remember", fact: "alergic to peanuts" }, expect: "enforced", allergen: "peanut", note: "misspelt cue" },
  { remember: { op: "remember", fact: "intolerent to lactose", kind: "condition" }, expect: "enforced", allergen: "lactose", note: "misspelt cue" },
  { remember: { op: "remember", fact: "has celiak disease", kind: "condition" }, expect: "enforced", allergen: "gluten", note: "misspelt cue" },
  { remember: { op: "remember", fact: "I have intolerances to lactose", kind: "context" }, expect: "enforced", allergen: "lactose", note: "plural cue" },
  { remember: { op: "remember", fact: "allergens: peanuts and sesame" }, expect: "enforced", allergen: ["peanut", "sesame"], note: "plural cue, two allergens" },
  { remember: { op: "remember", fact: "allergic to crustaceans", kind: "context" }, expect: "enforced", allergen: "shellfish", note: "plural category" },
  { remember: { op: "remember", fact: "allergic to groundnuts", kind: "condition" }, expect: "enforced", allergen: "peanut", note: "plural category" },
  { remember: { op: "remember", fact: "Allergic to peanuts. Also allergic to sesame." }, expect: "enforced", allergen: ["peanut", "sesame"], note: "the second cue sentence" },
  { remember: { op: "remember", fact: "no known allergens", kind: "context" }, expect: "binds nothing", note: "plural denial" },
  { remember: { op: "remember", fact: "no intolerances" }, expect: "binds nothing", note: "plural denial" },
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
    const problems: string[] = [];
    for (const allergen of ([] as string[]).concat(c.allergen ?? [])) {
      const start = blockedBy(PLAN, allergen).length;
      const left = blockedBy(r.plan, allergen).map((m) => m.name);
      if (start === 0) problems.push(`the fixed week has no ${allergen} meal, so this case proves nothing`);
      else if (left.length) problems.push(`${left.length}/${start} ${allergen} meal(s) still in the week: ${[...new Set(left)].slice(0, 3).join(", ")}`);
    }
    why = problems.length ? problems.join("; ") : null;
  } else {
    const stored = parseExclusionTokens(r.profile.allergies ?? "", "");
    const blocks = RECIPES.filter((rec) => haystackBlocked([rec.name, ...rec.ingredients.map((i) => i.name)].join(" "), stored));
    if (blocks.length) why = `allergies became "${r.profile.allergies}", which blocks ${blocks.length}/${RECIPES.length} recipes`;
    else if (meals(r.plan).map((m) => m.name).join() !== meals(PLAN).map((m) => m.name).join()) why = "the week changed";
    else if (stored.length) c.note = `${c.note ? `${c.note}; ` : ""}stored "${r.profile.allergies}", blocks no recipe`;
  }
  if (why) failed++;
  console.log(`${why ? "FAIL" : "pass"}  ${c.expect.padEnd(13)} ${label.padEnd(58)} ${why ?? ""}${c.note ? `  [${c.note}]` : ""}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} cases pass`);
process.exit(failed);
