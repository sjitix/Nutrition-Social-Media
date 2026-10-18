/**
 * THE HARNESS'S OWN TEST: every check in loop-eval and convo-eval must pass the answer it rewards and fail
 * the plausible wrong ones. No model, no network, no key.
 *
 *   node scripts/models/run-controls.mjs                 # every control, engine seed 1
 *   node scripts/models/run-controls.mjs --seeds 5       # each control under 5 engine seeds: luck shows
 *   node scripts/models/run-controls.mjs --only 'lighter|pin'   # scenarios whose id matches
 *
 * A control is a MODEL_SCRIPT file (eval-common.ts scriptedModel) at
 *   scripts/models/controls/<loop|convo>/<scenario id>/<name>.json
 * - `pass-*.json`: the scenario must PASS (for a conversation: every turn).
 * - `fail-*.json`: the scenario must FAIL. `fail-t2-*.json` (convo): and turn 2 must be the turn that fails.
 * - Every scenario also gets the do-nothing turn, implicitly, which must FAIL: a check a model that does
 *   nothing can pass is grading the fixed week, not the model (the rule since 2026-10-03).
 * Each control runs in its own process and temp folder (the eval writes a scorecard to cwd), several at
 * once. Both evals are bundled ONCE, seeded (bundle.mjs), so a control's verdict is reproducible; with
 * --seeds N it must hold under every seed, so a check that passes a wrong answer only on lucky dice is
 * caught. (pin-then-shake passed one wrong answer under 13 of 20 seeds, 2026-10-18.)
 *
 * Why it exists: an audit on 2026-10-18 gave every check a correct answer and 3–4 plausible wrong ones.
 * All 43 correct answers passed, and so did 153 of 337 wrong ones. Those controls are kept here, so a
 * check that is fixed stays fixed. Exit code = the number of controls whose expectation failed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEval } from "./bundle.mjs";

const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTROLS = join(HARNESS, "scripts", "models", "controls");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const only = flag("--only", "") ? new RegExp(flag("--only", ""), "i") : null;
const seeds = Number(flag("--seeds", "1"));
const jobs = Number(flag("--jobs", String(Math.max(2, Math.min(8, cpus().length - 1)))));
const code = resolve(flag("--code", HARNESS));
const verbose = argv.includes("--verbose");

// ── the controls ─────────────────────────────────────────────────────────────────────────────────
const work = [];
for (const kind of ["loop", "convo"]) {
  const dir = join(CONTROLS, kind);
  if (!existsSync(dir)) continue;
  for (const id of readdirSync(dir).sort()) {
    if (only && !only.test(id)) continue;
    const files = readdirSync(join(dir, id)).filter((f) => /^(pass|fail)-.*\.json$/.test(f)).sort();
    for (const f of files) work.push({ kind, id, name: f.replace(/\.json$/, ""), file: join(dir, id, f) });
    work.push({ kind, id, name: "fail-do-nothing (implicit)", file: null });
  }
}
if (!work.length) { console.error(`run-controls: no controls under ${CONTROLS}${only ? ` matching ${only}` : ""}`); process.exit(2); }

const base = mkdtempSync(join(tmpdir(), "nutriflow-models-controls-"));
const empty = join(base, "do-nothing.json");
writeFileSync(empty, "{}");
const bundles = {};
for (const kind of new Set(work.map((w) => w.kind))) {
  bundles[kind] = await bundleEval({ entry: join(HARNESS, "scripts", "models", `${kind}-eval.mts`), code, outfile: join(base, `models-controls-${kind}.mjs`) });
}

function runOne(w, seed, slot) {
  const cwd = join(base, `run-${slot}-${w.kind}-${w.id}-${w.name.replace(/[^a-z0-9-]+/gi, "_")}-s${seed}`);
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, MODEL_SCRIPT: w.file ?? empty, ONLY: `^${w.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, ENGINE_SEED: String(seed), LOOP_RETRIES: "0" };
  for (const k of ["AI_PROVIDER", "LOCAL_AI_URL", "LOCAL_AI_MODEL", "LOCAL_AI_API_KEY", "LOCAL_AI_EXTRA_BODY", "FAST_FINISH", "PACE_STATS"]) delete env[k];
  return new Promise((done) => {
    const child = spawn(process.execPath, [bundles[w.kind]], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => {
      const dir = join(cwd, "data", "eval-runs");
      const card = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".json")) : null;
      if (!card) return done({ error: `no scorecard (${out.trim().split("\n").slice(-2).join(" / ").slice(0, 200)})` });
      const row = JSON.parse(readFileSync(join(dir, card), "utf8")).rows.find((r) => r.id === w.id);
      if (!row) return done({ error: "the scenario did not run (id mismatch?)" });
      rmSync(cwd, { recursive: true, force: true });
      done({ pass: row.pass, turns: row.turns?.map((t) => t.pass) ?? null, reason: row.reason ?? row.turns?.find((t) => !t.pass)?.reason ?? null });
    });
  });
}

/** Does the outcome meet the control's expectation? */
function holds(w, o) {
  if (o.error) return false;
  if (w.name.startsWith("pass-")) return o.pass === true;
  const t = /^fail-t(\d+)-/.exec(w.name);
  if (t && o.turns) return o.pass === false && o.turns[Number(t[1]) - 1] === false;
  return o.pass === false;
}

// ── run, a pool of `jobs` processes ──────────────────────────────────────────────────────────────
const tasks = work.flatMap((w) => Array.from({ length: seeds }, (_, i) => ({ w, seed: i + 1 })));
const results = new Map(work.map((w) => [w, []]));
let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async (_, slot) => {
  while (next < tasks.length) {
    const { w, seed } = tasks[next++];
    const o = await runOne(w, seed, slot);
    results.get(w).push({ seed, ...o, held: holds(w, o) });
  }
}));
rmSync(base, { recursive: true, force: true });

// ── report ───────────────────────────────────────────────────────────────────────────────────────
let broken = 0;
let lastScenario = "";
for (const w of work) {
  const rs = results.get(w).sort((a, b) => a.seed - b.seed);
  const ok = rs.filter((r) => r.held).length;
  const bad = ok < rs.length;
  if (bad) broken++;
  const key = `${w.kind}/${w.id}`;
  if (!bad && !verbose) continue;
  if (key !== lastScenario) { console.log(`\n${key}`); lastScenario = key; }
  const miss = rs.find((r) => !r.held);
  const why = miss ? (miss.error ?? (w.name.startsWith("pass-") ? `failed: ${miss.reason}` : "PASSED, so the check is lenient")) : "";
  console.log(`  ${bad ? "BROKEN" : "ok    "} ${w.name.padEnd(46)} ${seeds > 1 ? `held under ${ok}/${rs.length} seeds  ` : ""}${why}`);
}
const scen = new Set(work.map((w) => `${w.kind}/${w.id}`)).size;
console.log(`\nrun-controls: ${work.length - broken}/${work.length} controls hold across ${scen} scenarios` +
  `${seeds > 1 ? ` under all of ${seeds} engine seeds` : ""} (${((Date.now() - t0) / 1000).toFixed(0)} s, ${jobs} at once)`);
process.exit(Math.min(broken, 255));
