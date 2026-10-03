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
    from: "  const remote = supabaseRemote(cfg, (o) => liveSession(cfg, userId, o));",
    to: "  const remote = supabaseRemote(cfg, (o) => liveSession(cfg, undefined, o));",
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
    from: "  stopRunning();\n  if (cfg && s) {",
    to: "  if (cfg && s) {",
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
  // Review 2, batch 1.
  {
    name: "\"Put it back\" looks the copy up again AFTER the safety copy pushed it out",
    file: "src/lib/storage.ts",
    from: "    return restoreBackup(target);",
    to: "    return restoreBackup(id);",
  },
  {
    name: "a file carrying a cleared (null) store is accepted",
    file: "src/lib/account/portable.ts",
    from: "    if (value === null) return { ok: false, error:",
    to: "    if (false) return { ok: false, error:",
  },
  {
    name: "the import preview hides the empty lists it would clear",
    file: "src/lib/account/portable.ts",
    from: "    else if (opts.incoming && Array.isArray(data[name])) out.push(",
    to: "    else if (false) out.push(",
  },
  {
    name: "the owner is recorded only after a first sync succeeds",
    file: "src/lib/account/client.ts",
    from: "  } else if (!owner) {",
    to: "  } else if (false) {",
  },
  {
    name: "deleting the account clears the owner again",
    file: "src/lib/account/client.ts",
    from: "  saveSessionRaw(null);\n  setStatus({\n    state: \"signed-out\",\n    message: \"Your account and everything",
    to: "  saveSessionRaw(null);\n  saveSyncOwner(null);\n  setStatus({\n    state: \"signed-out\",\n    message: \"Your account and everything",
  },
  {
    name: "\"Delete my account\" acts on whatever session is stored (unpinned)",
    file: "src/lib/account/client.ts",
    from: "    s = await liveSession(cfg, mine);",
    to: "    s = await liveSession(cfg);",
  },
  {
    name: "sign-out ends a sign-in this tab isn't showing",
    file: "src/lib/account/client.ts",
    from: "  if (stored && stored.userId !== mine) {",
    to: "  if (false) {",
  },
  {
    name: "\"Delete everything in this browser\" clears an account this tab isn't showing",
    file: "src/lib/account/client.ts",
    from: "  if (s && s.userId !== shownUser()) {",
    to: "  if (false) {",
  },
  {
    name: "a push replaces an account copy this device never saw, keeping nothing (rule 6)",
    file: "src/lib/account/merge.ts",
    from: "      if (!isEmpty(r.value) && r.at !== synced[name]) keepAccountCopy[name] = r.value;",
    to: "",
  },
  {
    name: "rule 6 also keeps the version this device already agreed on (backup churn)",
    file: "src/lib/account/merge.ts",
    from: "      if (!isEmpty(r.value) && r.at !== synced[name]) keepAccountCopy[name] = r.value;",
    to: "      if (!isEmpty(r.value)) keepAccountCopy[name] = r.value;",
  },
  // Review 2, batch 2: other tabs (scripts/test-account-tabs.mts).
  {
    name: "a tab reloads on every change elsewhere, even a refreshed token or a sign-out",
    file: "src/lib/storage.ts",
    from: "    if (e.key === INTERNAL.epoch || e.key === null) fn();",
    to: "    fn();",
  },
  {
    name: "a tab is not reloaded when another tab replaces a store its screens hold",
    file: "src/lib/account/client.ts",
    from: "    if (names.some((n) => HELD_BY_SCREENS.has(n)) && claimSyncReload()) on.reload();",
    to: "    if (false) on.reload();",
  },
  {
    name: "with nobody signed in, another tab's edits still reload this one",
    file: "src/lib/account/client.ts",
    from: "    if (!currentSession()) return;\n    if (names.some(",
    to: "    if (names.some(",
  },
  // Review 2, batch 3: sign-in and tokens as the real GoTrue and PostgREST behave.
  {
    name: "a 401 signs the person out instead of renewing the token and retrying",
    file: "src/lib/account/supabase.ts",
    from: "  if (first.status !== 401) return first;",
    to: "  return first;",
  },
  {
    name: "token expiry is read off the server's clock again",
    file: "src/lib/account/supabase.ts",
    from: "    expiresAt: typeof d.expires_in === \"number\" ? nowSec + d.expires_in : d.expires_at ?? nowSec + 3600,",
    to: "    expiresAt: d.expires_at ?? nowSec + (d.expires_in ?? 3600),",
  },
  {
    name: "an expired first link (422) reads as a transient failure, inviting a retry that cannot work",
    file: "src/lib/account/supabase.ts",
    from: "  if (res.status === 422) throw new AccountError(LINK_ERRORS.flow_state_expired, \"auth\");",
    to: "",
  },
  {
    name: "a transient exchange failure throws the code away (no \"Try again\")",
    file: "src/lib/account/client.ts",
    from: "    saveSignInCode(e instanceof AccountError && e.retryable ? code : null);",
    to: "    saveSignInCode(null);",
  },
  {
    name: "a finished exchange deletes WHATEVER verifier is stored, a newer request's included",
    file: "src/lib/account/client.ts",
    from: "  clearPendingSignIn(verifier);\n  saveSessionRaw(s);",
    to: "  savePendingSignIn(null);\n  saveSessionRaw(s);",
  },
  {
    name: "asking again for the same address replaces the verifier (the first link then fails)",
    file: "src/lib/account/client.ts",
    from: "  const reuse = !!pending && pending.email === address && Date.now() - pending.at < REUSE_VERIFIER_MS;",
    to: "  const reuse = false;",
  },
  {
    name: "a mistyped address is stored as the pending sign-in before it is checked",
    file: "src/lib/account/client.ts",
    from: "  if (!looksLikeEmail(address)) throw new AccountError(\"That doesn't look like an email address.\");",
    to: "",
  },
  {
    name: "a sign-out of a session the server had already ended is reported as a failure",
    file: "src/lib/account/supabase.ts",
    from: "    return (res.status === 403 || res.status === 404) && code === \"session_not_found\";",
    to: "    return false;",
  },
  {
    name: "Supabase's own variable name for the key is ignored",
    file: "src/lib/account/supabase.ts",
    from: "    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,",
    to: "    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,",
  },
  {
    name: "a finished sign-in does not mark the tab as showing that account",
    file: "src/lib/account/client.ts",
    from: "  setStatus({ state: \"syncing\", email: s.email, userId: s.userId });",
    to: "",
  },
  // Review 2, batch 4.
  {
    name: "a renewal answered after a sign-out or a clear brings the session back",
    file: "src/lib/account/client.ts",
    from: "  if (!stored) throw new AccountError(\"You're signed out.\", \"auth\");",
    to: "  if (!stored) { saveSessionRaw(next); return next; }",
  },
  {
    name: "a push answered after the sync stopped writes its bookkeeping anyway",
    file: "src/lib/account/client.ts",
    from: "      if (!isCurrent()) return;\n      for (const r of rows) markSynced(r.name, r.at);",
    to: "      for (const r of rows) markSynced(r.name, r.at);",
  },
  {
    name: "a re-sync waiting behind a push runs in a stopped tab and shows \"Syncing…\"",
    file: "src/lib/account/client.ts",
    from: "    if (!isCurrent()) return null;\n    const first = !everSynced;",
    to: "    const first = !everSynced;",
  },
  {
    name: "a skipped full-sync push is left until the next focus (no follow-up pull)",
    file: "src/lib/account/client.ts",
    from: "      if (report.skipped.length) wantFollowUp = true; // the account moved on mid-sync: see `resync`",
    to: "",
  },
  {
    name: "a full sync's push answered after the browser was cleared still marks its stores synced",
    file: "src/lib/account/sync.ts",
    from: "    if (o.stillCurrent && !o.stillCurrent()) return { ...report, cancelled: true };\n  }\n  const heldBack",
    to: "  }\n  const heldBack",
  },
  {
    name: "THE WRITE FENCE is gone: a stale tab's save lands in the new account's storage",
    file: "src/lib/storage.ts",
    from: "  if (!fenceHolds()) return; // THE WRITE FENCE: the browser changed hands in another tab",
    to: "",
  },
  {
    name: "an account switch starts no new data generation",
    file: "src/lib/storage.ts",
    from: "  window.localStorage.removeItem(INTERNAL.synced);\n  newEpoch();\n}",
    to: "  window.localStorage.removeItem(INTERNAL.synced);\n}",
  },
  {
    name: "\"Delete everything\" starts no new data generation",
    file: "src/lib/storage.ts",
    from: "  Object.values(INTERNAL).forEach((k) => window.localStorage.removeItem(k));\n  newEpoch();",
    to: "  Object.values(INTERNAL).forEach((k) => window.localStorage.removeItem(k));",
  },
  {
    name: "a tab is not reloaded when the browser changes hands (or is cleared) in another tab",
    file: "src/lib/account/client.ts",
    from: "  const offHands = onBrowserChangedHandsElsewhere(() => on.reload());",
    to: "  const offHands = () => {};",
  },
  {
    name: "what a sync said is lost in the reload it caused",
    file: "src/lib/account/client.ts",
    from: "      const carried = first ? takeCarriedNote() : null;",
    to: "      const carried = null;",
  },
  {
    name: "pinned meals in the wrong shape pass validation (the Week board crashes on every device)",
    file: "src/lib/account/validate.ts",
    from: "  if (!optList(v.lockedMeals, (m) => isObj(m) && isDay(m.day) && isMealType(m.mealType) && isStr(m.name))) {",
    to: "  if (false) {",
  },
  {
    name: "a meal description that is not text passes validation (Today crashes)",
    file: "src/lib/account/validate.ts",
    from: "    optStr(m.description) &&",
    to: "",
  },
  {
    name: "a week's notes in the wrong shape pass validation",
    file: "src/lib/account/validate.ts",
    from: "  if (!optList(v.notes, isStr)) return",
    to: "  if (false) return",
  },
  {
    name: "a stale tab's sync can still mark stores synced in the new generation",
    file: "src/lib/storage.ts",
    from: "  if (!fenceHolds()) return; // a stale tab's sync must not write into the new generation's bookkeeping",
    to: "",
  },
  {
    name: "a stale tab can still put a copy back into the new generation",
    file: "src/lib/storage.ts",
    from: "  if (!b || !fenceHolds()) return false;",
    to: "  if (!b) return false;",
  },
  {
    name: "a stale tab can still take a copy, which can push the set-aside data out of the three kept",
    file: "src/lib/storage.ts",
    from: "  if (!fenceHolds()) throw new Error(CHANGED_HANDS);",
    to: "",
  },
  {
    name: "a stale tab's late sync can still make the previous account this browser's owner",
    file: "src/lib/storage.ts",
    from: "  if (!fenceHolds()) return; // a stale tab's late sync must not make the previous account the owner",
    to: "",
  },
  {
    name: "a tab that has only listed the copies adopts the new generation at its first write",
    file: "src/lib/storage.ts",
    from: "    knowEpoch(); // what a tab has read is what it may write back: THE WRITE FENCE\n",
    to: "",
  },
  {
    name: "a browser with storage blocked crashes on load (the read pin outside readKey's try)",
    file: "src/lib/storage.ts",
    from: "  try {\n    // Inside the try:",
    to: "  knowEpoch();\n  try {\n    // Inside the try:",
  },
  {
    name: "saving a recipe that is already saved un-saves it (add is a toggle)",
    file: "src/lib/savedStore.ts",
    from: "    if ((await this.list()).includes(name)) return;\n",
    to: "",
  },
  {
    name: "removing a recipe that isn't saved saves it (remove is a toggle)",
    file: "src/lib/savedStore.ts",
    from: "    if (!(await this.list()).includes(name)) return;\n",
    to: "",
  },
  {
    name: "anything in the saved list is shown as a saved recipe, names or not",
    file: "src/lib/savedStore.ts",
    from: 'raw.filter((x): x is string => typeof x === "string")',
    to: "(raw as string[])",
  },
  {
    name: "saves say 'in this browser' even when signed in",
    file: "src/lib/savedStore.ts",
    from: '  return signedIn ? { ...localSavedStore, kind: "account" } : localSavedStore;',
    to: "  return localSavedStore;",
  },
];

// node scripts/mutate-account.mjs [root] [--only "text|other text"]: --only runs the mutations whose
// name contains any of the |-separated texts, so re-checking one guard does not take the whole run.
const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args.splice(onlyAt, 2)[1].split("|") : null;
const root = args[0] ?? process.cwd();
const chosen = only ? MUTATIONS.filter((m) => only.some((t) => m.name.includes(t))) : MUTATIONS;
if (only) console.log(`--only: ${chosen.length} of ${MUTATIONS.length} mutations`);
let allCaught = chosen.length > 0;
for (const m of chosen) {
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
  let crashed = false;
  try {
    out = execFileSync("node", ["scripts/test-account.mjs"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String(e.stdout ?? "");
    // Non-zero exit with no FAIL line: a suite stopped on an uncaught throw. The guard WAS detected,
    // but the checks after the throw never ran, so say so: that test should catch its error.
    crashed = !out.split("\n").some((l) => l.startsWith("FAIL"));
  } finally {
    writeFileSync(path, original, "utf8");
  }
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
  const caught = fails.length > 0 || crashed;
  if (!caught) allCaught = false;
  console.log(`${caught ? (crashed ? "CAUGHT (by a crash: make that test catch its error)" : "CAUGHT") : "MISSED"}  ${m.name}`);
  for (const f of fails.slice(0, 3)) console.log(`          ${f.slice(0, 150)}`);
}
console.log(allCaught ? "\nevery mutation was caught" : "\nSOME MUTATIONS WERE NOT CAUGHT");
if (!allCaught) process.exit(1);
