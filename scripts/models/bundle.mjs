/**
 * One way to bundle this lane's evals, shared by fair-arms.mjs and run-controls.mjs, so a measured arm
 * and a harness control always run the same build.
 *
 * SEEDED ENGINE (2026-10-18). The engine picks among near-equal dishes with Math.random during a re-plan
 * (plan/select.ts holds it as `_rng`), and `withSeed` can only wrap a synchronous call, not runAgent. So
 * the same model output could grade differently from run to run: an audit control for pin-then-shake
 * passed 15 of 20 identical runs. Part of the "identical runs swing" variance was the engine's dice, not
 * the model. With `seeded` (the default), esbuild rewrites every `Math.random` in the bundle to a small
 * seeded generator, and the eval reseeds it per scenario (eval-common.ts reseedEngine), so every arm and
 * every control sees the same dice. ENGINE_SEED picks the dice (default 1). Changing ENGINE_SEED over
 * the same script is how a control proves a check does not depend on luck.
 *
 * Without this bundler (a plain `npx esbuild …`) nothing is rewritten and reseedEngine does nothing: the
 * eval runs exactly as before.
 */
import { build } from "esbuild";

// mulberry32, the same generator the engine's own withSeed uses.
const SEEDED_RANDOM = [
  "let __models_s = 1;",
  "function __models_rng() {",
  "  __models_s = (__models_s + 0x6d2b79f5) | 0;",
  "  let t = Math.imul(__models_s ^ (__models_s >>> 15), 1 | __models_s);",
  "  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;",
  "  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;",
  "}",
  "globalThis.__models_reseed = (s) => { __models_s = s | 0; };",
].join("\n");

/**
 * @param {{ entry: string, code: string, outfile: string, seeded?: boolean }} o
 *   entry: the eval file; code: the checkout whose src/ is under test (its tsconfig resolves @/lib);
 *   outfile: where the bundle goes (outside node_modules/.cache, which other lanes share).
 */
export async function bundleEval({ entry, code, outfile, seeded = true }) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: `${code}/tsconfig.json`,
    absWorkingDir: code,
    outfile,
    logLevel: "warning",
    ...(seeded ? { define: { "Math.random": "__models_rng" }, banner: { js: SEEDED_RANDOM } } : {}),
  });
  return outfile;
}
