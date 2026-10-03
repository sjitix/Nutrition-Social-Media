/**
 * Re-grade existing hard-case scorecards under a stricter DO rule, without re-running any model.
 *
 *   node scripts/models/regrade-hardcases.mjs [filename-regex]      (default: every scorecard)
 *
 * Why: `actedRight` / `actedRightV2` grade a DO case right when the model EMITTED an operation. On
 * 2026-10-03 that turned out to over-count: a slot-scoped constrain is a no-op in the engine
 * (`expandConstrain` returned [] for it), so `per-slot-protein` was graded right for nearly every
 * model while the plan did not move — and the user was told it had. The scorecards already record
 * `changed` (did the engine move the plan or profile) per case, so a stricter grade can be computed
 * from them after the fact:
 *
 *   v3 — a DO case whose expected outcome is a change counts only if the engine changed something;
 *        the four read-only DO cases (advice, hydration, explain, a plain question) and every hold
 *        case are graded as v2 grades them.
 *
 * This is a PROPOSAL for v1's ruler (scripts/eval-hardcases.mts is v1's file), computed here so it
 * can be judged on real numbers first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** DO cases whose expected text asks for no plan change (data/hard-cases.json `expected`). */
const READ_ONLY_DO = new Set(["substitute-advice", "hydration-profile", "explain-slot", "general-qa"]);

const dir = join(process.cwd(), "data", "eval-runs");
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !/latency|loop-|convo-|pace-/.test(f) && (!filter || filter.test(f)))
  .sort();

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
for (const f of files) {
  let j;
  try { j = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
  if (!Array.isArray(j.results) || !j.summary) continue;
  const graded = j.results.filter((r) => !r.infra);
  let v1 = 0, v2 = 0, v3 = 0;
  const emptyActs = [];
  for (const r of graded) {
    if (r.actedRight) v1++;
    const r2 = r.actedRightV2 ?? r.actedRight; // scorecards from before v2 existed carry only v1
    if (r2) v2++;
    if (r.bucket === "do" && !READ_ONLY_DO.has(r.id)) {
      if (r.actedRight && r.changed) v3++;
      else if (r.actedRight) emptyActs.push(r.id);
    } else if (r2) v3++;
  }
  const model = String(j.model).replace(/^.*\//, "").slice(0, 26);
  const note = j.variant ? ` (${String(j.variant).slice(0, 40)})` : "";
  console.log(`${f.slice(0, 19)}  ${model.padEnd(26)} n=${graded.length}  v1 ${pct(v1, graded.length).padStart(4)}  v2 ${pct(v2, graded.length).padStart(4)}  v3 ${pct(v3, graded.length).padStart(4)}${note}`);
  if (emptyActs.length) console.log(`${" ".repeat(21)}acted, engine changed nothing: ${emptyActs.join(", ")}`);
}
