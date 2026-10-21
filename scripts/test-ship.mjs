/**
 * The ship tool's own tests: every scenario the 2026-10-18 audit reproduced, replayed against
 * scripts/ship.mjs in throwaway repositories under the OS temp folder. Nothing here touches this
 * repository or its remote.
 *
 *   node scripts/test-ship.mjs                 every scenario, a few at a time
 *   node scripts/test-ship.mjs --only remote   the scenarios whose name contains "remote"
 *   node scripts/test-ship.mjs --serial        one at a time
 *   node scripts/test-ship.mjs --target old.mjs   the same scenarios against another copy of ship
 *   SHIP_TEST_KEEP=1                           keep every scratch folder (a failing one is always kept)
 *
 * Each scenario builds a bare "origin", the clone ship runs in ("work") and a second clone that plays
 * another lane pushing ("other"), with no global or system git config so the machine's settings cannot
 * change the outcome. The gate is replaced by SHIP_GATE_HOOK (ship honours it only under the temp
 * folder): it records which gates ship selected, and can act DURING the gate — edit a file, commit,
 * rewrite the message file, or push from the other clone. Git hooks in "work" act during the push or
 * the commit the same way.
 *
 * ship.mjs runs this as its own gate (test:ship) whenever ship.mjs or this file changes, and so does CI.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
// --target <file> runs the scenarios against another copy, e.g. the previous version, to show the
// scenarios can fail: a check that has only ever passed proves nothing.
const TARGET_AT = process.argv.indexOf("--target");
const SHIP = TARGET_AT > 0 ? process.argv[TARGET_AT + 1] : join(dirname(SELF), "ship.mjs");
const fwd = (p) => p.replace(/\\/g, "/");
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Nothing from the caller's git or ship environment leaks in (this may itself run inside ship's gate).
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|SHIP_)/.test(k)));

// ---- the stand-in gate, and the hooks ----------------------------------------------------------------
const GATE_HOOK = `
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
const gates = process.argv.slice(2);
appendFileSync(process.env.SHIP_TEST_RECORD, gates.join("\\n") + "\\n");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|LITERAL_PATHSPECS)$/.test(k)));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
const put = (root, files) => {
  for (const [p, c] of Object.entries(files)) {
    const f = join(root, p);
    if (c === null) rmSync(f, { force: true });
    else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c); }
  }
};
for (const step of JSON.parse(process.env.SHIP_TEST_DO || "[]")) {
  if (step.op === "write") put(process.cwd(), step.files);
  if (step.op === "write-abs") writeFileSync(step.path, step.content);
  if (step.op === "commit") { put(process.cwd(), step.files); git(process.cwd(), "commit", "-q", "-m", "made during the gate", "--", ...Object.keys(step.files)); }
  if (step.op === "remote") {
    const o = process.env.SHIP_TEST_OTHER;
    git(o, "pull", "-q", "--ff-only"); put(o, step.files); git(o, "add", "-A"); git(o, "commit", "-q", "-m", "another lane"); git(o, "push", "-q", "origin", "HEAD:main");
  }
}
process.exit(Number(process.env.SHIP_TEST_GATE_EXIT || 0));
`;
// Pushes one change from the other clone, once, from inside a hook of the clone ship runs in.
const RACE_HOOK = `#!/bin/sh
if [ -n "$SHIP_TEST_RACE_MARKER" ] && [ ! -f "$SHIP_TEST_RACE_MARKER" ]; then
  : > "$SHIP_TEST_RACE_MARKER"
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_LITERAL_PATHSPECS
  cd "$SHIP_TEST_OTHER" || exit 1
  git pull -q --ff-only || exit 1
  echo raced >> "$SHIP_TEST_RACE_FILE"
  git add -A && git commit -q -m "another lane, mid-ship" && git push -q origin HEAD:main || exit 1
fi
exit 0
`;
// Commits in the clone ship runs in, once, while ship is pushing.
const COMMIT_DURING_PUSH_HOOK = `#!/bin/sh
if [ ! -f "$SHIP_TEST_RACE_MARKER" ]; then
  : > "$SHIP_TEST_RACE_MARKER"
  unset GIT_INDEX_FILE GIT_LITERAL_PATHSPECS
  echo "during the push" >> docs/z.md && git commit -q -m "made during the push" -- docs/z.md || exit 1
fi
exit 0
`;
const BLOCK_PUSH_HOOK = `#!/bin/sh
if [ -n "$SHIP_TEST_BLOCK_PUSH" ]; then echo "push blocked by the test" >&2; exit 1; fi
exit 0
`;
const FAIL_HOOK = `#!/bin/sh
echo "pre-commit says no" >&2
exit 1
`;
const RECORD_INDEX_HOOK = `#!/bin/sh
git diff --cached --name-only > "$SHIP_TEST_HOOK_OUT"
exit 0
`;
const TRAILER_HOOK = `#!/bin/sh
printf '\\nHooked: yes\\n' >> "$1"
`;

const SEED = {
  "README.md": "seed\n",
  "docs/x.md": "x\n",
  "docs/y.md": "y\n",
  "docs/z.md": "z\n",
  "src/lib/a.ts": "export const a = 1;\n",
  "src/lib/b.ts": "export const b = 2;\n",
  "src/app/page.tsx": "export default function Page() { return null; }\n",
  // Stand-ins, so each gate's `needs` is met and its selection can be observed.
  "scripts/check-boundaries.mjs": "// stand-in\n",
  "scripts/check-recipes.mts": "// stand-in\n",
  "scripts/check-ingredients.mts": "// stand-in\n",
  "scripts/test-ui.mts": "// stand-in\n",
  "scripts/test-engine.mts": "// stand-in\n",
  "scripts/test-ship.mjs": "// stand-in\n",
  "scripts/ship.mjs": "// stand-in\n",
  "tsconfig.scripts.json": "{}\n",
};

// ---- one scenario's world ------------------------------------------------------------------------------
function setup(name) {
  const dir = mkdtempSync(join(tmpdir(), `ship-test-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-`));
  const cfg = join(dir, "empty.gitconfig");
  writeFileSync(cfg, "");
  const env = { ...BASE_ENV, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const gitIn = (cwd, ...args) => {
    const o = typeof args[args.length - 1] === "object" ? args.pop() : {};
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...o }).replace(/\n$/, "");
  };
  const origin = join(dir, "origin.git"), work = join(dir, "work"), other = join(dir, "other");
  const put = (files, root = work) => {
    for (const [p, c] of Object.entries(files)) {
      const f = join(root, p);
      if (c === null) rmSync(f, { force: true });
      else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c); }
    }
  };
  const identity = (repo) => {
    for (const [k, v] of [["user.name", "Ship Test"], ["user.email", "ship@test.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) gitIn(repo, "config", k, v);
  };
  gitIn(dir, "init", "-q", "--bare", "-b", "main", origin);
  gitIn(dir, "clone", "-q", origin, work);
  gitIn(work, "symbolic-ref", "HEAD", "refs/heads/main");
  identity(work);
  put(SEED);
  gitIn(work, "add", "-A");
  gitIn(work, "commit", "-q", "-m", "seed");
  gitIn(work, "push", "-q", "-u", "origin", "main");
  gitIn(dir, "clone", "-q", origin, other);
  identity(other);
  const record = join(dir, "gates.txt");
  const hookFile = join(dir, "gate-hook.mjs");
  writeFileSync(hookFile, GATE_HOOK);

  const t = {
    dir, work, other, origin, env, put,
    git: (...args) => gitIn(work, ...args),
    gitIn,
    read: (p, root = work) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null),
    head: () => gitIn(work, "rev-parse", "HEAD"),
    originTip: () => gitIn(origin, "rev-parse", "main"),
    originFile: (p) => { const r = spawnSync("git", ["show", `main:${p}`], { cwd: origin, env, encoding: "utf8" }); return r.status === 0 ? r.stdout : null; },
    /** the files the commit at `rev` (in origin) changed */
    files: (rev = "main") => gitIn(origin, "diff-tree", "--no-commit-id", "-r", "--name-only", "-z", "--no-renames", rev).split("\0").filter(Boolean),
    hook: (name, content) => { const f = join(work, ".git", "hooks", name); writeFileSync(f, content); chmodSync(f, 0o755); },
    /** another lane pushes; returns the new remote tip */
    remote: (files, msg = "another lane") => {
      gitIn(other, "pull", "-q", "--ff-only");
      put(files, other);
      gitIn(other, "add", "-A");
      gitIn(other, "commit", "-q", "-m", msg);
      gitIn(other, "push", "-q", "origin", "HEAD:main");
      return gitIn(other, "rev-parse", "HEAD");
    },
    /** run ship; `during` acts inside the gate. gates is null when the gate never ran. */
    ship: (args, { env: extra = {}, cwd = work, during = [] } = {}) => {
      rmSync(record, { force: true });
      const r = spawnSync(process.execPath, [SHIP, ...args], {
        cwd, encoding: "utf8", timeout: 120_000,
        env: { ...env, SHIP_GATE_HOOK: hookFile, SHIP_TEST_RECORD: record, SHIP_TEST_OTHER: fwd(other), SHIP_TEST_DO: JSON.stringify(during), ...extra },
      });
      return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error}` : ""}`, gates: existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : null };
    },
  };
  return t;
}

// ---- the scenarios -------------------------------------------------------------------------------------
const S = [];
const scenario = (name, fn) => S.push({ name, fn });
const M = ["--message", "test commit"];

scenario("a new nested folder is committed, and an unnamed edit is not", (t, check) => {
  t.put({ "docs/new/deep/a.md": "a\n", "docs/new/b.md": "b\n", "docs/x.md": "edited, not named\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/new"]);
  check(r.code === 0, "exit 0", r.out);
  check(same(t.files(), ["docs/new/b.md", "docs/new/deep/a.md"]), "the commit holds exactly the new folder", t.files().join(", "));
  check(t.originFile("docs/x.md") === "x\n" && t.read("docs/x.md") === "edited, not named\n", "the unnamed edit stayed local, intact");
  check(t.head() === t.originTip(), "local HEAD is what was pushed");
});

scenario("path spellings: ./x, dir\\x, an absolute path and dir/ name the same files", (t, check) => {
  t.put({ "docs/x.md": "1\n", "docs/y.md": "2\n", "docs/z.md": "3\n", "docs/sub dir/é ñ.md": "4\n" });
  const r = t.ship([...M, "--no-gate", "--", "./docs/x.md", "docs\\y.md", join(t.work, "docs", "z.md"), "docs/sub dir/"]);
  check(r.code === 0, "exit 0", r.out);
  check(same(t.files(), ["docs/sub dir/é ñ.md", "docs/x.md", "docs/y.md", "docs/z.md"]), "exactly the four files, the non-ASCII name intact", t.files().join(" | "));
});

scenario("a typo, the root, a path outside, a missing message and no paths are refused", (t, check) => {
  t.put({ "docs/x.md": "edited\n" });
  const before = t.originTip();
  const cases = [
    [[...M, "--no-gate", "--", "docs/nope.md"], /matches no file/],
    [[...M, "--no-gate", "--", "."], /root/],
    [[...M, "--no-gate", "--", "../outside.md"], /not a path inside/],
    [["--no-gate", "--", "docs/x.md"], /need --message-file/],
    [["--message-file", join(t.dir, "absent.txt"), "--", "docs/x.md"], /not found/],
    [[...M, "--message-file", join(t.dir, "absent.txt"), "--", "docs/x.md"], /not both/],
    [[...M], /no paths given/],
  ];
  for (const [args, want] of cases) {
    const r = t.ship(args);
    check(r.code === 1 && want.test(r.out), `${args.slice(-1)[0]} ${String(want)}: exit 1`, r.out);
  }
  check(t.originTip() === before, "nothing was pushed");
});

scenario("run from a subdirectory: refused", (t, check) => {
  t.put({ "docs/x.md": "edited\n" });
  const r = t.ship([...M, "--no-gate", "--", "x.md"], { cwd: join(t.work, "docs") });
  check(r.code === 1 && /repository root/.test(r.out), "exit 1, says why", r.out);
});

scenario("git mv commits both sides of the move", (t, check) => {
  t.git("mv", "docs/x.md", "docs/w.md");
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md", "docs/w.md"]);
  check(r.code === 0, "exit 0", r.out);
  check(t.originFile("docs/x.md") === null && t.originFile("docs/w.md") === "x\n", "the remote has the move, not a copy");
});

scenario("a move into a folder with a shim left behind runs every gate that reads either side", (t, check) => {
  mkdirSync(join(t.work, "src/lib/core"), { recursive: true });
  renameSync(join(t.work, "src/lib/a.ts"), join(t.work, "src/lib/core/a.ts"));
  t.put({ "src/lib/a.ts": 'export * from "./core/a";\n' });
  const r = t.ship([...M, "--", "src/lib/a.ts", "src/lib/core"]);
  check(r.code === 0, "exit 0", r.out);
  check(eq(r.gates, ["check:boundaries", "check:recipes", "check:ingredients", "tsc", "test:ui", "test:engine"]), "boundaries, data, types, ui, then the engine suite", String(r.gates));
  check(same(t.files(), ["src/lib/a.ts", "src/lib/core/a.ts"]), "both files committed");
});

scenario("a file moved OUT of src/lib still runs the engine suite", (t, check) => {
  renameSync(join(t.work, "src/lib/b.ts"), join(t.work, "docs/b.ts"));
  const r = t.ship([...M, "--", "src/lib/b.ts", "docs/b.ts"]);
  check(r.code === 0, "exit 0", r.out);
  check((r.gates ?? []).includes("test:engine"), "test:engine ran", String(r.gates));
});

scenario("a deletion is committed", (t, check) => {
  rmSync(join(t.work, "docs/y.md"));
  const r = t.ship([...M, "--no-gate", "--", "docs/y.md"]);
  check(r.code === 0 && t.originFile("docs/y.md") === null, "exit 0, gone from the remote", r.out);
});

scenario("a commit that is not on the remote stops it (exit 2)", (t, check) => {
  t.put({ "docs/x.md": "committed by hand\n" });
  t.git("commit", "-q", "-am", "by hand");
  t.put({ "docs/y.md": "edited\n" });
  const before = t.originTip();
  const r = t.ship([...M, "--no-gate", "--", "docs/y.md"]);
  check(r.code === 2 && /not on origin/.test(r.out) && /by hand/.test(r.out), "exit 2, names the commit", r.out);
  check(t.originTip() === before, "nothing pushed");
});

scenario("a failed push strands the commit (exit 3); --resume pushes it without re-running the gate", (t, check) => {
  t.hook("pre-push", BLOCK_PUSH_HOOK);
  t.put({ "src/lib/a.ts": "export const a = 2;\n" });
  const before = t.originTip();
  const r = t.ship([...M, "--", "src/lib/a.ts"], { env: { SHIP_TEST_BLOCK_PUSH: "1" } });
  check(r.code === 3 && /COMMITTED LOCALLY/.test(r.out) && /--resume/.test(r.out), "exit 3, says how to resume", r.out);
  check(t.originTip() === before, "nothing pushed yet");
  const c = t.head();
  const s = t.ship(["--resume"]);
  check(s.code === 0, "--resume: exit 0", s.out);
  check(s.gates === null, "the gate did not run again: ship made the commit", String(s.gates));
  check(t.originTip() === c, "the same commit is on the remote");
});

scenario("--resume refuses two unpushed commits", (t, check) => {
  t.put({ "docs/x.md": "1\n" });
  t.git("commit", "-q", "-am", "one");
  t.put({ "docs/y.md": "2\n" });
  t.git("commit", "-q", "-am", "two");
  const r = t.ship(["--resume"]);
  check(r.code === 2 && /exactly ONE/.test(r.out), "exit 2", r.out);
});

scenario("--resume gates a commit ship did not make", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 3;\n" });
  t.git("commit", "-q", "-am", "by hand");
  const r = t.ship(["--resume"]);
  check(r.code === 0 && /not made by ship/.test(r.out), "exit 0", r.out);
  check((r.gates ?? []).includes("test:engine"), "the engine gate ran", String(r.gates));
  check(t.originTip() === t.head(), "pushed");
});

scenario("--resume will not gate around uncommitted work the gate reads (exit 3)", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 3;\n" });
  t.git("commit", "-q", "-am", "by hand");
  t.put({ "src/lib/b.ts": "export const b = 9;\n" });
  const before = t.originTip();
  const r = t.ship(["--resume"]);
  check(r.code === 3 && /NOT in this commit/.test(r.out) && /src\/lib\/b\.ts/.test(r.out), "exit 3, names it", r.out);
  check(t.originTip() === before, "nothing pushed");
});

scenario("the remote changed the same file: stops before anything (exit 2)", (t, check) => {
  const theirs = t.remote({ "docs/x.md": "theirs\n" });
  t.put({ "docs/x.md": "mine\n" });
  const head = t.head();
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 2 && /docs\/x\.md/.test(r.out), "exit 2, names the file", r.out);
  check(t.head() === head && t.read("docs/x.md") === "mine\n", "nothing committed, the edit intact");
  check(t.originTip() === theirs, "the remote untouched");
});

scenario("the remote changed another file: rebuilt on top, pushed, and the folder caught up", (t, check) => {
  const theirs = t.remote({ "docs/y.md": "theirs\n" });
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 0, "exit 0", r.out);
  check(t.gitIn(t.origin, "rev-parse", "main^") === theirs, "built on top of their commit");
  check(t.originFile("docs/x.md") === "mine\n" && t.originFile("docs/y.md") === "theirs\n", "both changes on the remote");
  check(t.head() === t.originTip() && t.read("docs/y.md") === "theirs\n", "the folder caught up");
  check(t.gitIn(t.origin, "log", "-1", "--format=%an <%ae>", "main") === "Ship Test <ship@test.invalid>", "the author is kept");
  check(t.git("status", "--porcelain") === "", "a clean tree", t.git("status", "--porcelain"));
});

scenario("the remote renamed the file being committed: an overlap (exit 2)", (t, check) => {
  t.remote({ "docs/x.md": null, "docs/v.md": "x\n" });
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 2 && /docs\/x\.md/.test(r.out), "exit 2", r.out);
});

scenario("the remote changed the same file DURING the gate: nothing committed (exit 2)", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 4;\n" });
  const head = t.head();
  const r = t.ship([...M, "--", "src/lib/a.ts"], { during: [{ op: "remote", files: { "src/lib/a.ts": "export const a = 5;\n" } }] });
  check(r.code === 2 && /WHILE THE GATE RAN/.test(r.out), "exit 2, says so", r.out);
  check(t.head() === head && t.read("src/lib/a.ts") === "export const a = 4;\n", "nothing committed, the edit intact");
});

scenario("the remote changed another file during the gate: rebuilt and pushed", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 4;\n" });
  const r = t.ship([...M, "--", "src/lib/a.ts"], { during: [{ op: "remote", files: { "docs/y.md": "theirs\n" } }] });
  check(r.code === 0, "exit 0", r.out);
  check(t.originFile("src/lib/a.ts") === "export const a = 4;\n" && t.originFile("docs/y.md") === "theirs\n", "both on the remote");
  check(t.head() === t.originTip(), "caught up");
});

scenario("catching up would touch a local edit: pushed, the folder left alone (exit 4), no conflict markers", (t, check) => {
  t.remote({ "docs/y.md": "theirs\n" });
  t.put({ "docs/y.md": "my unrelated edit\n", "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 4 && /PUSHED/.test(r.out) && /read-tree -m -u/.test(r.out), "exit 4, says how to finish", r.out);
  check(t.originFile("docs/x.md") === "mine\n", "the commit is on the remote");
  check(t.read("docs/y.md") === "my unrelated edit\n", "the local edit untouched, no markers", t.read("docs/y.md"));
  check(t.read("docs/x.md") === "mine\n", "the committed file intact");
  // The way out it prints works: set the edit aside, then run exactly the two commands given.
  const m = r.out.match(/git read-tree -m -u (\S+) (\S+) && git update-ref (\S+) (\S+) (\S+)/);
  check(!!m, "it prints the two commands", r.out);
  if (m) {
    t.git("checkout", "--", "docs/y.md");
    t.git("read-tree", "-m", "-u", m[1], m[2]);
    t.git("update-ref", m[3], m[4], m[5]);
    check(t.head() === t.originTip() && t.read("docs/y.md") === "theirs\n" && t.git("status", "--porcelain") === "", "...and they finish the catch-up cleanly");
  }
});

scenario("a commit made in the folder during a rebuilt push is not dropped (exit 4)", (t, check) => {
  t.hook("pre-push", COMMIT_DURING_PUSH_HOOK);
  t.remote({ "docs/y.md": "theirs\n" });
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"], { env: { SHIP_TEST_RACE_MARKER: fwd(join(t.dir, "committed")) } });
  check(r.code === 4 && /moved on/.test(r.out), "exit 4, says the branch moved on", r.out);
  check(t.git("log", "-1", "--format=%s") === "made during the push", "that commit is still the branch's HEAD");
  check(t.originFile("docs/x.md") === "mine\n", "ship's commit landed");
});

scenario("a named file edited during the gate: nothing committed (exit 2)", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 4;\n" });
  const head = t.head();
  const r = t.ship([...M, "--", "src/lib/a.ts"], { during: [{ op: "write", files: { "src/lib/a.ts": "export const a = 6;\n" } }] });
  check(r.code === 2 && /changed while the gate ran/.test(r.out), "exit 2", r.out);
  check(t.head() === head, "nothing committed");
});

scenario("a commit made in the folder during the gate: ship commits nothing (exit 2)", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 4;\n" });
  const before = t.originTip();
  const r = t.ship([...M, "--", "src/lib/a.ts"], { during: [{ op: "commit", files: { "docs/z.md": "z by someone else\n" } }] });
  check(r.code === 2 && /HEAD moved/.test(r.out), "exit 2", r.out);
  check(t.git("log", "-1", "--format=%s") === "made during the gate", "HEAD is their commit, not ship's");
  check(t.git("status", "--porcelain", "--", "src/lib/a.ts") !== "", "the edit is still uncommitted");
  check(t.originTip() === before, "nothing pushed");
});

scenario("an unmerged path is refused", (t, check) => {
  const blob = (c) => t.git("hash-object", "-w", "--stdin", { input: c });
  const [b1, b2, b3] = [blob("base\n"), blob("ours\n"), blob("theirs\n")];
  t.git("update-index", "--index-info", { input: `0 ${"0".repeat(40)}\tdocs/x.md\n100644 ${b1} 1\tdocs/x.md\n100644 ${b2} 2\tdocs/x.md\n100644 ${b3} 3\tdocs/x.md\n` });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 1 && /unmerged/.test(r.out), "exit 1", r.out);
});

scenario("--no-gate is refused for anything a gate reads", (t, check) => {
  for (const f of ["src/lib/a.ts", "scripts/test-engine.mts", "scripts/ship.mjs", "package.json"]) {
    t.put({ [f]: "changed\n" });
    const r = t.ship([...M, "--no-gate", "--", f]);
    check(r.code === 1 && /gate inputs/.test(r.out), `${f}: exit 1`, r.out);
  }
});

scenario("the gates follow the files", (t, check) => {
  t.put({ "scripts/test-engine.mts": "// more rows\n" });
  const r = t.ship([...M, "--", "scripts/test-engine.mts"]);
  check(r.code === 0 && eq(r.gates, ["tsc", "test:engine"]), "test-engine.mts: tsc, then the engine suite", `${r.out}\n${r.gates}`);
  t.put({ "scripts/ship.mjs": "// changed\n" });
  const s = t.ship([...M, "--", "scripts/ship.mjs"]);
  check(s.code === 0 && eq(s.gates, ["tsc", "test:ship"]), "ship.mjs: its own tests", `${s.out}\n${s.gates}`);
  t.put({ "src/app/sage/x.tsx": "export const x = 1;\n" });
  const u = t.ship([...M, "--", "src/app/sage/x.tsx"]);
  check(u.code === 0 && eq(u.gates, ["check:boundaries", "tsc", "test:ui"]), "a /sage component: boundaries, types, ui", `${u.out}\n${u.gates}`);
  t.put({ "docs/x.md": "doc\n" });
  const d = t.ship([...M, "--", "docs/x.md"]);
  check(d.code === 0 && eq(d.gates, ["tsc"]), "a gated doc: types only", `${d.out}\n${d.gates}`);
});

scenario("uncommitted work the gate reads stops a gated ship; the override commits only the named file", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 7;\n", "src/lib/b.ts": "export const b = 7;\n", "docs/z.md": "a doc no gate reads\n" });
  const r = t.ship([...M, "--", "src/lib/a.ts"]);
  const listed = r.out.split("NOT in this commit")[1] ?? "";
  check(r.code === 2 && /src\/lib\/b\.ts/.test(listed) && !/docs\/z\.md/.test(listed), "exit 2, names src/lib/b.ts and not the doc", r.out);
  const s = t.ship([...M, "--allow-unrelated-dirty", "--", "src/lib/a.ts"]);
  check(s.code === 0 && same(t.files(), ["src/lib/a.ts"]), "override: exit 0, only the named file", s.out);
  check(t.read("src/lib/b.ts") === "export const b = 7;\n", "the other edit is still local");
});

scenario("flags are strict", (t, check) => {
  t.put({ "docs/x.md": "edited\n" });
  const cases = [
    [["--message", "m", "--onto"], /needs a value/],
    [["--message", "m", "--onto", "--dry-run", "--", "docs/x.md"], /looks like a flag/],
    [["--message", "m", "--nogate", "--", "docs/x.md"], /unknown argument/],
    [["--message", "--amend", "--", "docs/x.md"], /looks like a flag/],
    [["--message", "m", "docs/x.md"], /unknown argument/],
    [["--resume", "--", "docs/x.md"], /no paths/],
    [["--no-gate=yes", ...M, "--", "docs/x.md"], /takes no value/],
  ];
  for (const [args, want] of cases) {
    const r = t.ship(args);
    check(r.code === 1 && want.test(r.out), `${args.join(" ")}: exit 1`, r.out);
  }
  const ok = t.ship(["--message", "m", "--onto=main", "--no-gate", "--dry-run", "--", "docs/x.md"]);
  check(ok.code === 0 && /dry-run/.test(ok.out), "--onto=main --dry-run: exit 0", ok.out);
  check(t.head() === t.originTip() && t.git("status", "--porcelain", "--", "docs/x.md") !== "", "the dry run committed nothing");
});

scenario("a detached HEAD needs --onto", (t, check) => {
  t.git("checkout", "-q", "--detach");
  t.put({ "docs/x.md": "edited\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 1 && /detached/.test(r.out), "without --onto: exit 1", r.out);
  const s = t.ship([...M, "--no-gate", "--onto", "main", "--", "docs/x.md"]);
  check(s.code === 0 && t.originFile("docs/x.md") === "edited\n", "with --onto main: pushed", s.out);
});

scenario("from a branch with --onto main: lands on main and the branch catches up", (t, check) => {
  t.git("checkout", "-q", "-b", "feature");
  t.remote({ "docs/y.md": "theirs\n" });
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--onto", "main", "--", "docs/x.md"]);
  check(r.code === 0, "exit 0", r.out);
  check(t.originFile("docs/x.md") === "mine\n" && t.originFile("docs/y.md") === "theirs\n", "both on main");
  check(t.git("rev-parse", "feature") === t.originTip(), "the branch caught up to main");
});

scenario("the message is read once: rewriting the file during the gate changes nothing", (t, check) => {
  const msg = join(t.dir, "msg.txt");
  writeFileSync(msg, "the message the gate saw\n");
  t.put({ "src/lib/a.ts": "export const a = 8;\n" });
  const r = t.ship(["--message-file", msg, "--", "src/lib/a.ts"], { during: [{ op: "write-abs", path: msg, content: "a different message\n" }] });
  check(r.code === 0, "exit 0", r.out);
  check(t.gitIn(t.origin, "log", "-1", "--format=%B", "main").trim() === "the message the gate saw", "the original message landed");
});

scenario("a BOM, CRLF and stray blank lines are cleaned out of the message, as git commit would", (t, check) => {
  const msg = join(t.dir, "msg.txt");
  writeFileSync(msg, "﻿\r\nSubject line   \r\n\r\n\r\nBody line\r\n\r\n");
  t.put({ "docs/x.md": "edited\n" });
  const r = t.ship(["--message-file", msg, "--no-gate", "--", "docs/x.md"]);
  const landed = t.gitIn(t.origin, "log", "-1", "--format=%B", "main").replace(/\n+$/, "");
  check(r.code === 0 && landed === "Subject line\n\nBody line", "cleaned", JSON.stringify(landed));
});

scenario("a push race is retried on top of the new remote", (t, check) => {
  t.hook("pre-push", RACE_HOOK);
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"], { env: { SHIP_TEST_RACE_MARKER: fwd(join(t.dir, "raced")), SHIP_TEST_RACE_FILE: "docs/z.md" } });
  check(r.code === 0 && /trying again/.test(r.out), "exit 0 after a retry", r.out);
  check(t.originFile("docs/z.md") === "z\nraced\n" && t.originFile("docs/x.md") === "mine\n", "both the race and the commit landed");
});

scenario("a fetch blocked by another worktree's ref lock is retried", (t, check) => {
  t.remote({ "docs/y.md": "theirs\n" });
  const lock = join(t.work, ".git", "refs", "remotes", "origin", "main.lock");
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, "");
  spawn(process.execPath, ["-e", `setTimeout(() => require("fs").rmSync(${JSON.stringify(lock)}, { force: true }), 700)`], { detached: true, stdio: "ignore" }).unref();
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 0 && t.originFile("docs/x.md") === "mine\n", "exit 0, pushed", r.out);
});

scenario("an unrelated file staged one way and edited another survives a rebuild and catch-up", (t, check) => {
  t.put({ "docs/z.md": "staged z\n" });
  t.git("add", "docs/z.md");
  t.put({ "docs/z.md": "unstaged z\n" });
  t.remote({ "docs/y.md": "theirs\n" });
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 0, "exit 0", r.out);
  check(t.git("show", ":docs/z.md") === "staged z", "the staged version is still staged");
  check(t.read("docs/z.md") === "unstaged z\n", "the working version is untouched");
});

scenario("a staged file that is not named stays out of the commit, and stays staged", (t, check) => {
  t.put({ "docs/y.md": "staged y\n" });
  t.git("add", "docs/y.md");
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 0 && same(t.files(), ["docs/x.md"]), "only the named file", r.out);
  check(t.git("diff", "--cached", "--name-only") === "docs/y.md", "docs/y.md still staged");
});

scenario("nothing to commit: exit 1", (t, check) => {
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 1 && /nothing to commit/.test(r.out), "exit 1", r.out);
});

scenario("a failing gate commits nothing", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 9;\n" });
  const head = t.head();
  const r = t.ship([...M, "--", "src/lib/a.ts"], { env: { SHIP_TEST_GATE_EXIT: "1" } });
  check(r.code === 1 && /gate failed/.test(r.out), "exit 1", r.out);
  check(t.head() === head && t.read("src/lib/a.ts") === "export const a = 9;\n", "nothing committed, the edit intact");
});

scenario("--dry-run names the gates and runs none of them", (t, check) => {
  t.put({ "src/lib/a.ts": "export const a = 9;\n" });
  const r = t.ship([...M, "--dry-run", "--", "src/lib/a.ts"]);
  check(r.code === 0 && /test:engine/.test(r.out), "exit 0, names test:engine", r.out);
  check(r.gates === null && t.head() === t.originTip(), "no gate ran, nothing committed");
});

scenario("hooks: a failing pre-commit stops it", (t, check) => {
  t.hook("pre-commit", FAIL_HOOK);
  t.put({ "docs/x.md": "mine\n" });
  const head = t.head();
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"]);
  check(r.code === 1 && /pre-commit hook failed/.test(r.out), "exit 1", r.out);
  check(t.head() === head, "nothing committed");
});

scenario("hooks: pre-commit sees exactly the commit's index; commit-msg can add to the message", (t, check) => {
  const out = join(t.dir, "hook-saw.txt");
  t.hook("pre-commit", RECORD_INDEX_HOOK);
  t.hook("commit-msg", TRAILER_HOOK);
  t.put({ "docs/y.md": "staged elsewhere\n" });
  t.git("add", "docs/y.md");
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"], { env: { SHIP_TEST_HOOK_OUT: fwd(out) } });
  check(r.code === 0, "exit 0", r.out);
  const saw = existsSync(out) ? readFileSync(out, "utf8").trim() : "(the hook wrote nothing)";
  check(saw === "docs/x.md", "the hook saw docs/x.md only", saw);
  check(/Hooked: yes/.test(t.gitIn(t.origin, "log", "-1", "--format=%B", "main")), "the commit-msg hook's line landed");
});

scenario("the remote overlaps after the commit (exit 3); a by-hand rebase, then --resume gates and lands it", (t, check) => {
  t.hook("pre-commit", RACE_HOOK);
  t.put({ "docs/x.md": "x\nmine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md"], { env: { SHIP_TEST_RACE_MARKER: fwd(join(t.dir, "raced")), SHIP_TEST_RACE_FILE: "docs/x.md" } });
  check(r.code === 3 && /COMMITTED LOCALLY/.test(r.out) && /docs\/x\.md/.test(r.out), "exit 3, names the file", r.out);
  const rb = spawnSync("git", ["rebase", "origin/main"], { cwd: t.work, env: t.env, encoding: "utf8" });
  check(rb.status !== 0, "the rebase stops on the conflict, as it should", `${rb.stdout}${rb.stderr}`);
  writeFileSync(join(t.work, "docs/x.md"), "x\nraced\nmine\n");
  t.git("add", "docs/x.md");
  t.git("-c", "core.editor=true", "rebase", "--continue");
  const s = t.ship(["--resume"]);
  check(s.code === 0 && /not made by ship/.test(s.out), "--resume gates the rebased commit and lands it", s.out);
  check(t.originFile("docs/x.md") === "x\nraced\nmine\n", "the merged file is on the remote");
});

scenario("named paths with no changes are reported; the rest is committed", (t, check) => {
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs/x.md", "docs/y.md"]);
  check(r.code === 0 && /no changes in docs\/y\.md/.test(r.out), "exit 0, reports docs/y.md", r.out);
});

scenario("a file added to the index and then deleted from disk is not an error", (t, check) => {
  t.put({ "docs/new.md": "n\n" });
  t.git("add", "docs/new.md");
  rmSync(join(t.work, "docs/new.md"));
  t.put({ "docs/x.md": "mine\n" });
  const r = t.ship([...M, "--no-gate", "--", "docs"]);
  check(r.code === 0 && same(t.files(), ["docs/x.md"]), "exit 0, only docs/x.md", r.out);
});

// ---- runner: each scenario in its own process, a few at a time -----------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === "--scenario") {
  const s = S[Number(argv[1])];
  const checks = [];
  let t = null;
  let error = null;
  try {
    t = setup(s.name);
    s.fn(t, (ok, label, detail = "") => checks.push({ ok: !!ok, label, detail: ok ? "" : String(detail).slice(0, 4000) }));
  } catch (e) {
    error = String(e?.stack ?? e);
  }
  const failed = error || !checks.length || checks.some((c) => !c.ok);
  if (t && !failed && !process.env.SHIP_TEST_KEEP) rmSync(t.dir, { recursive: true, force: true, maxRetries: 3 });
  process.stdout.write(`${JSON.stringify({ name: s.name, checks, error, dir: failed ? t?.dir ?? null : null })}\n`);
} else {
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const picked = S.map((s, i) => ({ name: s.name, i })).filter((s) => !only || s.name.includes(only));
  const width = argv.includes("--serial") ? 1 : Math.max(1, Math.min(6, cpus().length - 1));
  const started = performance.now();
  const results = new Array(picked.length);
  let next = 0;
  const child = ({ i, name }) => new Promise((done) => {
    const p = spawn(process.execPath, [SELF, "--scenario", String(i), ...(TARGET_AT > 0 ? ["--target", SHIP] : [])], { stdio: ["ignore", "pipe", "pipe"], env: { ...BASE_ENV, ...(process.env.SHIP_TEST_KEEP ? { SHIP_TEST_KEEP: "1" } : {}) } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill(), 240_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      try { done(JSON.parse(out.trim().split("\n").pop())); }
      catch { done({ name, checks: [], error: `the scenario's process exited ${code} with no result:\n${out}\n${err}`, dir: null }); }
    });
  });
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < picked.length) { const k = next++; results[k] = await child(picked[k]); }
  }));
  const indent = (s) => String(s).split("\n").map((l) => `        ${l}`).join("\n");
  let failed = 0, checks = 0;
  for (const r of results) {
    const bad = r.error || !r.checks.length || r.checks.some((c) => !c.ok);
    checks += r.checks.length;
    console.log(`${bad ? "FAIL" : "PASS"}  ${r.name}  (${r.checks.filter((c) => c.ok).length}/${r.checks.length})`);
    if (!bad) continue;
    failed++;
    for (const c of r.checks.filter((c) => !c.ok)) console.log(`      x ${c.label}\n${indent(c.detail)}`);
    if (r.error) console.log(indent(r.error));
    if (!r.checks.length && !r.error) console.log("      x the scenario checked nothing");
    if (r.dir) console.log(`      kept for inspection: ${r.dir}`);
  }
  console.log(`\n${results.length - failed} of ${results.length} scenarios passed (${checks} checks) in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  process.exit(failed ? 1 : 0);
}
