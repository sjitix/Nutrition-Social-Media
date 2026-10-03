/**
 * Runs the accounts-lane test suite: `node scripts/test-account.mjs`.
 *
 * Bundles `scripts/test-account.mts` with esbuild's JS API (the same toolchain `npm run test:engine`
 * uses) and executes it. It exists as a runner rather than a `package.json` script so the accounts
 * lane does not have to edit a file both lanes share (docs/parallel/README.md §2); it can become
 * `npm run test:account` whenever that is convenient.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const out = resolve("node_modules/.cache/test-account.mjs");
await build({
  entryPoints: ["scripts/test-account.mts"],
  bundle: true,
  platform: "node",
  format: "esm",
  tsconfig: "tsconfig.json",
  outfile: out,
  logLevel: "error",
});
await import(pathToFileURL(out).href);
