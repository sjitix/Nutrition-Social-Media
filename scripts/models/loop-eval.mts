/**
 * LOOP-LEVEL EVAL — the measurement docs/v1/03-kimi-decision.md §6 asked for.
 *
 *   LOCAL_AI_URL=... LOCAL_AI_MODEL=... LOCAL_AI_API_KEY=... AI_PROVIDER=local \
 *     node <bundle of this file>          (scripts/models/run-loop-eval.mjs builds + runs it)
 *
 * `eval:hardcases` grades ONE model call per case. The product runs a LOOP: call, act, read what the
 * engine did, call again, stop. A model can score well on single turns and still be bad at the job —
 * guess instead of looking things up, keep editing after it is done, burn all 8 steps — and the
 * single-turn eval cannot see any of that. Nor can it see the number a person actually feels: the
 * wall-clock time from sending a message to getting the answer, which is per-call latency × steps.
 *
 * So this drives the PRODUCTION path end to end — `runAgent` with the real `agentModelFn()` (same
 * system prompt, same JSON repair, same retries the app uses) — on scenarios whose correct outcome
 * the ENGINE can verify. Nothing here grades prose; every pass/fail is a fact about the plan or
 * profile afterwards, checked with the engine's own matchers (`dietTagConflicts`, `haystackBlocked`).
 *
 * Per scenario: pass, steps, gaveUp, modelFailed (infra — never counted as a model miss), whether a
 * lookup preceded the first write where one was warranted, the operations used, and seconds.
 * Writes data/eval-runs/<ts>-loop-<model>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, MAX_STEPS, type AgentRunResult } from "@/lib/agentLoop";
import { agentModelFn, resolveProvider } from "@/lib/ai";
import { selectWeekFromDb, rebalanceWeek, withSeed } from "@/lib/recipeDb";
import { dietTagConflicts, haystackBlocked } from "@/lib/exclusions";
import { isReadTool } from "@/lib/agentTools";
import type { UserProfile, WeekPlan, Meal } from "@/lib/types";

const MODEL = process.env.LOCAL_AI_MODEL ?? "(unset)";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;

const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
// One fixed week for every model, so scores compare models, not dice rolls.
const PLAN: WeekPlan = withSeed(20261003, () => rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE));
const TODAY = "2026-10-05"; // a Monday

// ── helpers over the result ─────────────────────────────────────────────────────────────────────
const day = (p: WeekPlan, d: string) => p.days.find((x) => x.day === d);
const meal = (p: WeekPlan, d: string, t: string): Meal | undefined => day(p, d)?.meals.find((m) => m.type === t);
const ingNames = (m: Meal) => m.ingredients.map((i) => i.name);
const isVeg = (m: Meal) => dietTagConflicts("vegetarian", ingNames(m)).length === 0;
const isVegan = (m: Meal) => dietTagConflicts("vegan", ingNames(m)).length === 0;
const hay = (m: Meal) => `${m.name} ${m.description} ${ingNames(m).join(" ")}`;
const contains = (m: Meal, tokens: string[]) => haystackBlocked(hay(m), tokens);
const allMeals = (p: WeekPlan) => p.days.flatMap((d) => d.meals);
const sig = (m?: Meal) => (m ? `${m.name}|${m.calories}` : "");
/** Every slot outside `keep` is untouched. On a day the change TOUCHED, only the dish must match —
 *  the engine legitimately rebalances portions of a day's other meals after one of them changes. */
const unchangedExcept = (before: WeekPlan, after: WeekPlan, keep: (d: string, t: string) => boolean) =>
  before.days.every((d) => {
    const touched = d.meals.some((m) => keep(d.day, m.type));
    return d.meals.every((m) => {
      if (keep(d.day, m.type)) return true;
      const a = meal(after, d.day, m.type);
      return touched ? a?.name === m.name : sig(a) === sig(m);
    });
  });
const dayKcal = (p: WeekPlan, d: string) => (day(p, d)?.meals ?? []).reduce((s, m) => s + m.calories, 0);

type Want = "act" | "hold";
interface Scenario {
  id: string;
  /** What a good nutritionist does here. */
  want: Want;
  message: string;
  history?: { user: string; assistant: string }[];
  /** True when a lookup should come BEFORE acting (the model can't know the answer from the prompt alone). */
  expectRead?: boolean;
  /** Engine-verified outcome. Return null for pass, or the reason it failed. */
  check: (r: AgentRunResult, before: WeekPlan) => string | null;
}

const changed = (r: AgentRunResult) => r.planChanged || r.profileChanged;
// A hold may still `remember` a fact (that's good nutritionist behaviour); it may not change the PLAN.
const holdCheck = (r: AgentRunResult) => (r.planChanged ? "changed the plan when it should have held" : null);

const SCENARIOS: Scenario[] = [
  {
    id: "day-vegetarian", want: "act",
    message: "make tuesday vegetarian, leave the other days alone",
    check: (r, b) => {
      const t = day(r.plan, "Tuesday")!.meals;
      if (!t.every(isVeg)) return `Tuesday still has non-veg: ${t.filter((m) => !isVeg(m)).map((m) => m.name).join(", ")}`;
      if (!unchangedExcept(b, r.plan, (d) => d === "Tuesday")) return "touched days other than Tuesday";
      return null;
    },
  },
  {
    id: "every-day-swap", want: "act",
    message: "i want pancakes for breakfast every single day",
    check: (r) => {
      const miss = r.plan.days.filter((d) => !/pancake/i.test(meal(r.plan, d.day, "breakfast")?.name ?? ""));
      return miss.length ? `no pancakes on ${miss.map((d) => d.day).join(", ")}` : null;
    },
  },
  {
    id: "single-slot", want: "act",
    message: "swap just wednesday's dinner for something with salmon",
    check: (r, b) => {
      const m = meal(r.plan, "Wednesday", "dinner");
      if (!m || !contains(m, ["salmon"])) return `Wednesday dinner is "${m?.name}", no salmon`;
      if (!unchangedExcept(b, r.plan, (d, t) => d === "Wednesday" && t === "dinner")) return "changed more than Wednesday dinner";
      return null;
    },
  },
  {
    id: "targets", want: "act",
    message: "keep me at 1800 calories with 160g of protein",
    check: (r) =>
      r.profile.targetCalories === 1800 && r.profile.proteinGrams === 160
        ? null
        : `targets now ${r.profile.targetCalories} kcal / ${r.profile.proteinGrams} g`,
  },
  {
    id: "exclude", want: "act",
    message: "i really can't stand mushrooms, get rid of them",
    check: (r) => {
      const bad = allMeals(r.plan).filter((m) => contains(m, ["mushroom", "mushrooms"]));
      return bad.length ? `still has mushrooms: ${bad.map((m) => m.name).join(", ")}` : null;
    },
  },
  {
    id: "memory-allergy", want: "act",
    history: [{ user: "heads up, i'm allergic to peanuts", assistant: "Noted — I'll keep peanuts out of everything." }],
    message: "add a high-protein snack in the afternoons",
    check: (r) => {
      if (r.profile.mealsPerDay !== 4 && !allMeals(r.plan).some((m) => m.type === "snack")) return "no snack slot added";
      const pb = allMeals(r.plan).filter((m) => contains(m, ["peanut", "peanuts", "peanut butter"]));
      return pb.length ? `peanuts despite the allergy: ${pb.map((m) => m.name).join(", ")}` : null;
    },
  },
  {
    id: "find-then-place", want: "act", expectRead: true,
    message: "find me a vegetarian dinner that takes under 20 minutes and put it on thursday",
    check: (r) => {
      const m = meal(r.plan, "Thursday", "dinner");
      if (!m) return "no Thursday dinner";
      if (!isVeg(m)) return `Thursday dinner "${m.name}" is not vegetarian`;
      if (m.timeMinutes > 20) return `Thursday dinner "${m.name}" takes ${m.timeMinutes} min`;
      return null;
    },
  },
  {
    id: "weekend-lighter", want: "act",
    message: "lighter meals on the weekend please, i'm way less active then",
    check: (r, b) => {
      const sat = dayKcal(r.plan, "Saturday") < dayKcal(b, "Saturday") - 50;
      const sun = dayKcal(r.plan, "Sunday") < dayKcal(b, "Sunday") - 50;
      return sat && sun ? null : `weekend not lighter (Sat ${dayKcal(b, "Saturday")}→${dayKcal(r.plan, "Saturday")}, Sun ${dayKcal(b, "Sunday")}→${dayKcal(r.plan, "Sunday")})`;
    },
  },
  {
    id: "lookup-question", want: "hold", expectRead: true,
    message: "what exactly is in monday's dinner, and how much protein does it have?",
    check: (r) => holdCheck(r),
  },
  {
    id: "general-qa", want: "hold",
    message: "is quinoa actually better for me than white rice?",
    check: (r) => holdCheck(r),
  },
  {
    id: "emotional", want: "hold",
    message: "i'm on my period and feeling really drained",
    check: (r) => holdCheck(r),
  },
  {
    id: "vague-goal", want: "hold",
    message: "help me lose weight",
    check: (r) => holdCheck(r),
  },
  {
    id: "contradiction", want: "hold",
    message: "make the whole week vegan but put chicken on friday",
    check: (r) => {
      if (!changed(r)) return null;
      // Acting is acceptable ONLY if it resolved honestly: a fully vegan week with no chicken.
      const vegan = allMeals(r.plan).every(isVegan);
      return vegan ? null : "built a broken 'vegan' week (or added chicken) instead of flagging the clash";
    },
  },
  {
    id: "unsupported", want: "hold",
    message: "set me up for 16:8 fasting, nothing before noon",
    check: (r) => holdCheck(r),
  },
];

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
if (resolveProvider() !== "local") {
  console.error("Set AI_PROVIDER=local and LOCAL_AI_URL/LOCAL_AI_MODEL — this eval drives the local adapter.");
  process.exit(1);
}
const model = agentModelFn();
const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.test(s.id));
console.log(`\nloop eval · model ${MODEL} · ${scenarios.length} scenarios · max ${MAX_STEPS} steps\n`);

interface Row {
  id: string; want: Want; pass: boolean; infra: boolean; reason: string | null;
  steps: number; gaveUp: boolean; modelFailed: boolean; seconds: number;
  readFirst: boolean | null; ops: string[]; reply: string;
}
const rows: Row[] = [];

for (const s of scenarios) {
  const before = structuredClone(PLAN);
  const history = (s.history ?? []).flatMap((h) => [
    { role: "user" as const, content: h.user },
    { role: "assistant" as const, turn: { thinking: "", reply: h.assistant, operations: [] } },
  ]);
  const t0 = performance.now();
  let r: AgentRunResult;
  try {
    r = await runAgent({ profile: structuredClone(PROFILE), plan: structuredClone(PLAN), message: s.message, history, today: TODAY, model });
  } catch (e) {
    rows.push({ id: s.id, want: s.want, pass: false, infra: true, reason: `threw: ${(e as Error).message}`, steps: 0, gaveUp: false, modelFailed: true, seconds: (performance.now() - t0) / 1000, readFirst: null, ops: [], reply: "" });
    console.log(`!! ${s.id.padEnd(18)} threw`);
    continue;
  }
  const seconds = (performance.now() - t0) / 1000;

  const opsSeq: string[] = [];
  let firstRead = -1, firstWrite = -1;
  for (const e of r.transcript) {
    if (e.role !== "assistant") continue;
    for (const o of e.turn.operations) {
      const name = String((o as { op?: string }).op ?? "?");
      const idx = opsSeq.push(name) - 1;
      if (isReadTool(name)) { if (firstRead < 0) firstRead = idx; }
      else if (firstWrite < 0) firstWrite = idx;
    }
  }
  const readFirst = s.expectRead ? firstRead >= 0 && (firstWrite < 0 || firstRead < firstWrite) : null;

  const infra = r.modelFailed;
  const reason = infra ? "model unreachable / failed (infra)" : s.check(r, before);
  const pass = !infra && reason === null;
  rows.push({ id: s.id, want: s.want, pass, infra, reason, steps: r.steps, gaveUp: r.gaveUp, modelFailed: r.modelFailed, seconds, readFirst, ops: opsSeq, reply: r.reply.replace(/\s+/g, " ").slice(0, 200) });
  console.log(`${pass ? "✓ " : infra ? "!!" : "✗ "} ${s.id.padEnd(18)} ${seconds.toFixed(1).padStart(6)}s  ${r.steps} step${r.steps === 1 ? " " : "s"}${r.gaveUp ? " GAVE-UP" : ""}  [${opsSeq.join(",") || "no ops"}]${reason ? `  — ${reason}` : ""}`);
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────────
const graded = rows.filter((r) => !r.infra);
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
const secs = graded.map((r) => r.seconds).sort((a, b) => a - b);
const q = (p: number) => (secs.length ? secs[Math.min(secs.length - 1, Math.floor(p * secs.length))] : null);
const readCases = graded.filter((r) => r.readFirst !== null);
const summary = {
  scenarios: rows.length,
  infraFailures: rows.length - graded.length,
  trustworthy: rows.length === graded.length,
  pass: graded.filter((r) => r.pass).length,
  passRate: pct(graded.filter((r) => r.pass).length, graded.length),
  actPass: `${graded.filter((r) => r.want === "act" && r.pass).length}/${graded.filter((r) => r.want === "act").length}`,
  holdPass: `${graded.filter((r) => r.want === "hold" && r.pass).length}/${graded.filter((r) => r.want === "hold").length}`,
  readBeforeWrite: `${readCases.filter((r) => r.readFirst).length}/${readCases.length}`,
  gaveUp: graded.filter((r) => r.gaveUp).length,
  meanSteps: graded.length ? +(graded.reduce((s, r) => s + r.steps, 0) / graded.length).toFixed(2) : null,
  medianSecondsPerMessage: q(0.5),
  p90SecondsPerMessage: q(0.9),
  maxSecondsPerMessage: secs.length ? secs[secs.length - 1] : null,
};

console.log(`\npass ${summary.pass}/${graded.length} (${summary.passRate}%)  · act ${summary.actPass}  · hold ${summary.holdPass}  · read-before-write ${summary.readBeforeWrite}`);
console.log(`steps mean ${summary.meanSteps}  · gave up ${summary.gaveUp}  · per-message seconds: median ${summary.medianSecondsPerMessage?.toFixed(1)}  p90 ${summary.p90SecondsPerMessage?.toFixed(1)}  max ${summary.maxSecondsPerMessage?.toFixed(1)}`);
if (!summary.trustworthy) console.log(`!! ${summary.infraFailures} scenario(s) never reached the model — not counted as misses; re-run before quoting.`);

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(process.cwd(), "data", "eval-runs");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${ts}-loop-${MODEL.replace(/[^a-z0-9.-]+/gi, "-")}.json`);
writeFileSync(out, JSON.stringify({ kind: "loop-eval", ranAt: new Date().toISOString(), model: MODEL, endpoint: process.env.LOCAL_AI_URL, maxSteps: MAX_STEPS, summary, rows }, null, 2));
console.log(`wrote ${out}`);
