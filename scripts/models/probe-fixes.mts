/**
 * A model-free re-check of the two product bugs this lane found on 2026-10-03, which v1 fixed in
 * 5c12c4c. Each probe drives the REAL agent loop and composeReply (what /api/assistant-v2 runs) with a
 * scripted model, so it measures the app, not a model. No network, no key.
 *
 *   npx esbuild scripts/models/probe-fixes.mts --bundle --platform=node --format=esm \
 *     --tsconfig=tsconfig.json --outfile=<tmp>/models-probe-fixes.mjs && node <tmp>/models-probe-fixes.mjs
 *
 * Bundled against code from BEFORE the fix (pass another worktree's tsconfig), probes 1–3 must fail;
 * against 5c12c4c or later all four must pass. That pair is what shows a probe can tell the bug from
 * the fix. Probe 4 is the control: an honest memory must cost no extra call, before and after.
 * Exit code = the number of failed probes.
 */
import { runAgent, claimsChange, type AgentRunResult, type AgentTurn, type ModelFn } from "@/lib/assistant";
import { selectWeekFromDb, rebalanceWeek, withSeed, RECIPES } from "@/lib/plan";
import type { UserProfile, WeekPlan } from "@/lib/core";

// The loop eval's fixed profile and week, so these probes run on the same week the evals grade.
const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const PLAN: WeekPlan = withSeed(20261003, () => rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE));

const turn = (reply: string, operations: unknown[] = []): AgentTurn =>
  ({ thinking: "", reply, operations }) as unknown as AgentTurn;
/** Answers the loop's calls in order; any call past the script repeats the last turn. */
const scripted = (turns: AgentTurn[]) => {
  let calls = 0;
  const model: ModelFn = async () => turns[Math.min(calls++, turns.length - 1)];
  return { model, calls: () => calls };
};
const names = (p: WeekPlan, d: string) => (p.days.find((x) => x.day === d)?.meals ?? []).map((m) => `${m.type}:${m.name}`);
const breakfast = (p: WeekPlan, d: string) => p.days.find((x) => x.day === d)?.meals.find((m) => m.type === "breakfast")?.name;
const memoryOf = (r: AgentRunResult) => JSON.stringify(r.profile.memory ?? []);

const LATE = ["Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const inPlan = new Set(PLAN.days.flatMap((d) => d.meals.map((m) => m.name)));
// A breakfast the profile allows and the week does not hold yet, so a real swap has to change something.
const dish = RECIPES.find((r) => r.type === "breakfast" && !inPlan.has(r.name) && r.timeMinutes <= 30 && r.ingredients.length <= 8)?.name;
if (!dish) throw new Error("probe-fixes: no breakfast to swap in; the library changed");

const CLAIM = "Done! I've made your whole week vegetarian.";
const REMEMBER = { op: "remember", fact: "wants to eat less meat", kind: "preference" };

interface Probe { id: string; bug: string; run: () => Promise<string | null> }
const PROBES: Probe[] = [
  {
    id: "swap-wed-sun",
    bug: "a swap with days Wednesday–Sunday replaced all seven days (the 550B's turn, 2026-10-03)",
    run: async () => {
      const m = scripted([turn("", [{ op: "swap", dish, slot: "breakfast", days: LATE }]), turn("")]);
      const r = await runAgent({ profile: structuredClone(PROFILE), plan: structuredClone(PLAN), message: "swap breakfast from wednesday to sunday", model: m.model });
      const touched = ["Monday", "Tuesday"].filter((d) => names(r.plan, d).join() !== names(PLAN, d).join());
      if (touched.length) return `${touched.join(" and ")} changed too (${touched.map((d) => `${breakfast(PLAN, d)} -> ${breakfast(r.plan, d)}`).join("; ")})`;
      const swapped = LATE.filter((d) => breakfast(r.plan, d) !== breakfast(PLAN, d));
      if (!swapped.length) return "no Wednesday–Sunday breakfast changed (a do-nothing result)";
      if (/every day/i.test(r.reply)) return `the reply still says "every day": ${r.reply.slice(0, 160)}`;
      return null;
    },
  },
  {
    id: "claim-on-remember",
    bug: "a claim paired with `remember` reached the user: the memory counted as a change that backed it",
    run: async () => {
      // A stubborn model: the same claim on every call, including after a nudge.
      const m = scripted([turn(CLAIM, [REMEMBER]), turn(CLAIM)]);
      const r = await runAgent({ profile: structuredClone(PROFILE), plan: structuredClone(PLAN), message: "i want to eat less meat", model: m.model });
      if (r.planChanged) return "the plan changed (the probe expects only a memory)";
      if (!/less meat/.test(memoryOf(r))) return "the memory was not kept";
      if (claimsChange(r.reply)) return `the user read the false claim: "${r.reply}"`;
      return null;
    },
  },
  {
    id: "claim-on-remember-recovers",
    bug: "the same, when the model would have retracted if nudged: the nudge never came",
    run: async () => {
      const honest = "I've noted that you'd like to eat less meat. Want me to make the whole week vegetarian?";
      const m = scripted([turn(CLAIM, [REMEMBER]), turn(CLAIM), turn(honest)]);
      const r = await runAgent({ profile: structuredClone(PROFILE), plan: structuredClone(PLAN), message: "i want to eat less meat", model: m.model });
      if (r.reply.trim() !== honest) return `the user read "${r.reply}" instead of the model's retraction (${m.calls()} model calls)`;
      return null;
    },
  },
  {
    id: "honest-remember (control)",
    bug: "none: an honest confirmation must not be nudged, before or after the fix",
    run: async () => {
      const honest = "Got it, I'll keep in mind that you'd like to eat less meat.";
      const m = scripted([turn(honest, [REMEMBER]), turn(honest)]);
      const r = await runAgent({ profile: structuredClone(PROFILE), plan: structuredClone(PLAN), message: "i want to eat less meat", model: m.model });
      if (m.calls() !== 2) return `${m.calls()} model calls; an honest confirmation should take 2 (write, finish)`;
      if (r.reply.trim() !== honest) return `the user read "${r.reply}"`;
      return null;
    },
  },
];

let failed = 0;
console.log(`probe-fixes: the swap dish is "${dish}"`);
for (const p of PROBES) {
  const why = await p.run();
  if (why) failed++;
  console.log(`${why ? "FAIL" : "pass"}  ${p.id.padEnd(28)} ${why ?? ""}`);
  if (why) console.log(`      bug: ${p.bug}`);
}
console.log(`\n${PROBES.length - failed}/${PROBES.length} probes pass`);
process.exit(failed);
