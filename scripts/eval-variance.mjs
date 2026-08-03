/**
 * Run the assistant eval N times and report mean / min / max per metric.  npm run eval:variance
 *
 * WHY THIS EXISTS: even at temperature 0, LM Studio isn't perfectly deterministic — the same model
 * on the same eval wobbles ~1-2 points run to run. A single run once led me to ship the WRONG call
 * (a 65-case eval said v8 beat v9; three runs on a bigger eval showed v9 clearly ahead). So model
 * decisions must be made on a DISTRIBUTION, not one number. This automates that.
 *
 *   MODEL=nutriflow-v11 RUNS=3 ENFORCE=1 npm run eval:variance
 *
 * MODEL   (required) the LM Studio identifier to eval — must be loaded (`lms ps`).
 * RUNS    how many times to run (default 3).
 * ENFORCE=1 passes through to the eval (the production, schema-enforced path).
 */
import { execSync } from "node:child_process";

const MODEL = process.env.MODEL;
const RUNS = Number(process.env.RUNS ?? 3);
if (!MODEL) {
  console.error("Set MODEL=<identifier> (must be loaded in LM Studio). e.g. MODEL=nutriflow-v11 npm run eval:variance");
  process.exit(1);
}

const metrics = ["toolAccuracy", "fieldAccuracy", "clarify/answer"];
const runs = [];

for (let i = 1; i <= RUNS; i++) {
  process.stderr.write(`run ${i}/${RUNS}...\n`);
  let out;
  try {
    out = execSync("npm run eval:assistant", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // esbuild/eval failure still carries stdout
    out = (e.stdout ?? "").toString();
  }
  const r = {};
  for (const m of metrics) {
    // "toolAccuracy      95%"  or  "clarify/answer   11/12"
    const line = out.split("\n").find((l) => l.trim().startsWith(m));
    const val = line?.match(/(\d+)%/) ?? line?.match(/(\d+)\/(\d+)/);
    if (val) r[m] = m.includes("/") ? Number(val[1]) / Number(val[2]) * 100 : Number(val[1]);
  }
  if (Object.keys(r).length) runs.push(r);
  else process.stderr.write("  (no scores parsed — is the model loaded and the server up?)\n");
}

if (!runs.length) { console.error("No successful runs."); process.exit(1); }

const fmt = (x) => x.toFixed(1).replace(/\.0$/, "");
console.log(`\nmodel: ${MODEL}   runs: ${runs.length}   ${process.env.ENFORCE === "1" ? "ENFORCE=1 (production path)" : "unconstrained"}`);
console.log("metric            mean    min    max   spread");
for (const m of metrics) {
  const vals = runs.map((r) => r[m]).filter((v) => v != null);
  if (!vals.length) continue;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals), max = Math.max(...vals);
  console.log(`${m.padEnd(16)} ${fmt(mean).padStart(5)}  ${fmt(min).padStart(5)}  ${fmt(max).padStart(5)}   ±${fmt((max - min) / 2)}`);
}
console.log("\nrule of thumb: a gap between two models under ~2 points is inside the noise — don't decide on it.");
