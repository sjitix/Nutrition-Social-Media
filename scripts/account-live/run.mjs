/**
 * The LOCAL LIVE RUN of accounts:   node scripts/account-live/run.mjs [--keep]      (from the repo root)
 *
 * Runs the real client.ts and storage.ts against the REAL GoTrue, PostgREST and Postgres, started as
 * user-level binaries in WSL (no Docker and no sudo: neither is on this laptop). The scenarios are in
 * live.mts; what they cover, and why a fake could not, is at its top.
 *
 *   1. setup.sh   fetches the binaries once, into ~/.cache/nutriflow-live in WSL (never into the repo)
 *   2. stack.sh   reset (an empty project every run), then up: Postgres, the platform's roles, GoTrue's
 *                 migrations, THIS repo's migrations, GoTrue, PostgREST, and gateway.mjs on :54321
 *   3. live.mts   bundled with one copy of storage.ts + client.ts per device, run against :54321
 *   4. stack.sh   down (unless --keep, which leaves it up to poke at)
 *
 * The .sh files go to WSL on stdin with their CRs stripped: on a Windows checkout git may give them CRLF
 * line endings, which bash cannot run.
 */
import { build } from "esbuild";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const keep = process.argv.includes("--keep");
const repo = process.cwd();
const distro = ["-d", "Ubuntu", "--"];
const wslRepo = `/mnt/${repo[0].toLowerCase()}${repo.slice(2).replace(/\\/g, "/")}`;
const wslHome = execFileSync("wsl", [...distro, "printenv", "HOME"], { encoding: "utf8" }).trim();
const script = (name) => readFileSync(resolve("scripts/account-live", name), "utf8").replace(/\r\n/g, "\n");
const sh = (name, args = []) =>
  spawnSync("wsl", [...distro, "env", `LIVE_REPO=${wslRepo}`, "bash", "-s", "--", ...args], {
    input: script(name),
    encoding: "utf8",
  });

function must(r, what) {
  if (r.status !== 0) {
    console.error(`${what} failed:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    process.exit(1);
  }
  return r.stdout;
}

console.log("setup: the real servers' binaries (cached after the first run)");
console.log(must(sh("setup.sh"), "setup").trim().split("\n").filter((l) => /^(postgres|gotrue|postgrest|node):/.test(l)).join("\n"));
must(sh("stack.sh", ["reset"]), "reset");

const up = spawn("wsl", [...distro, "env", `LIVE_REPO=${wslRepo}`, "bash", "-s", "--", "up"], { stdio: ["pipe", "pipe", "pipe"] });
up.stdin.end(script("stack.sh"));
let log = "";
await new Promise((ready, fail) => {
  const timer = setTimeout(() => fail(new Error(`the stack did not come up:\n${log}`)), 120_000);
  const see = (chunk) => {
    log += chunk;
    if (log.includes("READY")) {
      clearTimeout(timer);
      ready();
    }
  };
  up.stdout.on("data", see);
  up.stderr.on("data", see);
  up.on("exit", (code) => fail(new Error(`the stack exited (${code}) before it was ready:\n${log}`)));
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
console.log("stack: up (GoTrue, PostgREST, Postgres; gateway on :54321)\n");

/** The gateway as Windows sees it: WSL forwards localhost, sometimes a moment after the server is up. */
async function anonKeyFromGateway() {
  for (let i = 0; ; i++) {
    try {
      return (await (await fetch("http://localhost:54321/__live/anon-key")).json()).anonKey;
    } catch (e) {
      if (i >= 40) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

let status = 1;
try {
  const anonKey = await anonKeyFromGateway();
  const out = (name) => resolve("node_modules/.cache/account-live", name);
  const common = { bundle: true, platform: "node", format: "esm", tsconfig: "tsconfig.json", logLevel: "error" };
  for (const device of ["Lap", "Pho", "Rob", "Late"]) {
    await build({
      ...common,
      entryPoints: ["scripts/account-tab.mts"],
      outfile: out(`account-tab-${device}.mjs`),
      define: {
        window: `globalThis.__TAB_${device}.window`,
        document: `globalThis.__TAB_${device}.document`,
        history: `globalThis.__TAB_${device}.history`,
      },
    });
  }
  await build({ ...common, entryPoints: ["scripts/account-live/live.mts"], outfile: out("live.mjs") });
  status = spawnSync(process.execPath, [out("live.mjs")], {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      LIVE_REPO: wslRepo,
      LIVE_WSL_HOME: wslHome,
    },
  }).status;
} finally {
  if (keep) console.log("\n--keep: the stack is still up on http://localhost:54321 (stack.sh down to stop it)");
  else {
    sh("stack.sh", ["down"]);
    up.kill();
  }
}
process.exit(status ?? 1);
