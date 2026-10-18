/**
 * Mutation check for the LIVE run, from the repo root:
 *
 *   node scripts/account-live/mutate-live.mjs [--only "text|other text"]
 *
 * Breaks one thing at a time (a policy in the migration, a setting in stack.sh, a guard in the app),
 * runs the whole live run against the real servers, and requires the check that names that thing to
 * FAIL. Then it restores the file, always, in a finally. A live check that stays green with its subject
 * broken is not testing it: the 2026-10-18 review found three such checks in the first version of
 * live.mts (an RLS write check satisfied by a primary-key collision, a renewal check that never sent an
 * expired token, and redirects nobody looked at).
 *
 * Each mutation runs the full live run, about 90 s, so all ten take about 15 minutes. An anchor that
 * no longer matches exactly once is reported as SKIP and fails the run, like mutate-account.mjs. A run
 * killed mid-mutation is undone at the next start (the journal), so a broken file never outlives it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const MUTATIONS = [
  {
    name: "the insert policy accepts any row (with check (true))",
    file: "supabase/migrations/0001_user_state.sql",
    from: "for insert to authenticated\n  with check (user_id = auth.uid());",
    to: "for insert to authenticated\n  with check (true);",
    fails: ["RLS: Rob cannot write a row carrying Sam's id"],
  },
  {
    name: "the update policy reaches every row (using (true))",
    file: "supabase/migrations/0001_user_state.sql",
    from: "for update to authenticated\n  using (user_id = auth.uid())",
    to: "for update to authenticated\n  using (true)",
    fails: ["RLS: Rob's update with no filter"],
  },
  {
    name: "the delete policy reaches every row (using (true))",
    file: "supabase/migrations/0001_user_state.sql",
    from: "for delete to authenticated\n  using (user_id = auth.uid());",
    to: "for delete to authenticated\n  using (true);",
    fails: ["RLS: Rob's delete with no filter"],
  },
  {
    name: "the redirect allow list no longer admits the account page (one star stops at a slash)",
    file: "scripts/account-live/stack.sh",
    from: 'export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**"',
    to: 'export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/*"',
    fails: ["redirect: Lap's link lands back"],
  },
  {
    name: "audit logs are written to the database again",
    file: "scripts/account-live/stack.sh",
    from: "export GOTRUE_AUDIT_LOG_DISABLE_POSTGRES=true",
    to: "export GOTRUE_AUDIT_LOG_DISABLE_POSTGRES=false",
    fails: ['step 3: "Write audit logs to the database" off'],
  },
  {
    name: "the app never renews ahead of expiry (only after a 401)",
    file: "src/lib/account/supabase.ts",
    from: "  return s.expiresAt - nowSec > 60 ? s : refreshSession(cfg, s.refreshToken, f, nowSec);",
    to: "  return s;",
    fails: ["renewal: a token that has really expired is renewed by the real GoTrue before the push"],
  },
  {
    name: "a 401 is not renewed and retried",
    file: "src/lib/account/supabase.ts",
    from: "  if (first.status !== 401) return first;",
    to: "  return first;",
    fails: ["renewal: a token PostgREST refuses (401)"],
  },
  {
    name: "a request GoTrue refuses (429) drops the pending verifier",
    file: "src/lib/account/client.ts",
    from: "  await requestMagicLink(cfg, address, `${window.location.origin}${window.location.pathname}`, await challengeFor(verifier));",
    to: "  await requestMagicLink(cfg, address, `${window.location.origin}${window.location.pathname}`, await challengeFor(verifier)).catch((e) => { savePendingSignIn(null); throw e; });",
    fails: ["sign-in: requests GoTrue refuses (429) or never receives"],
  },
  {
    // Against the real GoTrue a refused (429) request is harmless here: GoTrue records it as the person's
    // latest anyway. This first run of the mutations caught that (the check passed), which is how the
    // dropped-connection request got into the check: only a request GoTrue never saw tells the two apart.
    name: "asking again for the same address replaces the verifier",
    file: "src/lib/account/client.ts",
    from: "  const reuse = !!pending && pending.email === address && Date.now() - pending.at < REUSE_VERIFIER_MS;",
    to: "  const reuse = false;",
    fails: ["sign-in: requests GoTrue refuses (429) or never receives"],
  },
  {
    name: "a link a newer request took over (bad_code_verifier) is blamed on a different browser",
    file: "src/lib/account/supabase.ts",
    from: "  if (res.status === 400 && ((await res.clone().json().catch(() => ({}))) as { error_code?: string }).error_code === \"bad_code_verifier\") {\n    throw new AccountError(LINK_TAKEN_OVER, \"auth\");\n  }\n",
    to: "",
    fails: ["takeover: once another browser asks"],
  },
];

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1].split("|") : null;
const root = process.cwd();

const journal = join(root, "node_modules", ".cache", "mutate-live.journal.json");
if (existsSync(journal)) {
  const left = JSON.parse(readFileSync(journal, "utf8"));
  writeFileSync(left.path, left.original, "utf8");
  rmSync(journal);
  console.log(`RESTORED ${left.path}: the run before this one was interrupted while that file was mutated\n`);
}
mkdirSync(dirname(journal), { recursive: true });

const chosen = only ? MUTATIONS.filter((m) => only.some((t) => m.name.includes(t))) : MUTATIONS;
if (only) console.log(`--only: ${chosen.length} of ${MUTATIONS.length} mutations`);
let allCaught = chosen.length > 0;
for (const m of chosen) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  const normalised = original.replace(/\r\n/g, "\n");
  if (normalised.split(m.from).length !== 2) {
    console.log(`SKIP (anchor not found exactly once): ${m.name}`);
    allCaught = false;
    continue;
  }
  writeFileSync(journal, JSON.stringify({ path, original }), "utf8");
  writeFileSync(path, normalised.replace(m.from, m.to), "utf8");
  let out = "";
  try {
    out = execFileSync(process.execPath, ["scripts/account-live/run.mjs"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  } finally {
    writeFileSync(path, original, "utf8");
    rmSync(journal, { force: true });
  }
  const failed = out.split("\n").filter((l) => l.startsWith("FAIL"));
  const missed = m.fails.filter((label) => !failed.some((l) => l.includes(label)));
  if (missed.length) allCaught = false;
  console.log(`${missed.length ? "MISSED" : "CAUGHT"}  ${m.name}`);
  for (const label of missed) console.log(`          expected a FAIL for: ${label}`);
  if (missed.length && !failed.length) console.log(`          the run printed no FAIL at all; its last lines:\n${out.trim().split("\n").slice(-6).map((l) => `            ${l}`).join("\n")}`);
}
console.log(allCaught ? "\nevery mutation was caught" : "\nSOME MUTATIONS WERE NOT CAUGHT");
process.exit(allCaught ? 0 : 1);
