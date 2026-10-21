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
 * WHAT IT PROVES, EXACTLY: 24 mutations, which between them require 35 distinct named checks to fail
 * (the allow list's takes all ten landings, "Confirm email" off takes three checks, the newest-link
 * sentence's two, the dropped verifier's two, and the reused verifier and the 422 mapping each share one
 * of those), so 35 of live.mts's 50 checks are shown able to fail. The other 15 are:
 *  - five platform facts the run records rather than guards it tests: GoTrue's parent rule, the newest
 *    link signing in, /logout's 403, a re-signup's new id, and a magic link still working six minutes
 *    after its request (its five minutes run from the open);
 *  - ten preconditions and follow-ons of the proven ones: the laptop's sign-in, the first sync, the
 *    phone's pull, the mirror, the newer week kept, both edits after a renewal, the plain sign-out, the
 *    delete itself, and Kai's second link coming back to the Site URL's page.
 * That last one cannot tell GoTrue's same-origin rule from its fallback to the Site URL, which there is
 * the same address. So the bare-domain Site URL mutation requires it to PASS (`passes`), where only the
 * same-origin rule can bring it back: that is how the run records the rule.
 *
 * Two corrections, both from the reviews of the Site URL batch. An earlier header said the landings were
 * never reached once the first sign-in failed; the first sign-in never fails under the allow-list
 * mutation (the run hands each code to the device it names, wherever the link landed), so the other
 * eight went red unrequired. And it counted "the takeover's other side" (the tablet finishing Jo's link)
 * as a platform fact, though dropping the verifier on a refused request turns it red every time, so that
 * mutation now requires it. Count from the run's output, never from memory. Say "35 of 50", never
 * "every check".
 *
 * Each mutation runs the full live run, about 80 s (21 took 1681 s on 2026-10-21), so all 24 take about
 * 32 minutes. An anchor that no
 * longer matches exactly once is reported as SKIP and fails the run, like mutate-account.mjs. A run
 * killed mid-mutation is undone at the next start (the journal), so a broken file never outlives it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const MUTATIONS = [
  {
    name: "the select policy shows every row (using (true))",
    file: "supabase/migrations/0001_user_state.sql",
    from: "for select to authenticated\n  using (user_id = auth.uid());",
    to: "for select to authenticated\n  using (true);",
    fails: ["RLS: Rob asking for Sam's rows by her id gets none"],
  },
  {
    name: "upsert_state writes an older value over a newer one (the forward-only rule gone)",
    file: "supabase/migrations/0002_conditional_upsert.sql",
    from: "      where s.updated_at < excluded.updated_at\n",
    to: "",
    fails: ["upsert_state: an older write is skipped"],
  },
  {
    name: "GoTrue's per-person email limit is off",
    file: "scripts/account-live/stack.sh",
    from: "export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000",
    to: "export GOTRUE_SMTP_MAX_FREQUENCY=1ns\nexport GOTRUE_RATE_LIMIT_EMAIL_SENT=1000",
    fails: ["rate limit: a second link for the same person within a minute is refused (429)"],
  },
  {
    name: "the address bar keeps the sign-in code",
    file: "src/lib/account/client.ts",
    from: "  history.replaceState(null, \"\", window.location.pathname);\n",
    to: "",
    fails: ["sign-in: the code reached the address bar, and was cleared from it"],
  },
  {
    name: "a link GoTrue refuses as used or replaced no longer says only the newest link works",
    file: "src/lib/account/supabase.ts",
    from: "or a newer link replaced it (only the newest link we sent works).",
    to: "or a newer link replaced it.",
    fails: ["newest link: an unused link that a newer one replaced is refused", "used link: opening it again is refused"],
  },
  {
    name: "sign-out never reaches GoTrue's /logout (the server session stays alive)",
    file: "src/lib/account/supabase.ts",
    from: "    const res = await call(f, `${cfg.url}/auth/v1/logout?scope=local`, { method: \"POST\", headers: authed(cfg, s) });",
    to: "    const res = new Response(null, { status: 204 });",
    fails: ["sign-out: the real GoTrue refuses the signed-out session's refresh token"],
  },
  {
    name: "a write refused for a deleted account (409, 23503) is not read as deleted",
    file: "src/lib/account/supabase.ts",
    from: "  if (res.status === 409 && d?.code === \"23503\") return new AccountError(\"This account no longer exists.\", \"gone\");\n",
    to: "",
    fails: ["deleted elsewhere: the laptop says the account was deleted"],
  },
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
    // The first sign-in still completes under this mutation: the run hands each code to the device it
    // names, wherever the link landed, and GoTrue's PKCE grant never looks at the return address. So the
    // run carries on, and every one of its ten landings must go red, each named on its own (one shared
    // substring would be satisfied by any single FAIL).
    name: "the redirect allow list no longer admits the account page (one star stops at a slash)",
    file: "scripts/account-live/stack.sh",
    from: 'export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**"',
    to: 'export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/*"',
    fails: [
      "redirect: Lap's link lands back",
      "redirect: Desk's link (asked for here, then from the tablet) lands back",
      "redirect: Tablet's link (sent for the desk's request) lands back",
      "redirect: Pho's link lands back",
      "redirect: Rob's replaced link lands back",
      "redirect: Rob's newest link lands back",
      "redirect: Desk's link (Jo's second device) lands back",
      "redirect: Late's reopened link lands back",
      "redirect: Pho's re-signup link lands back",
      "redirect: ConfA's first link (Confirm email on) lands back",
    ],
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
    // Two checks rest on this guard: the phone's link surviving its refused and lost requests, and the
    // tablet finishing Jo's link after its own request was refused as too soon (without the verifier it
    // kept, the tablet holds nothing when the link arrives).
    name: "a request GoTrue refuses (429) drops the pending verifier",
    file: "src/lib/account/client.ts",
    from: "  await requestMagicLink(cfg, address, `${window.location.origin}${window.location.pathname}`, await challengeFor(verifier));",
    to: "  await requestMagicLink(cfg, address, `${window.location.origin}${window.location.pathname}`, await challengeFor(verifier)).catch((e) => { savePendingSignIn(null); throw e; });",
    fails: ["sign-in: requests GoTrue refuses (429) or never receives", "takeover: …while the browser that asked last finishes with it"],
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
  {
    name: "sign-out ends every session the person has (GoTrue's default scope, global)",
    file: "src/lib/account/supabase.ts",
    from: "/auth/v1/logout?scope=local`",
    to: "/auth/v1/logout`",
    fails: ["sign-out: ends only the browser it was pressed in (scope=local)"],
  },
  {
    // And the one rule the run can only see here: with the Site URL a bare domain, Kai's second request,
    // from the account page on that same origin, comes back to the account page only because GoTrue
    // admits the Site URL's own origin without the allow list. Its fallback would land on "/".
    name: "the Site URL is the bare domain, not the account page (step 3 skipped)",
    file: "scripts/account-live/stack.sh",
    from: 'export GOTRUE_SITE_URL="https://ntrux.vercel.app/sage/account"',
    to: 'export GOTRUE_SITE_URL="https://ntrux.vercel.app"',
    fails: ["redirect: a link asked for at an address the allow list refuses lands on the Site URL"],
    passes: ["redirect: …and asking again on that page, as it says, brings the link back to it"],
  },
  {
    name: "a link that lands where no request is held blames another browser only",
    file: "src/lib/account/client.ts",
    from: "\"That sign-in link can't be finished here: it was opened somewhere other than where it was asked for (in a different browser, or at a different web address), or this browser's data was cleared since. Ask for a new link here, and open it in this browser.\"",
    to: "\"That sign-in link was opened in a different browser from the one that asked for it. Ask for a new link here, and open it in this browser.\"",
    fails: ["where the request is not held (another origin)"],
  },
  {
    name: "a refused verifier (bad_code_verifier) no longer names another web address as a cause",
    file: "src/lib/account/supabase.ts",
    from: "it was asked for in a different browser or at a different web address, or a newer sign-in request took it over",
    to: "it was asked for in a different browser, or a newer sign-in request took it over",
    fails: ["where that page holds an earlier request of its own"],
  },
  {
    name: "a refused verifier (bad_code_verifier) no longer names another browser as a cause",
    file: "src/lib/account/supabase.ts",
    from: "it was asked for in a different browser or at a different web address, or a newer sign-in request took it over",
    to: "it was asked for at a different web address, or a newer sign-in request took it over",
    fails: ["takeover: a fresh link asked for in another browser"],
  },
  {
    // The second GoTrue loses the setting it exists for. Then a first link is a magic link (so it neither
    // reads as a confirmation nor expires from its request), and a refused request takes the link over.
    name: "\"Confirm email\" is off on the second GoTrue too",
    file: "scripts/account-live/stack.sh",
    from: "PORT=54331 GOTRUE_MAILER_AUTOCONFIRM=false",
    to: "PORT=54331 GOTRUE_MAILER_AUTOCONFIRM=true",
    fails: [
      "confirm email on: a new person's first link is a confirmation link",
      "confirm email on: a first link opened six minutes after it was asked for is refused",
      "confirm email on: a not-yet-confirmed person's second request, refused as too soon",
    ],
  },
  {
    name: "a first link refused as expired (422) reads as a passing failure",
    file: "src/lib/account/supabase.ts",
    from: "  if (res.status === 422) throw new AccountError(LINK_ERRORS.flow_state_expired, \"auth\");\n",
    to: "",
    fails: ["confirm email on: a first link opened six minutes after it was asked for is refused"],
  },
];

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1].split("|") : null;
const root = process.cwd();

// In the worktree's own .cache/ (gitignored), not node_modules/.cache, which worktrees can share through
// a junction. A journal left at the old place by a run before the move is still put back.
const journal = join(root, ".cache", "mutate-live.journal.json");
for (const left of [journal, join(root, "node_modules", ".cache", "mutate-live.journal.json")]) {
  if (!existsSync(left)) continue;
  const j = JSON.parse(readFileSync(left, "utf8"));
  writeFileSync(j.path, j.original, "utf8");
  rmSync(left);
  console.log(`RESTORED ${j.path}: the run before this one was interrupted while that file was mutated\n`);
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
  const passed = out.split("\n").filter((l) => l.startsWith("PASS"));
  const missed = m.fails.filter((label) => !failed.some((l) => l.includes(label)));
  // A check that must still PASS under the mutation: what records a platform rule only this broken
  // configuration can show.
  const unheld = (m.passes ?? []).filter((label) => !passed.some((l) => l.includes(label)));
  if (missed.length || unheld.length) allCaught = false;
  console.log(`${missed.length || unheld.length ? "MISSED" : "CAUGHT"}  ${m.name}`);
  for (const label of missed) console.log(`          expected a FAIL for: ${label}`);
  for (const label of unheld) console.log(`          expected a PASS for: ${label}`);
  if (missed.length && !failed.length) console.log(`          the run printed no FAIL at all; its last lines:\n${out.trim().split("\n").slice(-6).map((l) => `            ${l}`).join("\n")}`);
}
console.log(allCaught ? "\nevery mutation was caught" : "\nSOME MUTATIONS WERE NOT CAUGHT");
process.exit(allCaught ? 0 : 1);
