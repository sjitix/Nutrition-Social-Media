/**
 * Commit and push a named set of paths, gated first, verified after — without ever borrowing the
 * shared index, the stash stack or anyone else's uncommitted work.
 *
 *   node scripts/ship.mjs --message-file msg.txt -- src/lib/foo.ts docs/bar.md
 *   node scripts/ship.mjs --message "short message" --no-gate -- docs/bar.md
 *   node scripts/ship.mjs --onto main --message-file msg.txt -- <paths>   (from a worktree on another branch)
 *   node scripts/ship.mjs --resume [--onto main]      (push the one commit a failed ship left behind)
 *   --dry-run shows what would be committed and which gates would run, and stops before the gate.
 *
 * WHY IT EXISTS. On 2026-10-03 a day's work landed on origin/main under an unrelated commit message:
 * it sat staged in `.git/index` — SHARED STATE for the whole working directory — through a 25-minute
 * gate, and a commit made from elsewhere swept it in (WORKPLAN lesson 47). Version 1 of this script
 * fixed that with `git commit --only`. An adversarial audit on 2026-10-18 (three auditors, a skeptic
 * for each, and a completeness critic, every finding reproduced in a scratch repository) then found 45
 * more ways version 1 could push the wrong thing, miss an overlap, lose a staged version, write
 * conflict markers into another lane's file, or strand a commit while telling the agent to "run ship
 * again". This is the redesign that closes them; `node scripts/test-ship.mjs` replays each scenario.
 *
 *  1. FILES, NOT ARGUMENT STRINGS. Every comparison is between file lists git produced, with renames
 *     off, quoting off, every untracked file listed and pathspecs literal: a new folder, a move, a
 *     `git mv`, a non-ASCII name, "./x", "dir/" and "dir\x" are all exactly the files they name.
 *  2. NOTHING ELSE RIDES ALONG. Unpushed commits stop it (`--resume` pushes one stranded commit, and
 *     gates it first unless ship made it). An unmerged path stops it. Under a gated ship, uncommitted
 *     files the selected gates READ stop it, because the gate would test work the commit lacks.
 *  3. A SNAPSHOT, NOT A STAGING WINDOW. The commit's tree is built from the named files BEFORE the
 *     gate, in a private index; the shared index is never staged into. After the gate the files are
 *     read again, and if any changed nothing is committed (the gate may have tested another version).
 *     The branch then moves by compare-and-swap, so a commit made here meanwhile stops ship instead of
 *     riding out under its message. The message is read once, at the start.
 *  4. NO STASH, NO PULL. If the remote moved, the commit is rebuilt on top of it in a private index,
 *     after checking the remote touched none of its files, and that is what is pushed. The folder then
 *     catches up the way `git checkout` carries local changes (a two-tree read-tree), which REFUSES
 *     rather than merges when the remote changed a file that has local edits: no uncommitted file gains
 *     conflict markers, no staged version is lost.
 *  5. TRUTHFUL ENDINGS. The exit code says what is true now:
 *       0  pushed, and the local branch matches what was pushed
 *       1  nothing was committed: usage, validation, nothing to commit, an error, or the gate failed
 *       2  nothing was committed: stopped on purpose (the remote changed the same files, unpushed
 *          commits, unrelated uncommitted work under the gate, a file edited or a commit made while the
 *          gate ran)
 *       3  COMMITTED LOCALLY, NOT PUSHED. It says why; once fixed: `node scripts/ship.mjs --resume`
 *       4  pushed, but the local branch could not catch up without touching local edits (it says how)
 *
 * Known limit, by design: the gate runs on this tree's base. If the remote moved meanwhile, what lands
 * (their commits + this one) is a combination no local gate ran; the overlap rule keeps the two from
 * touching the same file, and CI (.github/workflows/gates.yml) runs every gate on what lands on main.
 *
 * It never force-pushes, never amends, never stashes, and never commits a path it was not given.
 * SHIP_GATE_HOOK (test-only, honoured only for repositories under the OS temp folder) replaces the gate
 * commands with one node script, so the harness can act "during the gate".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep as SEP } from "node:path";

// ---- exits ------------------------------------------------------------------------------------------
const EXIT = { NOTHING: 1, STOPPED: 2, STRANDED: 3, PUSHED_LOCAL_BEHIND: 4 };
function die(msg, code = EXIT.NOTHING) {
  console.error(`\nship: ${msg}\n`);
  process.exit(code);
}

// ---- flags: strict, so a forgotten value never swallows the next flag or becomes a public message ------
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const flagArgs = dashdash === -1 ? argv : argv.slice(0, dashdash);
const rawPaths = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const VALUE_FLAGS = new Set(["--message-file", "--message", "--onto"]);
const BOOL_FLAGS = new Set(["--no-gate", "--dry-run", "--resume", "--allow-unrelated-dirty"]);
const USAGE = "Usage: ship.mjs --message-file m.txt [--no-gate] [--dry-run] [--onto <branch>] -- <paths...>   |   ship.mjs --resume [--onto <branch>]";
const opt = {};
for (let i = 0; i < flagArgs.length; i++) {
  let name = flagArgs[i];
  let value;
  const eq = name.indexOf("=");
  if (name.startsWith("--") && eq > 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
  if (BOOL_FLAGS.has(name)) {
    if (value !== undefined) die(`${name} takes no value.`);
    opt[name] = true;
  } else if (VALUE_FLAGS.has(name)) {
    if (value === undefined) value = flagArgs[++i];
    if (value === undefined || value.trim() === "") die(`${name} needs a value.`);
    if (value.startsWith("--")) die(`${name}'s value looks like a flag ("${value}").${name === "--message" ? " Put a message that starts with -- in a --message-file." : ""}`);
    opt[name] = value;
  } else {
    die(`unknown argument "${name}" (paths go after --). ${USAGE}`);
  }
}
const resume = !!opt["--resume"];
const dryRun = !!opt["--dry-run"];
if (resume && (rawPaths.length || opt["--message"] || opt["--message-file"])) die("--resume pushes the one unpushed commit as it is: it takes no paths and no message.");

// ---- git: never through a shell (paths come from the command line); quoting off; pathspecs literal ---
// Literal pathspecs only for ship's own calls: a hook or a gate that globs must keep its globs.
function git(args, { env = {}, ...opts } = {}) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env },
  }).replace(/\n$/, "");
}
function gitOk(args, { env = {}, ...opts } = {}) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env },
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: r.stderr ?? "" };
}
const nul = (s) => s.split("\0").filter(Boolean);
/** Files that differ between two trees or commits — renames off, so a move is its two paths. */
const changedBetween = (a, b) => nul(git(["diff", "--name-only", "--no-renames", "-z", a, b]));
const isAncestor = (a, b) => gitOk(["merge-base", "--is-ancestor", a, b]).ok;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tmpFile = (tag) => join(tmpdir(), `ship-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`);

/** `git fetch`, retried while another worktree's fetch holds the ref lock (worktrees share one .git). */
function fetchOrigin() {
  for (let attempt = 0; ; attempt++) {
    const r = gitOk(["fetch", "origin"]);
    if (r.ok) return;
    if (attempt < 4 && /lock|unable to create/i.test(r.err)) { sleep(400 * 2 ** attempt); continue; }
    throw new Error(`git fetch origin failed:\n${r.err.trim()}`);
  }
}

/**
 * Run a gate command with its output passed straight through.
 *
 * npm and npx need a shell on Windows, and not by choice: they are .cmd shims, and since the 2024 CVE
 * fix Node refuses to spawn a .cmd without one — `execFileSync("npx.cmd", ...)` fails with EINVAL
 * (measured here, not assumed). Their arguments in this file are fixed literals, so nothing from the
 * command line ever reaches a shell. Git never goes through one.
 */
function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const viaShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  execFileSync(cmd, args, { stdio: "inherit", shell: viaShell });
}

/** git's own "whitespace" cleanup, which `git commit -F` applied and commit-tree does not. */
function cleanMessage(msg) {
  const out = [];
  for (const line of msg.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""))) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

// ---- preflight ------------------------------------------------------------------------------------------
if (gitOk(["rev-parse", "--is-inside-work-tree"]).out !== "true") die("not inside a git working tree.");
if (gitOk(["rev-parse", "--show-prefix"]).out !== "") die("run ship from the repository root: every path is compared root-relative.");
const ROOT = git(["rev-parse", "--show-toplevel"]);
if (process.env.SHIP_GATE_HOOK) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const norm = (p) => (process.platform === "win32" ? real(p).toLowerCase() : real(p));
  if (!norm(ROOT).startsWith(norm(tmpdir()) + SEP)) die("SHIP_GATE_HOOK replaces the gate and is honoured only in scripts/test-ship.mjs's scratch repositories. Unset it.");
}
for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
  if (existsSync(git(["rev-parse", "--git-path", marker]))) die(`a ${marker.replace(/_HEAD$/, "").replace(/[-_]/g, " ").toLowerCase()} is in progress in this tree. Finish or abort it first.`);
}
const currentBranch = gitOk(["symbolic-ref", "--quiet", "--short", "HEAD"]).out; // "" when detached
const branch = opt["--onto"] ?? currentBranch;
if (!branch) die("HEAD is detached, so there is no branch to land on. Check out a branch, or name the remote branch with --onto <branch>.");
const HEAD_REF = currentBranch ? `refs/heads/${currentBranch}` : "HEAD";
const retry = `node scripts/ship.mjs --resume${opt["--onto"] ? ` --onto ${opt["--onto"]}` : ""}`;

console.log("\nship: fetching origin…");
try { fetchOrigin(); } catch (e) { die(String(e.message)); }
const remoteRef = `refs/remotes/origin/${branch}`;
if (!gitOk(["rev-parse", "--verify", "--quiet", remoteRef]).ok) die(`origin has no branch "${branch}". ${opt["--onto"] ? "Check the --onto value." : "Name the target with --onto <branch>."}`);

let message = null;
if (!resume) {
  if (!opt["--message-file"] && !opt["--message"]) die("need --message-file <file> or --message <text>.");
  if (opt["--message-file"] && opt["--message"]) die("give --message-file or --message, not both.");
  if (opt["--message-file"] && !existsSync(opt["--message-file"])) die(`message file not found: ${opt["--message-file"]}`);
  // Read ONCE, now: a message file rewritten while the gate runs must not become this commit's message.
  const raw = opt["--message-file"] ? readFileSync(opt["--message-file"], "utf8").replace(/^﻿/, "") : opt["--message"];
  if (/�|\0/.test(raw)) die("the message is not plain UTF-8 text (saved as UTF-16?).");
  message = cleanMessage(raw);
  if (!message.trim()) die("the commit message is empty.");
}

const HEAD0 = git(["rev-parse", "HEAD"]);
const unpushed = git(["log", "--format=%h %s", `${remoteRef}..HEAD`]).split("\n").filter(Boolean);

// ---- the gate -------------------------------------------------------------------------------------------
// Each gate runs when the commit changes a file it READS (tsc always runs), and `needs` skips it quietly
// on a branch that predates it rather than failing on a missing file. Cheap gates first, so a layering
// or type mistake fails before the 25-minute engine suite starts.
const DATA = new Set(["scripts/ingredient-map.json", "scripts/food-units.json", "scripts/check-recipes.mts", "scripts/check-ingredients.mts"]);
const TYPES_CONFIG = new Set(["tsconfig.json", "tsconfig.scripts.json", "next-env.d.ts", "package.json", "package-lock.json"]);
const engineReads = (f) => f.startsWith("src/lib/") || f === "scripts/test-engine.mts" || f === "scripts/food-units.json";
const GATES = [
  // The module boundaries take about a second.
  { name: "check:boundaries", reads: (f) => f.startsWith("src/") || f === "scripts/check-boundaries.mjs", cmd: ["node", ["scripts/check-boundaries.mjs"]], needs: ["scripts/check-boundaries.mjs"] },
  // The gate that changed is the gate under suspicion: a check that has only ever passed proves nothing.
  { name: "check:boundaries --self-test", reads: (f) => f === "scripts/check-boundaries.mjs", cmd: ["node", ["scripts/check-boundaries.mjs", "--self-test"]], needs: ["scripts/check-boundaries.mjs"] },
  // The DATA gates (V1 D5b): every ingredient priced and weighable, every dish plausible, Atwater holds,
  // every reference resolves to a curated slug. check:recipes had passed for months while NOTHING ran it.
  { name: "check:recipes", reads: (f) => f.startsWith("src/lib/") || DATA.has(f), cmd: ["npm", ["run", "check:recipes"]], needs: ["scripts/check-recipes.mts"] },
  { name: "check:ingredients", reads: (f) => f.startsWith("src/lib/") || DATA.has(f), cmd: ["npm", ["run", "check:ingredients"]], needs: ["scripts/check-ingredients.mts"] },
  // The imagery (V1 D10): every photograph mapped to exactly one real recipe, every file used, none twice. A wrong
  // key fails silently in the app (the card shows a tile), so only a gate can see it. It reads the recipe names too.
  { name: "check:images", reads: (f) => f.startsWith("public/food/") || f.startsWith("src/lib/") || f === "scripts/check-images.mts", cmd: ["npm", ["run", "check:images"]], needs: ["scripts/check-images.mts"] },
  { name: "check:images --self-test", reads: (f) => f === "scripts/check-images.mts", cmd: ["npm", ["run", "check:images", "--", "--self-test"]], needs: ["scripts/check-images.mts"] },
  // TYPES, always. The esbuild-bundled suites do not check that an imported TYPE exists, so a narrowed
  // barrel or a removed shim used to pass every gate and fail only at Vercel's `next build` (D5a review,
  // 2026-10-03). tsconfig.scripts.json is src/ plus scripts/, whose .mts the app's tsconfig never sees.
  { name: "tsc", always: true, reads: (f) => f.startsWith("src/") || /^scripts\/.+\.m?ts$/.test(f) || TYPES_CONFIG.has(f),
    cmd: ["npx", existsSync("tsconfig.scripts.json") ? ["tsc", "--noEmit", "-p", "tsconfig.scripts.json"] : ["tsc", "--noEmit"]] },
  { name: "test:ui", reads: (f) => f.startsWith("src/lib/") || f.startsWith("src/app/sage/") || f === "scripts/test-ui.mts", cmd: ["npm", ["run", "test:ui"]], needs: ["scripts/test-ui.mts"] },
  // This file and its harness: a change to how everything ships is tested like any other code.
  { name: "test:ship", reads: (f) => f === "scripts/ship.mjs" || f === "scripts/test-ship.mjs", cmd: ["node", ["scripts/test-ship.mjs"]], needs: ["scripts/test-ship.mjs"] },
  { name: "test:engine", reads: engineReads, cmd: ["npm", ["run", "test:engine"]] },
];
const isGateInput = (f) => GATES.some((g) => g.reads(f));
// Both sides of every change count (renames are off), so a file moved OUT of src/lib still selects the
// engine suite.
const selectGates = (changed) => GATES.filter((g) => (g.always || changed.some(g.reads)) && (g.needs ?? []).every((n) => existsSync(n)));

function statusOf(pathspec) {
  return nul(git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...pathspec]))
    .map((e) => ({ xy: e.slice(0, 2), file: e.slice(3) }));
}

/** The gate runs on the working tree, the commit holds only its own files: other uncommitted work a
 *  selected gate reads would be tested and then pushed nowhere — a green gate for a commit nobody gated. */
function unrelatedDirty(gates, own) {
  if (opt["--allow-unrelated-dirty"] || !gates.length) return [];
  const mine = new Set(own);
  return statusOf([]).filter((e) => !mine.has(e.file) && gates.some((g) => g.reads(e.file)));
}
const dirtyMessage = (others) =>
  `the gate would also test uncommitted work that is NOT in this commit:\n${others.map((e) => `  ${e.xy} ${e.file}`).join("\n")}\n` +
  `ship: name it in this ship, or copy it aside first (never git stash: the stack is shared by every worktree). ` +
  `--allow-unrelated-dirty overrides this, and then only CI checks the commit on its own.`;

/** true when the gate passed. */
function runGate(gates) {
  if (!gates.length) return true;
  console.log(`\nship: running the gate — ${gates.map((g) => g.name).join(", then ")}…`);
  try {
    if (process.env.SHIP_GATE_HOOK) run("node", [process.env.SHIP_GATE_HOOK, ...gates.map((g) => g.name)]);
    else for (const g of gates) run(...g.cmd);
    return true;
  } catch {
    return false;
  }
}

// ---- publish: put commit C on the remote branch, rebuilt on top of the remote if that moved ------------
function publish(C, label) {
  const committed = changedBetween(`${C}^`, C);
  let X = C;
  for (let attempt = 1; ; attempt++) {
    fetchOrigin();
    const R = git(["rev-parse", remoteRef]);
    if (!isAncestor(R, X)) {
      const base = git(["merge-base", R, C]);
      const remoteTouched = new Set(changedBetween(base, R));
      const overlap = committed.filter((f) => remoteTouched.has(f));
      if (overlap.length) stranded(C, overlapAfterCommit(overlap));
      X = rebuildOnto(C, R, committed);
      console.log(`ship: origin/${branch} has ${git(["rev-list", "--count", `${base}..${R}`])} commit(s) this one was not built on, none touching its files — rebuilt on top of them as ${X.slice(0, 7)}.`);
    }
    console.log(`ship: pushing ${X.slice(0, 7)} to origin/${branch}…`);
    const p = gitOk(["push", "origin", `${X}:refs/heads/${branch}`]);
    if (p.ok) break;
    if (attempt < 3 && /rejected|fetch first|non-fast-forward/i.test(p.err)) { console.log("ship: the remote moved during the push; trying again."); continue; }
    stranded(C, `the push failed:\n${p.err.trim()}`);
  }
  fetchOrigin();
  if (!isAncestor(X, remoteRef)) stranded(C, `the push reported success, but origin/${branch} does not contain ${X.slice(0, 7)}.`);
  if (X !== C) {
    const now = git(["rev-parse", "HEAD"]);
    if (now !== C) {
      console.error(`\nship: PUSHED as ${X.slice(0, 7)}, but this branch moved on to ${now.slice(0, 7)} meanwhile (a commit made here during the push). ` +
        `Nothing was moved. Put that work on top of origin/${branch} by hand.\n`);
      process.exit(EXIT.PUSHED_LOCAL_BEHIND);
    }
    // Catch the folder up the way `git checkout` carries local changes: a two-tree read-tree keeps every
    // index entry, staged versions included, for files the remote did not change, updates the files it
    // did change, and REFUSES, rather than merges, when one of those has local edits. (`git reset --keep`
    // refuses too, but resets every index entry and so drops a staged version: test-ship.mjs caught it.)
    const finish = `git read-tree -m -u ${C.slice(0, 7)} ${X.slice(0, 7)} && git update-ref ${HEAD_REF} ${X.slice(0, 7)} ${C.slice(0, 7)}`;
    gitOk(["update-index", "-q", "--refresh"]);
    const k = gitOk(["read-tree", "-m", "-u", C, X]);
    if (!k.ok) {
      console.error(`\nship: PUSHED as ${X.slice(0, 7)}, but this folder is still at ${C.slice(0, 7)}: catching up would touch files with local edits:\n${k.err.trim()}\n` +
        `ship: nothing is lost and nothing was merged. Copy those files aside, settle them by hand, then run:\n  ${finish}\n`);
      process.exit(EXIT.PUSHED_LOCAL_BEHIND);
    }
    const moved = gitOk(["update-ref", "-m", `ship: caught up with origin/${branch}`, HEAD_REF, X, C]);
    if (!moved.ok) {
      console.error(`\nship: PUSHED as ${X.slice(0, 7)}, and this folder's files now match it, but the branch moved under ship and was not updated:\n${moved.err.trim()}\nship: look at git log before anything else.\n`);
      process.exit(EXIT.PUSHED_LOCAL_BEHIND);
    }
  }
  console.log(`\nship: done. ${git(["log", "--oneline", "-1", X])}${label ? ` (${label})` : ""}\n`);
  process.exit(0);
}

/** C's files laid over R in a private index: the clean result of a rebase, built without the tree. */
function rebuildOnto(C, R, committed) {
  const idx = tmpFile("rebuild-index");
  const env = { GIT_INDEX_FILE: idx };
  try {
    git(["read-tree", R], { env });
    const inC = new Map(nul(git(["ls-tree", "-r", "-z", C, "--", ...committed])).map((line) => {
      const tab = line.indexOf("\t");
      const [mode, , blob] = line.slice(0, tab).split(" ");
      return [line.slice(tab + 1), { mode, blob }];
    }));
    for (const f of committed) {
      const e = inC.get(f);
      if (e) git(["update-index", "--add", "--cacheinfo", `${e.mode},${e.blob},${f}`], { env });
      else git(["update-index", "--force-remove", "--", f], { env });
    }
    const tree = git(["write-tree"], { env });
    const [an, ae, ad] = git(["log", "-1", "--format=%an%x00%ae%x00%ad", "--date=raw", C]).split("\0");
    const msgFile = tmpFile("rebuild-msg");
    writeFileSync(msgFile, git(["log", "-1", "--format=%B", C]) + "\n");
    try {
      return git(["commit-tree", tree, "-p", R, "-F", msgFile], { env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad } });
    } finally { rmSync(msgFile, { force: true }); }
  } finally { rmSync(idx, { force: true }); }
}

function stranded(C, why) {
  console.error(`\nship: COMMITTED LOCALLY AS ${C.slice(0, 7)}, NOT PUSHED — ${why}\n` +
    `ship: the commit is safe: it is this branch's HEAD. Once the reason is fixed, push it with:\n  ${retry}\n` +
    `ship: (a plain re-run would say "nothing to commit": the work is in the commit now, not the tree.)\n`);
  process.exit(EXIT.STRANDED);
}
const overlapAfterCommit = (overlap) =>
  `origin/${branch} changed files this commit also changes, after the gate:\n${overlap.map((f) => `  - ${f}`).join("\n")}\n` +
  `To land it: merge their version by hand into this commit — e.g. \`git rebase origin/${branch}\` if nothing else is uncommitted here, ` +
  `resolving every conflict by combining both sides (never one side wholesale) — then ${retry}, which gates a rebased commit before pushing it.`;

/** Was C made by ship? Its compare-and-swap writes a "ship: …" reflog entry; a rebase or amend does not. */
function shipMade(C) {
  const r = gitOk(["log", "-g", "-n", "200", "--format=%H%x00%gs", HEAD_REF]);
  return r.ok && r.out.split("\n").some((l) => { const [h, s = ""] = l.split("\0"); return h === C && s.startsWith("ship: "); });
}

// ---- --resume: push the one stranded commit, gating it first unless ship made it ---------------------
if (resume) {
  if (unpushed.length !== 1) die(`--resume pushes exactly ONE unpushed commit; found ${unpushed.length}:\n${unpushed.map((c) => `  ${c}`).join("\n") || "  (none: nothing to push)"}`, EXIT.STOPPED);
  if (git(["rev-list", "--count", "--merges", `${remoteRef}..HEAD`]) !== "0") die("the unpushed commit is a merge; ship does not push merges.", EXIT.STOPPED);
  const own = changedBetween(`${HEAD0}^`, HEAD0);
  if (shipMade(HEAD0)) {
    console.log(`ship: resuming ${unpushed[0]} — ship made it, and its gate ran then.`);
  } else {
    console.log(`ship: ${unpushed[0]} was not made by ship (rebased, amended or committed by hand), so it is gated now.`);
    if (opt["--no-gate"] && own.some(isGateInput)) stranded(HEAD0, `--no-gate is for files no gate reads; this commit changes gate inputs:\n${own.filter(isGateInput).map((f) => `  ${f}`).join("\n")}`);
    const gates = opt["--no-gate"] ? [] : selectGates(own);
    const differs = statusOf(own);
    if (gates.length && differs.length) stranded(HEAD0, `the working tree differs from the commit in files it changes, so the gate would test something else:\n${differs.map((e) => `  ${e.xy} ${e.file}`).join("\n")}`);
    const others = unrelatedDirty(gates, own);
    if (others.length) stranded(HEAD0, dirtyMessage(others));
    if (dryRun) { console.log(`\nship: --dry-run. The gate would run: ${gates.map((g) => g.name).join(", ") || "nothing"}.\n`); process.exit(0); }
    if (!runGate(gates)) stranded(HEAD0, "the gate failed. Fix it (amend the commit), then resume again — never push red.");
    if (gates.length && statusOf(own).length) stranded(HEAD0, "a file the commit changes was edited while the gate ran, so the gate may have tested another version.");
  }
  if (dryRun) { console.log("\nship: --dry-run, stopping before the push.\n"); process.exit(0); }
  try { publish(HEAD0, "resumed"); } catch (e) { stranded(HEAD0, String(e.message)); }
}

if (unpushed.length) {
  die(`this branch has ${unpushed.length} commit(s) that are not on origin/${branch}, and a push would carry them out unchecked:\n` +
    `${unpushed.map((c) => `  ${c}`).join("\n")}\n` +
    `ship: if one is ship's own stranded commit, push it with ${retry}. Otherwise push or drop them deliberately first.`, EXIT.STOPPED);
}

// ---- the named paths -> the files they are --------------------------------------------------------------
if (!rawPaths.length) die(`no paths given. ${USAGE}`);
// An absolute path may reach the repository through a symlink or an 8.3 short name that git's own
// toplevel does not use. Resolve the folders, never the file itself (it may be a tracked symlink).
const realish = (p) => { try { return realpathSync.native(p); } catch { const d = dirname(p); return d === p ? p : join(realish(d), basename(p)); } };
const ROOT_REAL = realish(ROOT);
const paths = rawPaths.map((p) => {
  const rel = (isAbsolute(p) ? relative(ROOT_REAL, join(realish(dirname(resolve(p))), basename(resolve(p)))) : relative(ROOT, resolve(ROOT, p))).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) die(`"${p}" is not a path inside the repository (or it names the root).`);
  return rel;
});
for (const p of paths) {
  if (!git(["ls-files", "-z", "--", p]) && !git(["status", "--porcelain", "-z", "--untracked-files=all", "--", p])) {
    die(`"${p}" matches no file git knows or sees (spelling? letter case? an ignored file?).`);
  }
}
const named = statusOf(paths);
const unmerged = named.filter((e) => /^(DD|AU|UD|UA|DU|AA|UU)$/.test(e.xy));
if (unmerged.length) die(`unmerged paths among the named ones — resolve them first:\n${unmerged.map((e) => `  ${e.xy} ${e.file}`).join("\n")}`);
// A file added to the index and then deleted from disk exists in neither HEAD nor the tree: nothing to commit.
const inHead = new Set(nul(git(["ls-tree", "-r", "-z", "--name-only", HEAD0, "--", ...paths])));
const onDisk = (f) => { try { lstatSync(join(ROOT, f)); return true; } catch { return false; } };
const files = named.map((e) => e.file).filter((f) => onDisk(f) || inHead.has(f));
if (!files.length) die(`nothing to commit in: ${paths.join(", ")}`);
const quiet = paths.filter((p) => !files.some((f) => f === p || f.startsWith(`${p}/`)));
if (quiet.length) console.log(`ship: no changes in ${quiet.join(", ")}; left as they are.`);

// ---- 1. the remote, before any work ------------------------------------------------------------------
/** Files among `mine` that the remote changed since its merge base with `head`. */
function remoteOverlap(head, mine) {
  const R = git(["rev-parse", remoteRef]);
  if (isAncestor(R, head)) return [];
  const remoteTouched = new Set(changedBetween(git(["merge-base", R, head]), R));
  return mine.filter((f) => remoteTouched.has(f));
}
const overlapBeforeCommit = (overlap, when = "") =>
  `THE REMOTE HAS CHANGED FILES YOU ARE ABOUT TO COMMIT${when}:\n${overlap.map((f) => `  - ${f}`).join("\n")}\n` +
  `ship: nothing was committed. To merge: copy your versions of those files aside, \`git checkout -- <them>\`, ` +
  `\`git merge --ff-only origin/${branch}\`, re-apply your edits on top of their version by hand (never one side wholesale), then ship again.`;
{
  const overlap = remoteOverlap(HEAD0, files);
  if (overlap.length) die(overlapBeforeCommit(overlap), EXIT.STOPPED);
}

// ---- 2. the snapshot, in a private index ---------------------------------------------------------------
function snapshotTree() {
  const idx = tmpFile("snapshot-index");
  const env = { GIT_INDEX_FILE: idx };
  try {
    git(["read-tree", HEAD0], { env });
    git(["add", "-A", "--", ...files], { env });
    return git(["write-tree"], { env });
  } finally { rmSync(idx, { force: true }); }
}
const tree = snapshotTree();
const intended = changedBetween(HEAD0, tree);
if (!intended.length) die(`nothing to commit in: ${paths.join(", ")} (the only differences are ones git normalises away).`);
console.log("ship: will commit\n" + intended.map((f) => `  ${f}`).join("\n"));

// ---- 3. the gate ---------------------------------------------------------------------------------------
let gates = [];
if (opt["--no-gate"]) {
  const inputs = intended.filter(isGateInput);
  if (inputs.length) die(`--no-gate is for files no gate reads. These are gate inputs and need the gate:\n${inputs.map((f) => `  ${f}`).join("\n")}`);
  console.log("ship: --no-gate (no gate reads these files).");
} else {
  gates = selectGates(intended);
  const others = unrelatedDirty(gates, files);
  if (others.length) die(dirtyMessage(others), EXIT.STOPPED);
}
if (dryRun) {
  console.log(`\nship: --dry-run. The gate would run: ${gates.map((g) => g.name).join(", ") || "nothing"}. Stopping before the gate.\n`);
  process.exit(0);
}
if (!runGate(gates)) die("the gate failed. Nothing was committed. Fix it or revert — never push red.");

// ---- 4. commit exactly what was gated, and only if nothing moved ----------------------------------------
if (snapshotTree() !== tree) die("a named file changed while the gate ran, so the gate may have tested another version. Nothing was committed; ship again.", EXIT.STOPPED);
// The remote again: a 25-minute gate is long enough for another lane to push the same file. Stopping
// HERE leaves the work uncommitted, which is the easiest state to merge from.
try { fetchOrigin(); } catch (e) { die(`${e.message}\nship: nothing was committed.`); }
{
  const overlap = remoteOverlap(HEAD0, intended);
  if (overlap.length) die(overlapBeforeCommit(overlap, ", WHILE THE GATE RAN"), EXIT.STOPPED);
}
const C = (() => {
  // commit-tree runs no hooks, so run the ones `git commit` would, against an index holding exactly the
  // commit (as `git commit --only` does), and with the caller's pathspec rules rather than ship's.
  const hooksDir = gitOk(["config", "core.hooksPath"]).out || git(["rev-parse", "--git-path", "hooks"]);
  const hookFile = (name) => join(isAbsolute(hooksDir) ? hooksDir : join(ROOT, hooksDir), name);
  const idx = tmpFile("hook-index");
  const msgFile = tmpFile("msg");
  writeFileSync(msgFile, message);
  let failed = null;
  try {
    git(["read-tree", tree], { env: { GIT_INDEX_FILE: idx } });
    for (const [name, extra] of [["pre-commit", []], ["commit-msg", [msgFile]]]) {
      if (failed || !existsSync(hookFile(name))) continue;
      const h = spawnSync("git", ["hook", "run", name, ...(extra.length ? ["--", ...extra] : [])], { stdio: "inherit", env: { ...process.env, GIT_INDEX_FILE: idx } });
      if (h.status !== 0) failed = [`the ${name} hook failed. Nothing was committed.`, EXIT.NOTHING];
    }
    if (!failed && git(["write-tree"], { env: { GIT_INDEX_FILE: idx } }) !== tree) failed = ["the pre-commit hook changed what would be committed, after the gate. Nothing was committed.", EXIT.STOPPED];
    if (!failed) return git(["commit-tree", tree, "-p", HEAD0, "-F", msgFile]);
  } finally {
    rmSync(idx, { force: true });
    rmSync(msgFile, { force: true });
  }
  die(...failed);
})();
// Compare-and-swap: the branch moves to C only if it still points where ship started.
const cas = gitOk(["update-ref", "-m", `ship: ${message.split("\n")[0]}`, HEAD_REF, C, HEAD0]);
if (!cas.ok) die(`HEAD moved while the gate ran (a commit was made in this folder). Nothing was committed by ship; look at git log, then ship again.\n${cas.err.trim()}`, EXIT.STOPPED);
// The shared index now records the committed version of exactly these files; the tree already holds them.
const sync = gitOk(["reset", "-q", "--", ...intended]);
if (!sync.ok) {
  console.error(`ship: WARNING — the shared index could not be updated (${sync.err.trim() || "locked?"}). Until you run\n` +
    `  git reset -q -- ${intended.join(" ")}\n` +
    `git status will show these files as staged REVERSALS of the commit, and the next \`git commit\` would undo it.`);
}
const landed = changedBetween(HEAD0, C);
if (landed.length !== intended.length || landed.some((f) => !intended.includes(f))) {
  stranded(C, `the commit's file list differs from what was intended:\n  commit:   ${landed.join(", ")}\n  intended: ${intended.join(", ")}`);
}
console.log(`ship: committed ${C.slice(0, 7)}: ${intended.length} file(s), exactly as gated.`);

// ---- 5. publish -----------------------------------------------------------------------------------------
try { publish(C); } catch (e) { stranded(C, String(e.message)); }
