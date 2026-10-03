/**
 * Commit and push a named set of paths, atomically, with the gate run first and the result verified.
 *
 *   node scripts/ship.mjs --message-file msg.txt -- src/lib/foo.ts docs/bar.md
 *   node scripts/ship.mjs --message "short message" --no-gate -- docs/bar.md
 *   node scripts/ship.mjs --onto main --message-file msg.txt -- <paths>   (from a worktree on another branch)
 *
 * WHY THIS EXISTS. On 2026-10-03 a day's work landed on origin/main under an unrelated commit
 * message. The cause was not carelessness about git, it was the ORDER that correctness demands:
 * `git add` the work, run the 25-minute engine suite, then commit. For 25 minutes the changes sat in
 * `.git/index` — which is SHARED STATE for the whole working directory — and a commit made from
 * elsewhere in that window swept them in. Nothing was lost, but the reasoning written for that
 * commit is not in the history, and force-pushing to fix attribution would break the other machine's
 * clone.
 *
 * The fix is to never have a staging window. `git commit --only <paths>` stages and commits in one
 * atomic step, ignoring whatever else is in the index, so a concurrent commit cannot take the work
 * and this one cannot take theirs.
 *
 * What it guarantees, in order:
 *   1. The remote is fetched and divergence is reported BEFORE any work is done.
 *   2. If the branch is behind, it rebases — and on conflict it ABORTS the rebase, restoring the
 *      tree exactly, and tells you. It never resolves a conflict on its own and never discards.
 *   3. The gate runs (test:engine when src/lib is touched, else tsc) and a failure stops everything.
 *   4. The commit contains EXACTLY the paths asked for — verified against the commit afterwards, so
 *      a file swept in or dropped out is reported rather than discovered later.
 *   5. The push is verified: `git log origin/main..HEAD` must end empty.
 *
 * It never force-pushes, never amends, and never touches a path it was not given.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const flags = sep === -1 ? argv : argv.slice(0, sep);
const paths = sep === -1 ? [] : argv.slice(sep + 1);

function flag(name) {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
}
const hasFlag = (name) => flags.includes(name);

const messageFile = flag("--message-file");
const message = flag("--message");
const skipGate = hasFlag("--no-gate");
const dryRun = hasFlag("--dry-run");

/**
 * The path out of a `git status --porcelain` line.
 *
 * Do NOT use a fixed `slice(3)`: the status field is two columns but the separator and quoting vary
 * (` M file`, `M  file`, `?? file`, `R  old -> new`, and a quoted path when it contains spaces). A
 * fixed offset silently shaves a character off the filename, which made the commit verifier report a
 * file as unexpected when it had in fact been named - a safety check crying wolf is worse than none,
 * because the next person learns to ignore it.
 */
function porcelainPath(line) {
  const rest = line.replace(/^.{1,2}\s+/, "");
  const renamed = rest.split(" -> ");
  return (renamed.length > 1 ? renamed[renamed.length - 1] : rest).replace(/^"|"$/g, "");
}

function die(msg) {
  console.error(`\nship: ${msg}\n`);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

/**
 * Run a command with its output passed straight through.
 *
 * GIT NEVER GOES THROUGH A SHELL. This script hands PATHS FROM THE COMMAND LINE to git, and a shell
 * concatenates arguments rather than escaping them, so a path containing shell metacharacters would
 * be interpreted instead of treated as a filename.
 *
 * npm and npx DO need one on Windows, and not by choice: they are .cmd shims, and since the 2024
 * CVE fix Node refuses to spawn a .cmd without a shell at all — `execFileSync("npx.cmd", ...)` fails
 * with EINVAL (measured here, not assumed). Their arguments in this file are fixed string literals,
 * so nothing user-supplied ever reaches a shell; Node's DEP0190 warning is about the general case
 * and does not describe these two call sites.
 */
function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const viaShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  execFileSync(cmd, args, { stdio: "inherit", shell: viaShell });
}

if (!paths.length) die("no paths given. Usage: ship.mjs --message-file m.txt -- <paths...>");
if (!messageFile && !message) die("need --message-file <file> or --message <text>.");
if (messageFile && !existsSync(messageFile)) die(`message file not found: ${messageFile}`);

const commitMessage = messageFile ? readFileSync(messageFile, "utf8") : message;
if (!commitMessage.trim()) die("the commit message is empty.");

// ---- 1. the remote, before anything else -------------------------------------------------------
console.log("\nship: fetching origin…");
git(["fetch", "origin"]);
// `--onto <branch>` names the REMOTE branch to land on, for a worktree whose local branch is not it
// (a second agent working in its own worktree on branch `accounts` ships with `--onto main`; see
// docs/parallel/README.md). Without the flag it is the current branch, exactly as before.
const branch = flag("--onto") ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
const [behind, ahead] = git(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`])
  .split(/\s+/)
  .map(Number);
console.log(`ship: ${branch} is ${behind} behind, ${ahead} ahead of origin/${branch}.`);

// Anything the remote changed that we are about to commit is the real conflict risk: warn loudly,
// because our version is about to become the one on the remote.
if (behind > 0) {
  const remoteTouched = git(["diff", "--name-only", `HEAD...origin/${branch}`]).split("\n").filter(Boolean);
  const overlap = paths.filter((p) => remoteTouched.some((r) => r === p || r.startsWith(`${p}/`)));
  if (overlap.length) {
    console.error("\nship: THE REMOTE HAS CHANGED FILES YOU ARE ABOUT TO COMMIT:");
    for (const o of overlap) console.error(`  - ${o}`);
    console.error(
      "\nship: stopping. Read their version first (git diff HEAD origin/" +
        branch +
        " -- <path>), merge BY HAND so nothing is lost, then run ship again.",
    );
    process.exit(2);
  }

  console.log("ship: behind the remote — rebasing (nothing of yours is discarded)…");
  try {
    run("git", ["pull", "--rebase", "origin", branch]);
  } catch {
    // A conflicted rebase leaves the tree mid-operation. Put it back exactly and hand it over.
    console.error("\nship: the rebase hit a conflict. Aborting it to restore your tree untouched.");
    try {
      git(["rebase", "--abort"]);
      console.error("ship: rebase aborted; your working tree is as it was.");
    } catch {
      console.error("ship: could not abort automatically — run `git rebase --abort` yourself.");
    }
    console.error("ship: resolve by hand, verify nothing is lost, then run ship again.");
    process.exit(2);
  }
}

// ---- 2. is there anything in these paths to commit? --------------------------------------------
const dirty = git(["status", "--porcelain", "--", ...paths]).split("\n").filter(Boolean);
if (!dirty.length) die(`nothing to commit in: ${paths.join(", ")}`);
console.log("ship: will commit\n" + dirty.map((l) => `  ${l}`).join("\n"));

// ---- 3. the gate -------------------------------------------------------------------------------
const touchesEngine = dirty.some((l) => porcelainPath(l).includes("src/lib/"));
if (skipGate) {
  console.log("ship: --no-gate given; skipping the gate (docs-only changes).");
} else {
  console.log(
    `\nship: running the gate — ${touchesEngine ? "npm run test:engine (src/lib changed)" : "tsc"}…`,
  );
  try {
    if (touchesEngine) run("npm", ["run", "test:engine"]);
    else run("npx", ["tsc", "--noEmit"]);
  } catch {
    die("the gate failed. Nothing was committed. Fix it or revert — never push red.");
  }
}

if (dryRun) {
  console.log("\nship: --dry-run, stopping before the commit.\n");
  process.exit(0);
}

// ---- 4. commit ONLY these paths, atomically ----------------------------------------------------
// `--only` stages and commits in one step and ignores the rest of the index, so a commit made
// elsewhere in this directory can neither take these changes nor contribute to this one.
console.log("\nship: committing (atomic, --only)…");
// One wrinkle, found by shipping this script with itself: `--only` works on paths git already
// knows, so a BRAND NEW file fails with "did not match any file(s) known to git".
// `git add --intent-to-add` registers the path without putting its content in the index, which
// keeps the window that caused all this as small as possible - and it happens immediately before
// the commit, not before a 25-minute gate.
const untracked = dirty.filter((l) => l.startsWith("??")).map(porcelainPath);
if (untracked.length) {
  console.log(`ship: registering ${untracked.length} new file(s) with --intent-to-add`);
  git(["add", "--intent-to-add", "--", ...untracked]);
}

const args = ["commit", "--only", ...(messageFile ? ["-F", messageFile] : ["-m", commitMessage]), "--", ...paths];
try {
  run("git", args);
} catch {
  die("the commit failed; nothing was pushed.");
}

// ---- 5. verify the commit holds exactly what was intended --------------------------------------
const committed = git(["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n").filter(Boolean);
const intended = new Set(dirty.map(porcelainPath));
const extra = committed.filter((f) => !intended.has(f) && !paths.some((p) => f.startsWith(`${p}/`)));
const missing = [...intended].filter((f) => !committed.includes(f));

if (extra.length) {
  console.error("\nship: WARNING — the commit contains files you did not name:");
  for (const e of extra) console.error(`  + ${e}`);
  console.error("ship: NOT pushing. Inspect with `git show --stat HEAD`; `git reset --soft HEAD~1` undoes the commit and keeps every change.");
  process.exit(3);
}
if (missing.length) {
  console.error("\nship: WARNING — these were expected in the commit and are not:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("ship: NOT pushing. Nothing is lost — they are still in your working tree.");
  process.exit(3);
}
console.log(`ship: commit verified — ${committed.length} file(s), exactly as asked.`);

// ---- 6. push, and prove it landed --------------------------------------------------------------
console.log("ship: pushing…");
try {
  run("git", ["push", "origin", `HEAD:${branch}`]);
} catch {
  die("the push failed. The commit is safe locally; fetch, rebase and run ship again.");
}

git(["fetch", "origin"]);
const left = git(["rev-list", "origin/" + branch + "..HEAD", "--oneline"]);
if (left) die(`push reported success but ${left.split("\n").length} commit(s) are still unpushed:\n${left}`);
console.log(`\nship: done. ${git(["log", "--oneline", "-1"])}\n`);
