/**
 * Mutation check for the accounts guards:   node scripts/mutate-account.mjs
 *
 * Breaks one guard at a time, runs the accounts suite, confirms it goes red, and restores the file
 * (always, in a finally). A suite that stays green when a guard is removed is not testing that guard —
 * WORKPLAN lesson 53: three of eight tests passed this way until this script showed it.
 *
 * Each mutation names its anchor exactly; if the code moves and an anchor stops matching, it is reported
 * as SKIP rather than silently passing, and the exit code is non-zero.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MUTATIONS = [
  {
    name: "restore writes null for stores the copy lacks (the old tombstone bug)",
    file: "src/lib/storage.ts",
    from: "    } else {\n      forgetStore(n);\n    }",
    to: "    } else {\n      write(n, null);\n    }",
  },
  {
    name: "an unchanged re-save counts as an edit again",
    file: "src/lib/storage.ts",
    from: "        if (canonical(JSON.parse(current)) === canonical(value)) return;",
    to: "        if (false) return;",
  },
  {
    name: "the mirror starts unpaused (pushes before the first full sync)",
    file: "src/lib/account/client.ts",
    from: "    startPaused: true,",
    to: "    startPaused: false,",
  },
  {
    name: "every pull over local data takes a backup again (no synced check)",
    file: "src/lib/account/merge.ts",
    from: "if (!isEmpty(l.value) && l.at > (synced[name] ?? -Infinity)) needsBackup = true;",
    to: "if (!isEmpty(l.value)) needsBackup = true;",
  },
  {
    name: "a sign-in completes without the verifier this browser kept",
    file: "src/lib/account/client.ts",
    from: "  if (!pending || Date.now() - pending.at > PENDING_SIGN_IN_TTL_MS) {",
    to: "  if (false) {",
  },
  {
    name: "a mirror keeps pushing for whoever is signed in now (no pin)",
    file: "src/lib/account/client.ts",
    from: "  const remote = supabaseRemote(cfg, () => liveSession(cfg, userId));",
    to: "  const remote = supabaseRemote(cfg, () => liveSession(cfg));",
  },
  {
    name: "account rows are written without validation",
    file: "src/lib/account/client.ts",
    from: "  accepts: (n, v) => checkStore(n, v) === null,",
    to: "  accepts: () => true,",
  },
  {
    name: "Delete-everything clears without stopping the sync",
    file: "src/lib/account/client.ts",
    from: "  const s = currentSession();\n  stopRunning();\n  if (cfg && s) {",
    to: "  const s = currentSession();\n  if (cfg && s) {",
  },
  {
    name: "store size counted in UTF-16 units again, not the bytes the server counts",
    file: "src/lib/account/sync.ts",
    from: "  return new TextEncoder().encode(JSON.stringify(value)).length;",
    to: "  return JSON.stringify(value).length;",
  },
  // The clock rule (lesson 57): every stamp another device compares is later than what it replaces.
  {
    name: "a local write is stamped by the raw clock again (earlier than the value it replaces)",
    file: "src/lib/storage.ts",
    from: "  const at = opts.at ?? nextStamp(Date.now(), loadStoreMeta()[name]);",
    to: "  const at = opts.at ?? Date.now();",
  },
  {
    name: "a union is stamped by the raw clock again",
    file: "src/lib/account/merge.ts",
    from: "at: nextStamp(now, Math.max(l.at, r.at)) });",
    to: "at: now });",
  },
  {
    name: "a device holding the whole union pushes it under its own older stamp",
    file: "src/lib/account/merge.ts",
    from: "else if (same(merged, l.value) && l.at > r.at) actions.push(",
    to: "else if (same(merged, l.value)) actions.push(",
  },
  {
    name: "an import is stamped by the raw clock again",
    file: "src/lib/storage.ts",
    from: "importedAt: nextStamp(Date.now(), newest) }",
    to: "importedAt: Date.now() }",
  },
  {
    name: "\"Put it back\" is stamped by the raw clock again",
    file: "src/lib/storage.ts",
    from: "      const at = nextStamp(Date.now(), loadStoreMeta()[n]);",
    to: "      const at = Date.now();",
  },
];

const root = process.argv[2] ?? process.cwd();
let allCaught = true;
for (const m of MUTATIONS) {
  const path = `${root}/${m.file}`;
  const original = readFileSync(path, "utf8");
  const normalised = original.replace(/\r\n/g, "\n");
  if (normalised.split(m.from).length !== 2) {
    console.log(`SKIP (anchor not found exactly once): ${m.name}`);
    allCaught = false;
    continue;
  }
  writeFileSync(path, normalised.replace(m.from, m.to), "utf8");
  let out = "";
  try {
    out = execFileSync("node", ["scripts/test-account.mjs"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String(e.stdout ?? "");
  } finally {
    writeFileSync(path, original, "utf8");
  }
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
  const caught = fails.length > 0;
  if (!caught) allCaught = false;
  console.log(`${caught ? "CAUGHT" : "MISSED"}  ${m.name}`);
  for (const f of fails.slice(0, 3)) console.log(`          ${f.slice(0, 150)}`);
}
console.log(allCaught ? "\nevery mutation was caught" : "\nSOME MUTATIONS WERE NOT CAUGHT");
if (!allCaught) process.exit(1);
