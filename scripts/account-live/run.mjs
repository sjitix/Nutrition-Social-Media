/**
 * The LOCAL LIVE RUN of accounts, from the repo root:
 *
 *   node scripts/account-live/run.mjs          the run (about 80 s once the binaries are cached)
 *   node scripts/account-live/run.mjs --keep   the run, then the stack stays up until Ctrl+C
 *   node scripts/account-live/run.mjs --down   stop a stack a crash left behind
 *
 * Runs the real client.ts and storage.ts against the REAL GoTrue, PostgREST and Postgres, started as
 * user-level binaries in WSL (no Docker and no sudo: neither is on this laptop). The scenarios are in
 * live.mts; what they cover, and why a fake could not, is at its top.
 *
 *   1. setup.sh   fetches the binaries once, into ~/.cache/nutriflow-live in WSL (never into the repo),
 *                 each checked against its pinned SHA-256
 *   2. stack.sh   reset (an empty project every run), then up: Postgres, the platform's roles, GoTrue's
 *                 migrations, THIS repo's migrations, GoTrue, PostgREST, and gateway.mjs on :54321
 *   3. live.mts   bundled with one copy of storage.ts + client.ts per device, run against :54321
 *   4. the stack goes when its `up` process goes (its own EXIT trap), and `down` sweeps up after it
 *
 * Needs WSL 2 with an x86-64 distro, `Ubuntu` unless LIVE_WSL_DISTRO names another. WSL calls use
 * `--exec`, so no argument is re-read by a Linux shell. The .sh files go to WSL on stdin with their CRs
 * stripped: a Windows checkout can give them CRLF line endings, which bash cannot run.
 */
import { build } from "esbuild";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const keep = process.argv.includes("--keep");
const repo = process.cwd();
const DISTRO = process.env.LIVE_WSL_DISTRO || "Ubuntu";
const distro = ["-d", DISTRO, "--exec"];
const wslEnv = { ...process.env, WSL_UTF8: "1" }; // wsl.exe's own messages in UTF-8, not UTF-16
function wsl(args) {
  try {
    return execFileSync("wsl", [...distro, ...args], { encoding: "utf8", env: wslEnv }).trim();
  } catch (e) {
    console.error(`WSL could not run ${args[0]} in the distro "${DISTRO}" (LIVE_WSL_DISTRO picks another):\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    process.exit(1);
  }
}
const wslRepo = wsl(["wslpath", "-a", repo]);
const wslHome = wsl(["printenv", "HOME"]);
const script = (name) => readFileSync(resolve("scripts/account-live", name), "utf8").replace(/\r\n/g, "\n");
const sh = (name, args = [], opts = {}) =>
  spawnSync("wsl", [...distro, "env", `LIVE_REPO=${wslRepo}`, "bash", "-s", "--", ...args], {
    input: script(name),
    encoding: "utf8",
    env: wslEnv,
    ...opts,
  });

function must(r, what) {
  if (r.status !== 0) {
    console.error(`${what} failed (exit ${r.status}):\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    process.exit(1);
  }
  return r.stdout;
}

if (process.argv.includes("--down")) {
  console.log(must(sh("stack.sh", ["down"]), "down").trim());
  process.exit(0);
}

console.log("setup: the real servers' binaries (fetched and checked once, then cached)");
must(sh("setup.sh", [], { stdio: ["pipe", "inherit", "inherit"] }), "setup");
must(sh("stack.sh", ["reset"]), "reset");

const up = spawn("wsl", [...distro, "env", `LIVE_REPO=${wslRepo}`, "bash", "-s", "--", "up"], { stdio: ["pipe", "pipe", "pipe"], env: wslEnv });
up.stdin.end(script("stack.sh"));
const upExited = new Promise((r) => up.on("exit", r));
let log = "";
const stackId = await new Promise((ready, fail) => {
  const timer = setTimeout(() => fail(new Error(`the stack did not come up:\n${log}`)), 120_000);
  const see = (chunk) => {
    log += chunk;
    const m = log.match(/READY ([0-9a-f]+)/);
    if (m) {
      clearTimeout(timer);
      ready(m[1]);
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

/**
 * The gateway as Windows sees it. WSL forwards localhost, sometimes a moment after the server is up, and
 * Windows' localhost:54321 may belong to something else entirely (another project's `supabase start`),
 * so the answer must carry THIS stack's id.
 */
async function anonKeyFromGateway() {
  let last = "";
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://localhost:54321/__live/anon-key");
      const body = r.ok ? await r.json().catch(() => ({})) : {};
      if (body.stack === stackId && typeof body.anonKey === "string" && body.anonKey.split(".").length === 3) return body.anonKey;
      last = `HTTP ${r.status}, ${body.stack ? `stack ${body.stack}` : "not the live run's gateway"}`;
    } catch (e) {
      last = String(e.cause ?? e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Windows' localhost:54321 is not this run's gateway (${last}). Another server may hold the port, or it may be ` +
      "in a range Windows reserved (netsh int ipv4 show excludedportrange protocol=tcp).",
  );
}

let status = 1;
try {
  const anonKey = await anonKeyFromGateway();
  const secret = wsl(["cat", `${wslHome}/.cache/nutriflow-live/jwt-secret`]); // to mint a truly expired token
  const out = (name) => resolve("node_modules/.cache/account-live", name);
  const common = { bundle: true, platform: "node", format: "esm", tsconfig: "tsconfig.json", logLevel: "error" };
  for (const device of ["Lap", "Pho", "Rob", "Late", "Desk", "Tablet"]) {
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
      // The app prefers this name, so a hosted project's key exported in the shell would win otherwise.
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
      LIVE_JWT_SECRET: secret,
      LIVE_REPO: wslRepo,
      LIVE_WSL_HOME: wslHome,
      LIVE_WSL_DISTRO: DISTRO,
    },
  }).status;
} finally {
  if (keep) {
    console.log("\n--keep: the stack stays up on http://localhost:54321 until you press Ctrl+C");
    await upExited; // Ctrl+C ends this process and its wsl.exe; the stack's EXIT trap takes it down
  } else {
    up.kill(); // its EXIT trap takes the stack down, holding the stack's lock
    await Promise.race([upExited, new Promise((r) => setTimeout(r, 30_000))]);
    sh("stack.sh", ["down"]); // and sweeps up anything the trap could not reach
  }
}
process.exit(status ?? 1);
