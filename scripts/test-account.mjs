/**
 * Runs the accounts-lane test suites: `node scripts/test-account.mjs`.
 *
 *  1. `scripts/test-account.mts` — one tab: the export file, the sync rules and engine, storage's
 *     bookkeeping, the REST client, and client.ts end to end against a fake Supabase.
 *  2. `scripts/test-account-tabs.mts` — several tabs of ONE browser plus a phone, each tab its own
 *     instance of the real storage.ts and client.ts (`account-tab.mts`, bundled once per tab with
 *     `window`, `document` and `history` pointed at that tab's own objects).
 *
 * Bundled with esbuild's JS API (the same toolchain `npm run test:engine` uses). Each suite runs in a
 * process of its own, so one failing cannot hide the other, and the exit code is non-zero if either
 * fails, which is what scripts/mutate-account.mjs reads. A runner rather than a `package.json` script,
 * so the accounts lane does not edit a file both lanes share (docs/parallel/README.md §2).
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cache = (name) => resolve("node_modules/.cache", name);
const common = { bundle: true, platform: "node", format: "esm", tsconfig: "tsconfig.json", logLevel: "error" };

await build({ ...common, entryPoints: ["scripts/test-account.mts"], outfile: cache("test-account.mjs") });
// One bundle per PAGE LOAD, named after it, bound to its tab's window. A reload is a fresh module
// instance on the SAME window (so the same sessionStorage): G2 is tab G after a reload.
const PAGES = {
  A: "A", B: "B", C: "C", D: "D", E: "E", F: "F", G: "G", G2: "G", H: "H", K: "K", K2: "K",
  L: "L", L2: "L", L3: "L", L4: "L", M: "M", N: "N", P: "P",
  // the review of batches 4-5 (batch 6): one or two tabs per scenario; Ka2, Ya2, Ya3 are reloads
  Q: "Q", R: "R", S: "S", T: "T", U: "U", V: "V", X: "X", Y: "Y", Z: "Z", W: "W", J: "J", I: "I", O: "O",
  Ca: "Ca", Da: "Da", Cb: "Cb", Db: "Db", Cc: "Cc", Dc: "Dc", Ka1: "Ka", Ka2: "Ka",
  Ya1: "Ya", Ya2: "Ya", Ya3: "Ya", Yb: "Yb", Ga: "Ga", Gb: "Gb",
};
for (const [page, tab] of Object.entries(PAGES)) {
  await build({
    ...common,
    entryPoints: ["scripts/account-tab.mts"],
    outfile: cache(`account-tab-${page}.mjs`),
    define: {
      window: `globalThis.__TAB_${tab}.window`,
      document: `globalThis.__TAB_${tab}.document`,
      history: `globalThis.__TAB_${tab}.history`,
    },
  });
}
await build({ ...common, entryPoints: ["scripts/test-account-tabs.mts"], outfile: cache("test-account-tabs.mjs") });

let failed = false;
for (const suite of ["test-account.mjs", "test-account-tabs.mjs"]) {
  console.log(`\n==== ${suite.replace(".mjs", ".mts")} ====`);
  const r = spawnSync(process.execPath, [cache(suite)], { stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
