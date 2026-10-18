/**
 * FAIR ARMS — one command for a speed/quality comparison that can be trusted.
 *
 *   node scripts/models/fair-arms.mjs                       # loop A, B, C, convo A, convo C on the 550B
 *   node scripts/models/fair-arms.mjs --dry-run             # bundle, show the plan and whether a key is there
 *   node scripts/models/fair-arms.mjs --arms C --repeat 3 --only 'heldout|^rate$' --code ../NutriFlow-models-wording
 *   node scripts/models/fair-arms.mjs --url http://127.0.0.1:4011/v1 --model stub-nothing --gap 0 --out <tmp>
 *
 * Why it exists. The "3–4x faster" claim (2026-10-03) was withdrawn because its arms were measured on
 * different code and different clocks. Then the one fair arm that existed (A, 2026-10-03) turned out to
 * be a different bundle too: 26 scenarios before the held-out pair, and before 5c12c4c changed the loop.
 * So this runner makes the fair way the only way:
 * - ONE bundle per eval for every arm, built once from one commit (`--code`, default this checkout). The
 *   bundles' sha256 and both commits go in the manifest. A dirty `src/` or `scripts/models/` is refused
 *   (`--allow-dirty` overrides, and is recorded), because a fair run measures a commit.
 * - ONE arm at a time (the free tier is rate-limited), round-robin across repeats (A1 B1 C1 A2 B2 C2…),
 *   with a cool-down between arms (`--gap`, default 60 s) so one arm's 429 tail does not land in the
 *   next arm's latency. Direct to the host: PACE_STATS is cleared, so every arm is on the wall clock.
 * - Every inherited knob is cleared first (LOCAL_AI_*, FAST_FINISH, ONLY, PACE_STATS…), so an arm is
 *   exactly its definition below and nothing leaks in from the shell.
 * - The key is read from the main folder's .env.local by this script (NVIDIA_API_KEY, else
 *   LOCAL_AI_API_KEY; `--key-var` for another host) and handed to the child's environment as
 *   LOCAL_AI_API_KEY. It never appears on a command line, in a log, in the manifest or in a scorecard.
 * - A manifest is written after EVERY arm (`data/eval-runs/<ts>-fair-arms-<model>.json`), so a run cut
 *   short still leaves a record. An arm with infra failures is marked "not evidence" (lesson 44).
 *
 * Reasoning off is host-specific: the default `--off` is NVIDIA's chat-template switch for the 550B.
 * Another host needs its own (e.g. `--off '{"reasoning_effort":"low"}'`).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEval } from "./bundle.mjs";

const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);
const die = (msg, code = 1) => {
  console.error(`fair-arms: ${msg}`);
  process.exit(code);
};

const OFF = flag("--off", '{"chat_template_kwargs":{"enable_thinking":false}}');
const ARMS = {
  A: { evalKind: "loop", what: "reasoning on", env: {} },
  B: { evalKind: "loop", what: "reasoning off", env: { LOCAL_AI_EXTRA_BODY: OFF } },
  C: { evalKind: "loop", what: "reasoning off + fast finish (reply rule)", env: { LOCAL_AI_EXTRA_BODY: OFF, FAST_FINISH: "reply" } },
  convoA: { evalKind: "convo", what: "reasoning on", env: {} },
  convoB: { evalKind: "convo", what: "reasoning off", env: { LOCAL_AI_EXTRA_BODY: OFF } },
  convoC: { evalKind: "convo", what: "reasoning off + fast finish (reply rule)", env: { LOCAL_AI_EXTRA_BODY: OFF, FAST_FINISH: "reply" } },
};

const arms = flag("--arms", "A,B,C,convoA,convoC").split(",").map((a) => a.trim()).filter(Boolean);
for (const a of arms) if (!(a in ARMS)) die(`unknown arm "${a}" (known: ${Object.keys(ARMS).join(", ")})`, 2);
const repeat = Number(flag("--repeat", "1"));
if (!Number.isInteger(repeat) || repeat < 1) die("--repeat must be a whole number >= 1", 2);
const gapSeconds = Number(flag("--gap", "60"));
const url = flag("--url", "https://integrate.api.nvidia.com/v1");
const model = flag("--model", "nvidia/nemotron-3-ultra-550b-a55b");
const only = flag("--only", "");
const label = flag("--label", "");
const code = resolve(flag("--code", HARNESS));
const out = resolve(flag("--out", HARNESS));
const dryRun = has("--dry-run");
const allowDirty = has("--allow-dirty");
const localHost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);

const git = (dir, args) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) die(`git ${args.join(" ")} failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

// ── the commit under test, and the harness that grades it ──────────────────────────────────────
if (!existsSync(join(code, "tsconfig.json"))) die(`--code ${code} has no tsconfig.json`, 2);
const codeSha = git(code, ["rev-parse", "--short", "HEAD"]);
const harnessSha = git(HARNESS, ["rev-parse", "--short", "HEAD"]);
const codeDirty = git(code, ["status", "--porcelain", "--", "src"]);
const harnessDirty = git(HARNESS, ["status", "--porcelain", "--", "scripts/models"]);
if ((codeDirty || harnessDirty) && !allowDirty && !dryRun) {
  die(
    `uncommitted changes, so this would not measure a commit:\n${[codeDirty && `  ${code}/src:\n${codeDirty}`, harnessDirty && `  scripts/models:\n${harnessDirty}`].filter(Boolean).join("\n")}\n` +
      "Commit them, or pass --allow-dirty (recorded in the manifest).",
  );
}

// ── the key: from the main folder's .env.local, never from the shell or a flag ──────────────────
// NVIDIA_API_KEY first: the APP reads LOCAL_AI_API_KEY, and setting it also switches the app's local
// adapter off JSON-schema enforcement (ai.ts: useResponseFormat = !LOCAL_AI_API_KEY), so the key under
// that name would change how v1's dev server talks to LM Studio. A name the app never reads changes
// nothing. LOCAL_AI_API_KEY still works (the desktop's file used it). Another host: --key-var GROQ_API_KEY.
const mainFolder = git(HARNESS, ["worktree", "list", "--porcelain"]).split("\n")[0].replace(/^worktree /, "");
const envFile = resolve(flag("--env-file", join(mainFolder, ".env.local")));
const keyVars = flag("--key-var") ? [flag("--key-var")] : ["NVIDIA_API_KEY", "LOCAL_AI_API_KEY"];
function readKey(file, name) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`));
    if (!m) continue;
    let v = m[1];
    v = /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v.replace(/\s+#.*$/, "");
    return v || null;
  }
  return null;
}
const keyVar = localHost ? null : keyVars.find((name) => readKey(envFile, name));
const key = keyVar ? readKey(envFile, keyVar) : null;
if (!localHost && !key && !dryRun) {
  die(
    `no ${keyVars.join(" or ")} in ${envFile}.\n` +
      "The owner adds it to that file (gitignored; docs/models/OWNER-TODO.md item 0). Never pass the key on a command line.",
    3,
  );
}

// ── one bundle per eval, built once ─────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bundleDir = join(tmpdir(), "nutriflow-models");
mkdirSync(bundleDir, { recursive: true });
const bundles = {};
for (const kind of new Set(arms.map((a) => ARMS[a].evalKind))) {
  const outfile = join(bundleDir, `models-fair-${kind}-${codeSha}-${stamp}.mjs`);
  // Seeded (bundle.mjs): every arm sees the same engine dice per scenario, so arms differ only by the
  // model's behaviour. ENGINE_SEED from the shell is cleared below; the evals then use seed 1.
  await bundleEval({ entry: join(HARNESS, "scripts", "models", `${kind}-eval.mts`), code, outfile });
  bundles[kind] = { file: outfile, sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex") };
}

const runs = [];
for (let r = 1; r <= repeat; r++) for (const a of arms) runs.push({ arm: a, run: r });

console.log(`fair-arms: ${runs.length} run(s), one at a time — ${runs.map((x) => `${x.arm}${repeat > 1 ? `#${x.run}` : ""}`).join(" ")}`);
console.log(`  model ${model} at ${url}`);
console.log(`  code ${code} @ ${codeSha}${codeDirty ? " (DIRTY)" : ""} · harness @ ${harnessSha}${harnessDirty ? " (DIRTY)" : ""}`);
for (const [k, b] of Object.entries(bundles)) console.log(`  bundle ${k}: ${b.sha256.slice(0, 12)} ${b.file}`);
console.log(`  key: ${localHost ? "not needed (local host)" : key ? `${keyVar} found in ${envFile}` : `MISSING: no ${keyVars.join(" or ")} in ${envFile}`}`);
console.log(`  scorecards -> ${join(out, "data", "eval-runs")}${only ? ` · ONLY=${only}` : ""} · gap ${gapSeconds}s`);
if (dryRun) {
  console.log("\nfair-arms: --dry-run, no model called.");
  process.exit(0);
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const CLEARED = /^(AI_PROVIDER|LOCAL_AI_\w+|FAST_FINISH|ONLY|PACE_STATS|PROMPT_VERSION|LOOP_RETRIES|ANTHROPIC_API_KEY|CLAUDE_MODEL|ENGINE_SEED|MODEL_SCRIPT)$/;
const scoreDir = join(out, "data", "eval-runs");
mkdirSync(scoreDir, { recursive: true });
const modelSlug = model.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase();
const manifestPath = join(scoreDir, `${stamp}-fair-arms-${modelSlug}.json`);
const date = new Date().toISOString().slice(0, 10);

const r1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : null);
const pick = (kind, s) =>
  kind === "loop"
    ? { pass: `${s.pass}/${s.scenarios}`, act: s.actPass, hold: s.holdPass, infra: s.infraFailures, unusable: s.unusableOutput,
        medianWall: r1(s.medianWallSecondsPerMessage), median: r1(s.medianSecondsPerMessage), p90: r1(s.p90SecondsPerMessage), calls: r1(s.meanModelCalls),
        gaveUp: s.gaveUp, guardCaught: s.guardCatches, fastFinishBlocked: s.fastFinishBlockedByEmptyReply }
    : { pass: `${s.pass}/${s.conversations}`, turns: s.turnsPassed, infra: s.infraFailures, unusable: s.unusableOutput,
        medianWall: r1(s.medianWallSecondsPerTurn), median: r1(s.medianSecondsPerTurn), p90: r1(s.p90SecondsPerTurn), calls: r1(s.meanModelCallsPerTurn),
        gaveUp: s.gaveUp, guardCaught: s.guardCatches, fastFinishBlocked: s.fastFinishBlockedByEmptyReply };

const manifest = {
  kind: "fair-arms", ranAt: new Date().toISOString(), model, endpoint: url, clock: "wall clock, direct to the host (PACE_STATS cleared)",
  engineSeed: "seeded bundle (bundle.mjs): seed 1, reseeded per scenario",
  code: { dir: code, sha: codeSha, dirty: Boolean(codeDirty) }, harness: { sha: harnessSha, dirty: Boolean(harnessDirty) },
  bundles: Object.fromEntries(Object.entries(bundles).map(([k, b]) => [k, b.sha256])),
  only: only || null, repeat, gapSeconds, arms: [],
};
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

for (const [i, { arm, run }] of runs.entries()) {
  if (i > 0 && gapSeconds > 0) {
    console.log(`\nfair-arms: cooling down ${gapSeconds}s before ${arm}…`);
    await new Promise((res) => setTimeout(res, gapSeconds * 1000));
  }
  const def = ARMS[arm];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLEARED.test(k)));
  Object.assign(env, def.env, {
    AI_PROVIDER: "local",
    LOCAL_AI_URL: url,
    LOCAL_AI_MODEL: model,
    PROMPT_VERSION: `fair ${date} ${codeSha}: arm ${arm} (${def.what})${repeat > 1 ? ` run ${run}/${repeat}` : ""}${label ? ` · ${label}` : ""}`,
    ...(key ? { LOCAL_AI_API_KEY: key } : {}),
    ...(only ? { ONLY: only } : {}),
  });
  const before = new Set(readdirSync(scoreDir));
  console.log(`\n=== arm ${arm}${repeat > 1 ? ` run ${run}/${repeat}` : ""}: ${def.evalKind}, ${def.what}`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [bundles[def.evalKind].file], { cwd: out, env, stdio: "inherit" });
  const written = readdirSync(scoreDir).filter((f) => !before.has(f) && f.includes(`-${def.evalKind}-`) && f.endsWith(".json"));
  const entry = { arm, run, eval: def.evalKind, what: def.what, extraBody: def.env.LOCAL_AI_EXTRA_BODY ?? null,
    fastFinish: def.env.FAST_FINISH ?? "off", exit: res.status, minutes: Number(((Date.now() - t0) / 60000).toFixed(1)),
    scorecard: written[0] ?? null, summary: null, evidence: false };
  if (written.length === 1) {
    const s = JSON.parse(readFileSync(join(scoreDir, written[0]), "utf8")).summary;
    entry.summary = pick(def.evalKind, s);
    entry.evidence = s.infraFailures === 0;
  } else {
    entry.problem = written.length ? `${written.length} scorecards appeared; expected 1` : "no scorecard was written";
  }
  manifest.arms.push(entry);
  save();
}

// ── the comparison ──────────────────────────────────────────────────────────────────────────────
console.log(`\nfair-arms: ${model} · code ${codeSha} · ${manifestPath}`);
console.log("arm      run  pass     act/turns  hold   median s (wall)  p90 s  calls  infra  evidence");
for (const e of manifest.arms) {
  const s = e.summary;
  if (!s) { console.log(`${e.arm.padEnd(8)} ${String(e.run).padEnd(4)} ${e.problem}`); continue; }
  console.log(
    `${e.arm.padEnd(8)} ${String(e.run).padEnd(4)} ${String(s.pass).padEnd(8)} ${String(s.act ?? s.turns).padEnd(10)} ${String(s.hold ?? "").padEnd(6)} ` +
      `${`${s.median} (${s.medianWall})`.padEnd(16)} ${String(s.p90).padEnd(6)} ${String(s.calls).padEnd(6)} ${String(s.infra).padEnd(6)} ${e.evidence ? "yes" : "NO (infra)"}`,
  );
}
if (repeat > 1) {
  for (const a of arms) {
    const ps = manifest.arms.filter((e) => e.arm === a && e.summary).map((e) => Number(String(e.summary.pass).split("/")[0]));
    if (ps.length) console.log(`  ${a}: pass ${Math.min(...ps)}–${Math.max(...ps)} over ${ps.length} run(s)`);
  }
}
