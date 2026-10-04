/**
 * Accounts-lane test suite — `node scripts/test-account.mjs`.
 *
 * Proves accounts end to end with no keys and no network: the export file, the sync rules and engine,
 * storage.ts's bookkeeping, the Supabase REST client, and the real browser glue (`client.ts`) driven
 * against an in-memory fake Supabase that behaves like the real one where it matters (RLS, PKCE,
 * conditional writes, jsonb key order). Runs in plain node — `window.localStorage` is a Map — so a red
 * result can only mean the code is wrong, never that a service was down.
 *
 * Several checks here exist because an adversarial review found the bug they pin; their labels say so.
 */
import { Events, FakeSupabase, MemoryStorage, PROFILE, fakeJwt, jsonbOrder, s256, summary, week } from "./account-fakes";

// ---- a fake browser -------------------------------------------------------------------------------
// Nothing in storage.ts or client.ts touches `window` at import time, only when called, so installing
// these globals in the module body (which runs after hoisted imports) is early enough.
const memory = new MemoryStorage();
let reloads = 0;
const fakeWindow = Object.assign(new Events(), {
  localStorage: memory as MemoryStorage,
  sessionStorage: new MemoryStorage(),
  location: {
    origin: "https://ntrux.vercel.app", pathname: "/sage/account", search: "", hash: "",
    reload: () => { reloads++; },
  },
});
const fakeDocument = Object.assign(new Events(), { visibilityState: "visible" as "visible" | "hidden" });
const g = globalThis as unknown as Record<string, unknown>;
g.window = fakeWindow;
g.document = fakeDocument;
g.history = {
  replaceState: (_s: unknown, _t: string, url: string) => {
    const u = new URL(url, fakeWindow.location.origin);
    fakeWindow.location.pathname = u.pathname;
    fakeWindow.location.search = u.search;
    fakeWindow.location.hash = u.hash;
  },
};

import * as storage from "@/lib/storage";
import {
  buildExport, parseExport, applyImport, describeData, exportFilename, EXPORT_FORMAT, PORTABLE_STORES,
} from "@/lib/account/portable";
import { checkStore } from "@/lib/account/validate";
import { planSync, unionStore, canonical, nextStamp, type Side } from "@/lib/account/merge";
import {
  syncNow, createMirror, localSide, partitionBySize, pushOrIsolate, MAX_STORE_BYTES, storeBytes,
  type LocalAccess, type Remote, type RemoteRow, type PushResult,
} from "@/lib/account/sync";
import {
  readAccountConfig, requestMagicLink, readRedirect, hasAuthParams, exchangeCode, createPkcePair, freshSession,
  refreshSession, supabaseRemote, deleteAccountRemote, jwtClaims, AccountError, wellFormed, signOutRemote,
  type Session, type SessionSource,
} from "@/lib/account/supabase";
import {
  startSync, signOut, deleteAccount, completeSignInFromUrl, sendSignInLink, forgetThisBrowser, onPulled,
  accountStatus, currentSession, retrySignIn, canRetrySignIn,
} from "@/lib/account/client";
import { localSavedStore, savedStore } from "@/lib/savedStore";
import { NO_NOTICE, nextNotice, noticeText } from "@/app/sage/account/notice";
import type { AccountStatus } from "@/lib/account/client";
import type { StoreName } from "@/lib/storage";
import type { UserProfile, WeekPlan } from "@/lib/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ""}`); }
}
const json = (v: unknown) => JSON.stringify(v);
/**
 * Await a call a check is about to judge. A throw becomes null, and is printed, so the check FAILS
 * with the reason instead of the whole suite crashing: a crash hides every check after it, and the
 * mutation run (scripts/mutate-account.mjs) cannot tell which guard it was.
 */
async function mayThrow<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    console.log(`      (threw: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

// ---- fixtures ------------------------------------------------------------------------------------

// =================================================================================================
// storage.ts — the bookkeeping accounts depend on
// =================================================================================================
{
  memory.clear();
  const seen: { name: StoreName; value: unknown }[] = [];
  const off = storage.onStoreChange((c) => seen.push({ name: c.name, value: c.value }));

  storage.saveProfile(PROFILE);
  storage.savePlan(week("A"));
  check("storage: typed loaders still round-trip (API unchanged)",
    storage.loadProfile()?.targetCalories === 2000 && storage.loadPlan()?.weekSummary === "week A");
  check("storage: every save announces a change", seen.map((s) => s.name).join() === "profile,plan");
  const meta = storage.loadStoreMeta();
  check("storage: every save stamps a write time", typeof meta.profile === "number" && typeof meta.plan === "number");

  storage.toggleSaved("Shakshuka");
  storage.recordVisit("2026-10-03");
  check("storage: helper writers (toggleSaved, recordVisit) announce too",
    seen.some((s) => s.name === "saved") && seen.some((s) => s.name === "visits"));

  // An UNCHANGED value is not an edit (review: a stale screen's re-save overwrote other devices' edits).
  seen.length = 0;
  const before = storage.loadStoreMeta().plan;
  storage.savePlan(JSON.parse(JSON.stringify(week("A"))));
  storage.saveProfile({ ...PROFILE }); // same content, keys in the same order
  storage.saveProfile(Object.fromEntries(Object.entries(PROFILE).reverse()) as UserProfile); // same content, other key order
  check("storage: re-saving identical content announces nothing (it is not an edit)", seen.length === 0, json(seen.map((s) => s.name)));
  check("storage: …and leaves the write time alone, so a stale copy can't look newest", storage.loadStoreMeta().plan === before);
  storage.saveGroceriesChecked([]);
  check("storage: an empty list over a store that doesn't exist creates nothing",
    seen.length === 0 && storage.readStore("groceriesChecked") === null && storage.loadStoreMeta().groceriesChecked === undefined);
  storage.saveGroceriesChecked(["eggs"]);
  storage.saveGroceriesChecked([]);
  check("storage: but emptying a list that HAD items is a real edit", seen.filter((s) => s.name === "groceriesChecked").length === 2);

  seen.length = 0;
  storage.writeStore("chat", [{ role: "user", text: "hi" }], { at: 5, silent: true });
  check("storage: a silent write (from the account) is NOT announced — or sync would echo it back", seen.length === 0);
  check("storage: a silent write keeps the timestamp it was given", storage.loadStoreMeta().chat === 5);

  off();
  storage.savePlan(week("B"));
  check("storage: unsubscribing stops notifications", seen.length === 0);

  check("storage: STORE_NAMES is the export contract, and matches portable.ts",
    json([...storage.STORE_NAMES].sort()) === json([...PORTABLE_STORES].sort()));
  check("storage: bookkeeping keys never appear among user stores",
    !storage.STORE_NAMES.some((n) => ["meta", "synced", "backup", "session", "owner", "pkce"].includes(n)));

  const imp = storage.rememberImport({ name: "R", sourceUrl: "https://e.com/r", servings: 1, ingredients: [], steps: [] } as never);
  check("storage: an imported recipe is stamped with when it was imported", typeof (imp[0] as { importedAt?: number }).importedAt === "number");
}

// A browser where touching storage throws at all (Safari with site data blocked, some private modes):
// every load comes back empty rather than crashing the screen. The write fence's read pin once sat
// outside readKey's try, and every load threw (batch 4, found by re-reading the change).
{
  const plain = Object.getOwnPropertyDescriptor(fakeWindow, "localStorage")!;
  Object.defineProperty(fakeWindow, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  let loads: string;
  try {
    loads = json([storage.loadPlan(), storage.loadProfile(), storage.loadSaved(), storage.loadBackups(), storage.loadSyncOwner()]);
  } catch (e) {
    loads = `threw ${(e as Error).name}`;
  }
  Object.defineProperty(fakeWindow, "localStorage", plain);
  check("storage: with storage blocked, every load comes back empty instead of throwing", loads === json([null, null, [], [], null]), loads);
}

// restore — and the rule that a restore never creates a deletion
{
  memory.clear();
  storage.saveProfile(PROFILE);
  storage.savePlan(week("MINE"));
  const b = storage.takeBackup("before a test");
  check("backup: snapshots the stores that hold data", b.data.plan !== undefined && b.data.profile !== undefined);
  check("backup: does not invent stores that were empty", !("batchPlan" in b.data));

  storage.savePlan(week("REPLACED"));
  storage.saveBatchPlan(week("NEW-BATCH"));
  storage.markSynced("batchPlan", 123);
  const announced: { name: StoreName; value: unknown }[] = [];
  const off = storage.onStoreChange((c) => announced.push({ name: c.name, value: c.value }));
  check("restore: reports success", storage.restoreBackup() === true);
  off();
  check("restore: the replaced week is back", storage.loadPlan()?.weekSummary === "week MINE");
  check("restore: a store the copy didn't hold is gone from this device", storage.loadBatchPlan() === null);
  check("restore: …FORGOTTEN, not cleared — no write time or sync marker left, so the next sync pulls it back",
    storage.loadStoreMeta().batchPlan === undefined && storage.loadSyncedAt().batchPlan === undefined);
  check("restore: NEVER announces a deletion (review: 'Put it back' nulled the account on every device)",
    !announced.some((a) => a.value === null), json(announced.map((a) => `${a.name}:${a.value === null ? "null" : "value"}`)));
  check("restore: what the copy held IS announced, so it reaches the account", announced.some((a) => a.name === "plan"));
  check("restore: the backup is consumed, so it cannot be applied twice", storage.loadBackup() === null && storage.restoreBackup() === false);
}

// clearAll is local and silent
{
  memory.clear();
  storage.saveProfile(PROFILE);
  storage.saveSessionRaw({ access_token: "x" });
  storage.saveSyncOwner("someone");
  storage.markSynced("profile", 1);
  storage.takeBackup("x");
  const seen: StoreName[] = [];
  const off = storage.onStoreChange((c) => seen.push(c.name));
  storage.clearAll();
  off();
  // Everything but the new data generation (storage.ts, THE WRITE FENCE): a random id, no data, and
  // the very thing that stops another tab writing the old data back.
  check("clearAll: empties every nutriflow key, including backups, meta, synced, owner and session",
    memory.keys().every((k) => k === "nutriflow.epoch"), memory.keys().join());
  check("clearAll: …and starts a new data generation, so a tab still holding the old data can't write it back",
    memory.keys().join() === "nutriflow.epoch", memory.keys().join());
  check("clearAll: is SILENT — clearing a device must never empty the account as a side effect", seen.length === 0);
}

// the backup LIST (a single slot let a later backup overwrite the only copy of something)
{
  memory.clear();
  storage.savePlan(week("ONE"));
  const b1 = storage.takeBackup("first");
  storage.savePlan(week("TWO"));
  const b2 = storage.takeBackup("second");
  storage.savePlan(week("THREE"));
  storage.takeBackup("third");
  storage.savePlan(week("FOUR"));
  storage.takeBackup("fourth");
  const list = storage.loadBackups();
  check("backups: only the last three are kept, newest first", list.map((b) => b.reason).join() === "fourth,third,second");
  check("backups: ids are unique even when taken in the same millisecond", new Set(list.map((b) => b.id)).size === 3);
  check("backups: an older copy survives a newer backup (the single-slot bug)", list.some((b) => b.id === b2.id) && !list.some((b) => b.id === b1.id));

  storage.savePlan(week("NOW"));
  check("restore by id: puts back THAT copy, not the newest", storage.restoreBackup(b2.id) && storage.loadPlan()?.weekSummary === "week TWO");
  check("restore by id: only that copy is consumed", storage.loadBackups().map((b) => b.reason).join() === "fourth,third");
  storage.discardBackup(storage.loadBackups()[0].id);
  check("discard by id: forgets just that one", storage.loadBackups().map((b) => b.reason).join() === "third");

  // "Put it back" on the OLDEST of three copies (review 2, found twice: the safety copy taken first
  // evicted the very copy being put back, so the button destroyed it and restored nothing, silently).
  memory.clear();
  storage.savePlan(week("OLDEST"));
  storage.takeBackup("first");
  storage.savePlan(week("MIDDLE"));
  storage.takeBackup("second");
  storage.savePlan(week("NEWEST"));
  storage.takeBackup("third");
  storage.savePlan(week("NOW"));
  const oldest = storage.loadBackups()[2];
  const putBack = storage.putBackCopy(oldest.id, "before putting back the oldest copy");
  check("put back: the OLDEST of three copies comes back (the safety copy taken first must not evict it)",
    putBack && storage.loadPlan()?.weekSummary === "week OLDEST",
    json({ putBack, plan: storage.loadPlan()?.weekSummary, copies: storage.loadBackups().map((b) => b.reason) }));
  check("put back: …and what was here a moment ago is kept as a copy",
    storage.loadBackups().some((b) => summary(b.data.plan) === "week NOW"));
  check("put back: …and no OTHER copy was pushed out for it (the one put back is used up, freeing its own place)",
    storage.loadBackups().map((b) => b.reason).join() === "before putting back the oldest copy,third,second",
    storage.loadBackups().map((b) => b.reason).join());
  check("put back: a copy that no longer exists changes nothing and says so", storage.putBackCopy(-1, "x") === false);

  // The older single-object shape (shipped in eac9bb8) still reads as a one-item list.
  memory.setItem("nutriflow.backup", JSON.stringify({ reason: "legacy", takenAt: 5, data: { saved: ["x"] } }));
  const legacy = storage.loadBackups();
  check("backups: the older single-backup shape still loads", legacy.length === 1 && legacy[0].reason === "legacy" && legacy[0].id === 5);

  // Quota: when the browser is full, OLD copies give way; if not even one fits, nothing is replaced.
  memory.clear();
  storage.savePlan(week("BIG"));
  storage.takeBackup("a");
  storage.takeBackup("b");
  const planSize = JSON.stringify(week("BIG")).length;
  memory.quota = planSize * 3.5; // room for the plan itself, meta, and two backups of it — not three
  storage.takeBackup("c");
  const afterQuota = storage.loadBackups();
  check("quota: the oldest copies are dropped to make room, the new one is kept",
    afterQuota[0].reason === "c" && afterQuota.length < 3, afterQuota.map((b) => b.reason).join());
  memory.quota = planSize * 1.5; // the plan fits; a backup of it does not
  let threw = "";
  try { storage.takeBackup("d"); } catch (e) { threw = (e as Error).message; }
  check("quota: when not even one copy fits, takeBackup refuses loudly", threw.includes("room"));
  check("quota: …and the existing data is untouched", storage.loadPlan()?.weekSummary === "week BIG");
  memory.quota = Infinity;
}

// =================================================================================================
// portable.ts + validate.ts — the export file, and what counts as a valid store
// =================================================================================================
{
  memory.clear();
  storage.saveProfile(PROFILE);
  storage.savePlan(week("A"));
  storage.toggleSaved("Shakshuka");
  storage.recordVisit("2026-10-01");
  storage.saveSessionRaw({ access_token: "SECRET" });

  const bundle = buildExport((n) => storage.readStore(n), new Date("2026-10-03T12:00:00Z"));
  const text = JSON.stringify(bundle);
  check("export: carries the format marker and version", bundle.format === EXPORT_FORMAT && bundle.version === 1);
  check("export: includes every store that has data", ["profile", "plan", "saved", "visits"].every((n) => n in bundle.data));
  check("export: omits empty stores rather than writing nulls", !("batchPlan" in bundle.data) && !("chat" in bundle.data));
  check("export: NEVER contains the session token", !text.includes("SECRET") && !text.includes("access_token"));
  check("export: filename is dated", /^nutriflow-\d{4}-\d{2}-\d{2}\.json$/.test(exportFilename(new Date())));

  memory.clear();
  storage.saveBatchPlan(week("KEEP-ME"));
  const parsed = parseExport(text);
  check("import: a genuine export parses", parsed.ok);
  if (parsed.ok) {
    check("import: lists exactly the stores in the file", json(parsed.stores.sort()) === json(["plan", "profile", "saved", "visits"]));
    const written = applyImport(parsed.bundle, (n, v) => storage.writeStore(n, v));
    check("import: writes what it lists", written.length === 4);
    check("import: round trip is identical", json(storage.loadPlan()) === json(week("A")) && json(storage.loadProfile()) === json(PROFILE));
    check("import: a store the file does NOT carry is left alone", storage.loadBatchPlan()?.weekSummary === "week KEEP-ME");
  }
  check("describe: counts read off the data", json(describeData(bundle.data)) ===
    json(["Ana's profile (2000 kcal a day)", "a week plan (7 days)", "1 saved recipe", "1 day of visit history"]),
    json(describeData(bundle.data)));
}

// parseExport refuses bad input — and refuses it WHOLE
{
  const good = (data: Record<string, unknown>) => JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: "", data });
  const err = (t: string) => { const r = parseExport(t); return r.ok ? "" : r.error; };

  check("reject: not JSON", err("{nope").includes("isn't a NutriFlow export"));
  check("reject: JSON from somewhere else", err(JSON.stringify({ hello: 1 })).includes("isn't a NutriFlow export"));
  check("reject: a newer format version, with advice", err(JSON.stringify({ format: EXPORT_FORMAT, version: 99, data: {} })).includes("newer version"));
  check("reject: an empty export", err(good({})).includes("empty"));
  check("reject: a profile with no calorie target", err(good({ profile: { ...PROFILE, targetCalories: "lots" } })).includes("calorie target"));
  check("reject: a profile missing its allergies (plan building would crash on it)",
    err(good({ profile: { ...PROFILE, allergies: undefined } })).includes("allergies"));
  check("reject: a week plan in the wrong shape", err(good({ plan: { days: "Monday" } })).includes("week plan"));
  check("reject: a week plan with a meal missing its numbers",
    err(good({ plan: { ...week("X"), days: [{ day: "Monday", meals: [{ name: "x", type: "lunch" }] }] } })).includes("meal"));
  check("reject: visits that aren't dates", err(good({ visits: ["yesterday"] })).includes("isn't a date"));
  check("reject: an imported recipe whose link isn't a web address (it crashes /plan when opened)",
    err(good({ imports: [{ name: "Tasty", sourceUrl: "tasty" }] })).includes("imported recipe"));
  check("reject: a file over the size cap", err("x".repeat(5_000_001)).includes("too large"));

  const mixed = parseExport(good({ saved: ["A"], plan: { days: 3 } }));
  check("reject WHOLE: one bad store means nothing is imported", !mixed.ok && mixed.error.startsWith("Nothing was imported"));

  const future = parseExport(good({ saved: ["A"], streakBadges: [1] }));
  check("unknown store: skipped with a warning, not fatal", future.ok && future.warnings.length === 1 && future.stores.join() === "saved");

  // Review 2: a file carrying an explicit null passed validation (null is fine for an ACCOUNT row, a
  // deliberate clear) and deleted that store everywhere while the preview mentioned nothing. A real
  // export never contains one, so a file that does is refused.
  check("reject: a file carrying a cleared (null) store — a real export never does, and it deleted that store everywhere",
    err(good({ saved: ["A"], plan: null })).startsWith("Nothing was imported"), err(good({ saved: ["A"], plan: null })));
  // Empty lists ARE in real exports (a reset chat, the last recipe unsaved). The preview hid them, and
  // bringing the file in then cleared those stores here and on every device.
  const empties = parseExport(good({ plan: week("E"), saved: [], chat: [] }));
  const told = empties.ok ? describeData(empties.bundle.data, { incoming: true }) : [];
  check("describe: an empty list the file carries is named, with what bringing it in does",
    told.some((d) => d.includes("saved recipes") && d.includes("clears")) && told.some((d) => d.includes("chat") && d.includes("clears")),
    json(told));

  check("validate: a cleared store (null) is always acceptable", checkStore("plan", null) === null);

  // Review 2 (security-4): these shapes passed, were mirrored to the account, were pulled by every
  // device, and crashed the Week board, the meal sheet and Today on all of them.
  const bad = (name: StoreName, v: unknown) => checkStore(name, v) !== null;
  check("validate: a profile whose pinned meals are not a list is refused (the Week board calls .some on them)",
    bad("profile", { ...PROFILE, lockedMeals: { Monday: "dinner" } }));
  check("validate: a profile whose ratings are not a list is refused (the meal sheet calls .find on them)",
    bad("profile", { ...PROFILE, mealRatings: "loved the stew" }));
  check("validate: remembered notes and body measurements in the wrong shape are refused",
    bad("profile", { ...PROFILE, memory: ["IBS"] }) && bad("profile", { ...PROFILE, bodyStats: { weightKg: "70" } }));
  const oddMeal = { ...week("ODD"), days: [{ day: "Monday", meals: [{ ...week("ODD").days[0].meals[0], description: { note: "x" } }] }] };
  check("validate: a meal whose description is not text is refused (Today renders it as text)", bad("plan", oddMeal));
  check("validate: a week whose notes are not a list of sentences is refused", bad("batchPlan", { ...week("N"), notes: "cook sunday" }));
  check("validate: a meal-prep schedule in the wrong shape is refused", bad("batchPlan", { ...week("S"), sessions: [{ id: 1 }] }));
  // The review of batches 4-5 found these four untested: each check could be removed, suites still green.
  const withMeal = (extra: object) => ({ ...week("M"), days: [{ day: "Monday", meals: [{ ...week("M").days[0].meals[0], ...extra }] }] });
  check("validate: a meal whose recipe link is not http(s) is refused (/plan renders it as a link)",
    bad("plan", withMeal({ sourceUrl: "javascript:alert(1)" })));
  check("validate: a week with a planning mode this app doesn't know is refused", bad("plan", { ...week("PM"), planMode: "monthly" }));
  check("validate: a profile with meal-prep settings this app doesn't know is refused",
    bad("profile", { ...PROFILE, planMode: "monthly" }) && bad("profile", { ...PROFILE, batchCadence: "hourly" }));
  check("validate: a profile whose targets are not numbers is refused", bad("profile", { ...PROFILE, carbsGrams: "lots" }));
  const fullProfile = {
    ...PROFILE, name: "Ana", planMode: "batch", batchCadence: "weekly", fiberGrams: 30,
    lockedMeals: [{ day: "Sunday", mealType: "dinner", name: "Roast chicken" }],
    mealRatings: [{ name: "Tofu stir-fry", rating: 1 }],
    memory: [{ fact: "IBS, avoids onions", kind: "condition", since: "2026-10-01" }],
    bodyStats: { age: 34, heightCm: 170, weightKg: 68, sex: "female", activity: "moderate" },
  };
  check("validate: a real, complete profile still passes", checkStore("profile", fullProfile) === null, String(checkStore("profile", fullProfile)));
  const prep = {
    ...week("PREP"), planMode: "batch", notes: ["Cook on Sunday"],
    sessions: [{ id: "s1", cookDay: "Sunday", coversDays: ["Monday", "Tuesday"] }],
    batches: [{
      id: "b1", sessionId: "s1", recipeName: "Chili", slot: "dinner", totalServings: 4, servingFactor: 1,
      perServing: { calories: 600, proteinGrams: 40, carbsGrams: 50, fatGrams: 20 },
      placements: [{ day: "Monday", slot: "dinner" }, { day: "Tuesday", slot: "dinner", frozen: true }],
    }],
  };
  check("validate: a real meal-prep week still passes", checkStore("batchPlan", prep) === null, String(checkStore("batchPlan", prep)));
  check("validate: a real week and a real import pass",
    checkStore("plan", week("OK")) === null && checkStore("imports", [{ name: "R", sourceUrl: "https://e.com/r", ingredients: [], steps: [] }]) === null);
}

// =================================================================================================
// notice.ts — what the account says on every /sage screen (the review of batches 4-5)
// =================================================================================================
{
  const inState = (state: AccountStatus["state"], message?: string): AccountStatus => ({ state, email: "a@e.com", userId: "uid-a", message });
  const out = (message?: string): AccountStatus => ({ state: "signed-out", message });
  const replaced = "Your account had newer data, so it replaced some of what was on this device.";
  let n = nextNotice(NO_NOTICE, inState("saved", replaced));
  n = nextNotice(n, inState("pending"));
  n = nextNotice(n, inState("saved"));
  check("notice: a one-off note outlives the routine 'pending' and 'saved' that follow it", noticeText(n, inState("saved")) === replaced);
  const dismissed = { ...n, dismissed: replaced };
  check("notice: …until it is dismissed", noticeText(dismissed, inState("saved")) === null);
  check("notice: a NEW note shows even if an earlier one with the same words was dismissed",
    noticeText(nextNotice(dismissed, inState("saved", replaced)), inState("saved")) === replaced);
  check("notice: a note said while signed in is dropped once the person signs out", noticeText(nextNotice(n, out()), out()) === null);
  const offline = inState("offline", "Couldn't reach your account.");
  const whileOffline = nextNotice(NO_NOTICE, offline);
  check("notice: a condition (offline) shows while it lasts", noticeText(whileOffline, offline) === "Couldn't reach your account.");
  check("notice: …and goes by itself when it is over: it is not kept like a one-off note",
    noticeText(nextNotice(whileOffline, inState("saved")), inState("saved")) === null);
  check("notice: a condition wins over a kept note: it is what is true now", noticeText(n, offline) === "Couldn't reach your account.");
  check("notice: a dismissed condition stays dismissed while it repeats itself",
    noticeText(nextNotice({ ...whileOffline, dismissed: "Couldn't reach your account." }, offline), offline) === null);
  const why = "This account was deleted, perhaps on another device.";
  check("notice: a sign-out's reason is kept while signed out", noticeText(nextNotice(NO_NOTICE, out(why)), out()) === why);
}

// =================================================================================================
// merge.ts — the rules
// =================================================================================================
{
  const v = (value: unknown, at: number) => ({ value, at });
  const kinds = (s: Side, r: Side) => planSync(s, r, 1000).actions.map((a) => `${a.name}:${a.kind}`).join(",");

  check("rule 1: local only → push", kinds({ plan: v("L", 5) }, {}) === "plan:push");
  check("rule 1: remote only → pull", kinds({}, { plan: v("R", 5) }) === "plan:pull");
  check("rule 1: first sync with an empty account uploads EVERYTHING",
    kinds({ plan: v("L", 1), profile: v("P", 1), saved: v(["a"], 1) }, {}) === "plan:push,profile:push,saved:push");
  check("rule 1: a cleared store the account never had is not sent", kinds({ plan: v(null, 5) }, {}) === "");
  check("same value both sides → nothing", kinds({ plan: v("X", 1) }, { plan: v("X", 9) }) === "");
  check("same CONTENT in a different key order → nothing (jsonb reorders keys)",
    kinds({ profile: v({ a: 1, bb: 2 }, 5) }, { profile: v({ bb: 2, a: 1 }, 5) }) === "");
  check("canonical: key order ignored, array order kept",
    canonical({ b: 1, a: [2, 1] }) === canonical({ a: [2, 1], b: 1 }) && canonical([1, 2]) !== canonical([2, 1]));

  check("rule 2: local newer → push", kinds({ plan: v("L", 9) }, { plan: v("R", 5) }) === "plan:push");
  check("rule 2: remote newer → pull", kinds({ plan: v("L", 5) }, { plan: v("R", 9) }) === "plan:pull");
  check("rule 2: a newer CLEAR wins — deleting on one device deletes everywhere",
    (() => { const a = planSync({ saved: v(null, 9) }, { saved: v(["a"], 5) }, 0).actions[0]; return a.kind === "push" && a.value === null; })());
  check("rule 4: a tie goes to the account", kinds({ plan: v("L", 5) }, { plan: v("R", 5) }) === "plan:pull");

  check("rule 5: replacing an edit the account never saw asks for a backup",
    planSync({ plan: v("L", 7) }, { plan: v("R", 9) }, 0, { plan: 5 }).needsBackup);
  check("rule 5: replacing a value the account ALREADY had takes no backup (review: routine pulls evicted real backups)",
    !planSync({ plan: v("L", 5) }, { plan: v("R", 9) }, 0, { plan: 5 }).needsBackup);
  check("rule 5: data never synced at all (legacy, at 0) is backed up", planSync({ plan: v("L", 0) }, { plan: v("R", 9) }, 0).needsBackup);
  check("rule 5: pulling into an EMPTY slot needs no backup", !planSync({}, { plan: v("R", 9) }, 0).needsBackup);
  check("rule 5: pushing never needs a backup", !planSync({ plan: v("L", 9) }, { plan: v("R", 5) }, 0).needsBackup);
  // Rule 6 (review 2): a push that replaces an account copy this device never agreed on keeps that copy.
  check("rule 6: pushing over an account copy this device never saw keeps that copy here",
    json(planSync({ saved: v(["mine"], 9) }, { saved: v(["theirs"], 5) }, 0).keepAccountCopy) === json({ saved: ["theirs"] }));
  check("rule 6: …but not the version this device already agreed on (that is only its own edit's predecessor)",
    json(planSync({ saved: v(["mine"], 9) }, { saved: v(["theirs"], 5) }, 0, { saved: 5 }).keepAccountCopy) === "{}");

  const visits = planSync({ visits: v(["2026-10-03", "2026-10-01"], 9) }, { visits: v(["2026-10-02"], 5) }, 77).actions[0];
  check("rule 3: visit history is UNIONED, not overwritten",
    visits.kind === "merge" && json(visits.value) === json(["2026-10-03", "2026-10-02", "2026-10-01"]) && visits.at === 77, json(visits));
  const subset = planSync({ visits: v(["2026-10-02"], 9) }, { visits: v(["2026-10-02", "2026-10-01"], 5) }, 77).actions[0];
  check("rule 3: a union equal to one side is a plain pull/push, not a merge", subset.kind === "pull");
  const imports = unionStore("imports",
    [{ name: "a", sourceUrl: "u1" }, { name: "b", sourceUrl: "u2" }],
    [{ name: "b-old", sourceUrl: "u2" }, { name: "c", sourceUrl: "u3" }]) as { name: string }[];
  check("rule 3: imports dedupe by link; unstamped entries keep this device's first", imports.map((i) => i.name).join() === "a,b,c");

  // Recency, not side (review: a full local history dropped another device's newest import forever).
  const full = Array.from({ length: 24 }, (_, i) => ({ name: `old${i}`, sourceUrl: `o${i}`, importedAt: 1000 + i }));
  const merged = unionStore("imports", full, [{ name: "NEWEST", sourceUrl: "n", importedAt: 9999 }]) as { name: string }[];
  check("rule 3: the newest import from another device survives a FULL local history",
    merged.length === 24 && merged[0].name === "NEWEST", merged.slice(0, 2).map((m) => m.name).join());

  // CLOCKS (lesson 57; reproduced first: a slow clock lost edits silently, a fast one locked stores).
  check("nextStamp: a write takes the clock's time…", nextStamp(1000, 400) === 1000 && nextStamp(1000, undefined) === 1000);
  check("nextStamp: …but is never stamped earlier than the value it replaces, whatever the clock says",
    nextStamp(1000, 5000) === 5001 && nextStamp(1000, 1000) === 1001);
  const pastFast = planSync({ visits: v(["2026-10-02"], 9) }, { visits: v(["2026-10-03"], 5000) }, 77).actions[0];
  check("clocks: a union is stamped later than BOTH copies, so the account takes it even when one came from a clock running ahead",
    pastFast.kind === "merge" && pastFast.at === 5001, json(pastFast));
  const olderSuperset = planSync({ visits: v(["2026-10-02", "2026-10-01"], 5) }, { visits: v(["2026-10-01"], 9) }, 7).actions[0];
  check("clocks: a device holding the whole union under an OLDER stamp writes it stamped past the account's (a push would be skipped forever)",
    olderSuperset.kind === "merge" && olderSuperset.at === 10, json(olderSuperset));
  const dup = unionStore("imports", [{ name: "x-old", sourceUrl: "x", importedAt: 1 }], [{ name: "x-new", sourceUrl: "x", importedAt: 2 }]) as { name: string }[];
  check("rule 3: the same link imported twice keeps the more recent entry", dup.length === 1 && dup[0].name === "x-new");
}

// =================================================================================================
// sync.ts — the engine, with fake devices and a fake server
// =================================================================================================
/**
 * What Postgres `jsonb` does to an object: it does NOT keep key order. Keys come back shorter-first,
 * then in byte order. Every fake server in this file stores values through this, because a fake that
 * kept the app's own key order is exactly what hid the "every sync takes a backup" bug.
 */

/** A fake account that writes a store only if the write is NEWER, like upsert_state (migration 0002). */
class FakeServer implements Remote {
  rows = new Map<StoreName, RemoteRow>();
  pushes = 0;
  failNext = 0;
  /** When set, every push throws this (until cleared). */
  failWith: unknown = null;
  /** A store this server refuses — a whole batch containing it fails, as one SQL statement would. */
  refuseKey: StoreName | null = null;
  async pull() { return [...this.rows.values()].map((r) => ({ ...r })); }
  async push(rows: RemoteRow[]): Promise<PushResult> {
    if (this.failWith) throw this.failWith;
    if (this.failNext > 0) { this.failNext--; throw new Error("network down"); }
    if (this.refuseKey && rows.some((r) => r.name === this.refuseKey)) throw new AccountError("refused", "rejected");
    this.pushes++;
    const skipped: StoreName[] = [];
    for (const r of rows) {
      const cur = this.rows.get(r.name);
      if (cur && cur.at >= r.at) skipped.push(r.name);
      else this.rows.set(r.name, { ...r, value: jsonbOrder(r.value) });
    }
    return { skipped };
  }
  async removeAll() { this.rows.clear(); }
}

/** An in-memory device: the LocalAccess contract without a browser. */
class FakeDevice implements LocalAccess {
  names = storage.STORE_NAMES;
  data = new Map<StoreName, unknown>();
  times: Partial<Record<StoreName, number>> = {};
  synced: Partial<Record<StoreName, number>> = {};
  backups: string[] = [];
  validate = false;
  edit(n: StoreName, v: unknown, at: number) { this.data.set(n, v); this.times[n] = at; }
  read(n: StoreName) { return this.data.has(n) ? this.data.get(n) : null; }
  meta() { return { ...this.times }; }
  syncedAt() { return { ...this.synced }; }
  markSynced(n: StoreName, at: number) { this.synced[n] = at; }
  writeSilently(n: StoreName, v: unknown, at: number) { if (v === null) this.data.delete(n); else this.data.set(n, v); this.times[n] = at; }
  backup(reason: string) { this.backups.push(reason); }
  accepts = (n: StoreName, v: unknown) => !this.validate || checkStore(n, v) === null;
}

await (async () => {
  const server = new FakeServer();
  const laptop = new FakeDevice();
  const phone = new FakeDevice();

  laptop.edit("profile", PROFILE, 100);
  laptop.edit("plan", week("LAPTOP"), 100);
  const r1 = await syncNow(laptop, server, 150);
  check("engine: first sign-in uploads the device's week", r1.pushed.join() === "plan,profile" && server.rows.size === 2);
  check("engine: …and takes no backup, because nothing local was replaced", !r1.backedUp && laptop.backups.length === 0);
  check("engine: …and marks what it pushed as in sync", laptop.synced.plan === 100 && laptop.synced.profile === 100);

  const r2 = await syncNow(phone, server, 200);
  check("engine: a second device pulls the account down", r2.pulled.join() === "plan,profile" && summary(phone.read("plan")) === "week LAPTOP");

  const quiet = await syncNow(laptop, server, 210);
  check("engine: a sync with nothing changed (and jsonb-reordered keys) does nothing at all",
    !quiet.backedUp && quiet.pulled.length === 0 && quiet.pushed.length === 0, json(quiet));

  phone.edit("plan", week("PHONE-EDIT"), 300);
  await syncNow(phone, server, 310);
  const r5 = await syncNow(laptop, server, 320);
  check("engine: an edit on one device reaches the other", summary(laptop.read("plan")) === "week PHONE-EDIT");
  check("engine: …with NO backup, because the laptop's old week was already in the account", !r5.backedUp && laptop.backups.length === 0);

  // A device with its own, unsynced week signs in to an account with a different, newer one.
  const tablet = new FakeDevice();
  tablet.edit("plan", week("TABLET-OWN"), 50);
  const r3 = await syncNow(tablet, server, 400);
  check("engine: the newer account week wins on a device with an older week", summary(tablet.read("plan")) === "week PHONE-EDIT");
  check("engine: …but the device's own week is BACKED UP first, never silently lost", r3.backedUp && tablet.backups.length === 1);

  const old = new FakeDevice();
  old.data.set("plan", week("LEGACY"));
  const side = localSide(old);
  check("engine: legacy data with no timestamp is treated as oldest", side.plan?.at === 0);
  const r4 = await syncNow(old, server, 500);
  check("engine: …and is backed up before the account replaces it", r4.backedUp);

  // An edit made DURING the pull survives: the local side is read after the pull returns.
  const racer = new FakeDevice();
  racer.edit("saved", ["mine"], 1);
  const slow: Remote = {
    pull: async () => { racer.edit("saved", ["mine", "during-pull"], 600); return server.pull(); },
    push: (rows) => server.push(rows),
    removeAll: () => server.removeAll(),
  };
  await syncNow(racer, slow, 601);
  check("engine: an edit made DURING the pull is not overwritten", json(racer.read("saved")) === json(["mine", "during-pull"]));

  // Cancelled after the pull: nothing applied, nothing pushed.
  const fresh = new FakeDevice();
  const pushesBefore = server.pushes;
  const cancelled = await syncNow(fresh, server, { stillCurrent: () => false });
  check("engine: a sync cancelled mid-flight applies and pushes nothing", !!cancelled.cancelled && fresh.data.size === 0 && server.pushes === pushesBefore);

  // A stale write is skipped by the server, not applied.
  const stale = new FakeDevice();
  stale.edit("plan", week("STALE"), 250); // older than the account's 300
  stale.synced.plan = 250;
  const behind: Remote = { pull: async () => [], push: (rows) => server.push(rows), removeAll: async () => {} };
  const r6 = await syncNow(stale, behind, 700); // a pull that missed the newer row, so it pushes
  check("engine: the account keeps its newer week when a stale device pushes (review: offline phone overwrote Sunday)",
    summary(server.rows.get("plan")?.value) === "week PHONE-EDIT");
  check("engine: …and reports the store as skipped, so the caller pulls before pushing again", r6.skipped.includes("plan") && !r6.pushed.includes("plan"));

  // A malformed row from the account is not written; this device keeps its own copy.
  const careful = new FakeDevice();
  careful.validate = true;
  careful.edit("profile", PROFILE, 1);
  careful.synced.profile = 1;
  const bad = new FakeServer();
  bad.rows.set("profile", { name: "profile", value: { targetCalories: "x" }, at: 999 });
  const r7 = await syncNow(careful, bad, 1000);
  check("engine: an account row that fails validation is NOT written here", r7.invalid.includes("profile") && json(careful.read("profile")) === json(PROFILE));

  // A push that fails must not lose what was pulled or what the device had.
  const flaky = new FakeServer();
  flaky.failNext = 1;
  const d = new FakeDevice();
  d.edit("saved", ["Shakshuka"], 10);
  let threw = false;
  try { await syncNow(d, flaky, 20); } catch { threw = true; }
  check("engine: a failed push surfaces as an error (the caller shows 'offline')", threw);
  check("engine: …and the device still holds its data", json(d.read("saved")) === json(["Shakshuka"]));
})();

// A push the account SKIPPED (another device wrote between this sync's pull and its push) is not
// marked synced, so the follow-up pull that replaces it backs it up first (review 2, ui-tests-5 Y1).
await (async () => {
  const device = new FakeDevice();
  device.edit("plan", "MINE", 100);
  device.synced.plan = 50;
  let raced = false;
  const racing: Remote = {
    rows: new Map<StoreName, RemoteRow>([["plan", { name: "plan", value: "OLD", at: 50 }]]),
    async pull() {
      const out = [...(this as { rows: Map<StoreName, RemoteRow> }).rows.values()].map((r) => ({ ...r }));
      if (!raced) { raced = true; (this as { rows: Map<StoreName, RemoteRow> }).rows.set("plan", { name: "plan", value: "OTHER-DEVICE", at: 150 }); }
      return out;
    },
    async push(rows: RemoteRow[]) {
      const skipped: StoreName[] = [];
      const table = (this as { rows: Map<StoreName, RemoteRow> }).rows;
      for (const r of rows) { const cur = table.get(r.name); if (cur && cur.at >= r.at) skipped.push(r.name); else table.set(r.name, r); }
      return { skipped };
    },
    async removeAll() {},
  } as Remote & { rows: Map<StoreName, RemoteRow> };
  const first = await syncNow(device, racing, 200);
  await syncNow(device, racing, 210); // the follow-up client.ts runs after a skip
  check("engine: an edit the account skipped stays unsynced, so the follow-up pull backs it up before replacing it",
    first.skipped.includes("plan") && device.read("plan") === "OTHER-DEVICE" && device.backups.length === 1,
    json({ skipped: first.skipped, now: device.read("plan"), backups: device.backups.length }));
})();

// Routine pulls of another device's edits take no backup, however many (review 1 fix 9; ui-tests-5 Y12).
await (async () => {
  const server = new FakeServer();
  const device = new FakeDevice();
  device.edit("plan", "V1", 100);
  device.synced.plan = 100;
  server.rows.set("plan", { name: "plan", value: "V1", at: 100 });
  server.rows.set("plan", { name: "plan", value: "V2-FROM-PHONE", at: 200 });
  await syncNow(device, server, 210);
  server.rows.set("plan", { name: "plan", value: "V3-FROM-PHONE", at: 300 });
  await syncNow(device, server, 310);
  check("engine: two routine pulls in a row take no backup (each pull records what it agreed on)",
    device.backups.length === 0 && device.read("plan") === "V3-FROM-PHONE", json({ backups: device.backups.length, now: device.read("plan") }));
})();

// Clocks, through the whole engine: one device's clock runs a day fast (lesson 57).
await (async () => {
  const DAY = 86_400_000;
  const server = new FakeServer();
  const fast = new FakeDevice();
  const phone = new FakeDevice();
  fast.edit("visits", ["2026-10-03"], 1_000 + DAY);
  await syncNow(fast, server, 2_000 + DAY);
  phone.edit("visits", ["2026-10-02"], 3_000);
  await syncNow(phone, server, 4_000);
  const again = await syncNow(phone, server, 5_000);
  check("clocks: a merged store reaches the account when another device's clock runs a day fast",
    json(server.rows.get("visits")?.value) === json(["2026-10-03", "2026-10-02"]), json(server.rows.get("visits")));
  check("clocks: …and the next sync has nothing left to do (it re-sent forever before)",
    again.pushed.length + again.merged.length + again.pulled.length + again.skipped.length === 0, json(again));
})();

// ---- the live mirror, with a hand-cranked clock ---------------------------------------------------
await (async () => {
  const pending: (() => void)[] = [];
  const timers = { setTimer: (fn: () => void) => { pending.push(fn); return pending.length; }, clearTimer: () => { pending.length = 0; } };
  const server = new FakeServer();
  const statuses: string[] = [];
  const saved: string[] = [];
  const mirror = createMirror(server, { ...timers, onStatus: (s) => statuses.push(s), onSaved: (rows) => saved.push(...rows.map((r) => r.name)) });

  mirror.enqueue("plan", "v1", 1);
  mirror.enqueue("plan", "v2", 2);
  mirror.enqueue("saved", ["a"], 3);
  check("mirror: nothing is sent before the debounce fires", server.pushes === 0 && mirror.status() === "pending");
  await mirror.flush();
  check("mirror: edits to one store collapse — the LAST value is sent", server.rows.get("plan")?.value === "v2");
  check("mirror: one push for a burst of edits", server.pushes === 1);
  check("mirror: status ends 'saved', and the caller hears what was saved", mirror.status() === "saved" && saved.join() === "plan,saved");

  server.failNext = 1;
  mirror.enqueue("plan", "v3", 4);
  await mirror.flush();
  check("mirror: a failed push reports 'offline'", mirror.status() === "offline");
  check("mirror: …and keeps the edit queued, not dropped", server.rows.get("plan")?.value === "v2" && mirror.queued() === 1);
  mirror.enqueue("saved", ["a", "b"], 5);
  await mirror.flush();
  check("mirror: the late edit goes out with the next one", server.rows.get("plan")?.value === "v3" && json(server.rows.get("saved")?.value) === json(["a", "b"]));

  mirror.stop();
  mirror.enqueue("plan", "after-stop", 9);
  await mirror.flush();
  check("mirror: stopped (signed out) means nothing more is sent", server.rows.get("plan")?.value === "v3");
  check("mirror: statuses were reported as they happened", statuses.includes("saving") && statuses.includes("offline"));

  // Paused until the first full sync (review: a tab that never pulled pushed whole stale stores).
  const s2 = new FakeServer();
  const paused = createMirror(s2, { ...timers, startPaused: true });
  paused.enqueue("plan", "early", 10);
  paused.enqueue("saved", ["x"], 11);
  await paused.flush();
  check("mirror: while paused, edits queue but NOTHING is sent", s2.pushes === 0 && paused.queued() === 2);
  paused.dropSynced({ plan: 10 });
  check("mirror: edits the full sync already sent are dropped from the queue", paused.queued() === 1);
  paused.resume();
  await paused.flush();
  check("mirror: resumed, the rest goes out", s2.rows.has("saved") && !s2.rows.has("plan"));

  // Stale: the account had a newer write — reported, not blindly retried.
  const s3 = new FakeServer();
  s3.rows.set("plan", { name: "plan", value: "NEWER", at: 100 });
  const stale: string[][] = [];
  const m3 = createMirror(s3, { ...timers, onStale: (n) => stale.push(n) });
  m3.enqueue("plan", "older", 50);
  await m3.flush();
  check("mirror: a write older than the account's is skipped and reported as stale",
    s3.rows.get("plan")?.value === "NEWER" && stale.length === 1 && stale[0].join() === "plan");
})();

// size guard, refusals, and isolation
await (async () => {
  const huge = "x".repeat(MAX_STORE_BYTES + 10);
  const split = partitionBySize([
    { name: "chat", value: [{ role: "user", text: huge }], at: 1 },
    { name: "plan", value: { ok: true }, at: 1 },
    { name: "saved", value: null, at: 1 },
  ]);
  check("size guard: an oversized store is held back", split.tooLarge.join() === "chat");
  check("size guard: everything else still goes, including a cleared store", split.ok.map((r) => r.name).join() === "plan,saved");

  // Bytes, as the server counts them. `.length` counts UTF-16 units, so it under-reads every
  // non-Latin script, by 3x in Japanese (measured in real Postgres; see MAX_STORE_BYTES).
  check("storeBytes counts UTF-8: a, é, 日 and U+20000 weigh 1, 2, 3 and 4 bytes (plus the JSON quotes)",
    storeBytes("a") === 3 && storeBytes("é") === 4 && storeBytes("日") === 5 && storeBytes("\u{20000}") === 6);
  const japanese = "日".repeat(Math.ceil(MAX_STORE_BYTES / 2)); // 450k characters, 1.35 MB
  const byBytes = partitionBySize([{ name: "chat", value: [{ role: "user", text: japanese }], at: 1 }]);
  check("size guard: a Japanese chat under the cap in characters but over it in bytes stays local (else it is refused on every edit)",
    byBytes.tooLarge.join() === "chat", `${japanese.length} chars, ${storeBytes(japanese)} bytes`);

  const server = new FakeServer();
  const d = new FakeDevice();
  d.edit("chat", [{ role: "user", text: huge }], 10);
  d.edit("plan", week("SMALL"), 10);
  const rep = await syncNow(d, server, 20);
  check("syncNow: one oversized store does not block the others", server.rows.has("plan") && !server.rows.has("chat"));
  check("syncNow: …and reports which store stayed local", rep.tooLarge.join() === "chat" && !rep.pushed.includes("chat"));

  const picky = new FakeServer();
  picky.refuseKey = "imports";
  const iso = await pushOrIsolate(picky, [
    { name: "plan", value: { p: 1 }, at: 1 },
    { name: "imports", value: [{ name: "bad", sourceUrl: "x" }], at: 1 },
    { name: "saved", value: ["s"], at: 1 },
  ]);
  check("isolate: a refused batch is retried store by store", iso.refused.join() === "imports");
  check("isolate: …so every store the server DOES accept still lands", picky.rows.has("plan") && picky.rows.has("saved") && !picky.rows.has("imports"));
  picky.refuseKey = null;
  picky.failWith = new AccountError("down", "network");
  let rethrown = false;
  try { await pushOrIsolate(picky, [{ name: "plan", value: 1, at: 2 }, { name: "saved", value: 2, at: 2 }]); } catch { rethrown = true; }
  check("isolate: a NETWORK failure is not a refusal — it is rethrown so the rows stay queued", rethrown);
  picky.failWith = null;

  const errors: unknown[] = [];
  const heldSnapshots: string[] = [];
  const flaky = new FakeServer();
  const m = createMirror(flaky, {
    setTimer: () => 0, clearTimer: () => {}, onError: (e) => errors.push(e),
    onHeld: (h) => heldSnapshots.push([...h].map(([n, why]) => `${n}:${why}`).join()),
  });
  flaky.failWith = new AccountError("down", "network");
  m.enqueue("saved", ["a"], 1);
  await m.flush();
  check("mirror: a network failure is 'offline' (it will retry)", m.status() === "offline");
  check("mirror: the caller hears WHY a push failed", (errors[0] as AccountError).kind === "network");
  flaky.failWith = null;
  flaky.refuseKey = "saved";
  m.enqueue("plan", { p: 1 }, 2);
  await m.flush();
  check("mirror: the queued edit is retried with the next one, and the refused store is isolated", flaky.rows.has("plan") && !flaky.rows.has("saved"));
  check("mirror: a refused store is 'error', not 'offline' (waiting will not fix it)", m.status() === "error");
  check("mirror: …and is named as held back, with the reason", m.held().get("saved") === "refused" && heldSnapshots.at(-1) === "saved:refused");
  m.enqueue("plan", { p: 2 }, 3);
  await m.flush();
  check("mirror: the warning persists while the store is still held, even after other stores save", m.status() === "error" && m.held().has("saved"));
  flaky.refuseKey = null;
  m.enqueue("saved", ["a", "b"], 4);
  await m.flush();
  check("mirror: once an edit of the held store gets through, it is released and status is 'saved'",
    m.status() === "saved" && m.held().size === 0 && json(flaky.rows.get("saved")?.value) === json(["a", "b"]));

  const big = new FakeServer();
  const m2 = createMirror(big, { setTimer: () => 0, clearTimer: () => {} });
  m2.enqueue("chat", [{ text: huge }], 1);
  m2.enqueue("saved", ["z"], 1);
  await m2.flush();
  check("mirror: an oversized edit is held back and named, the rest still sent",
    m2.held().get("chat") === "too-large" && big.rows.has("saved") && !big.rows.has("chat") && m2.status() === "error");
})();

// =================================================================================================
// supabase.ts — the REST client, against a fake fetch
// =================================================================================================
{
  const cfg = readAccountConfig({ url: "https://proj.supabase.co/", anonKey: "ANON" })!;
  check("config: trailing slash trimmed", cfg.url === "https://proj.supabase.co");
  check("config: NO keys → null, so accounts stay off and nothing calls out", readAccountConfig({}) === null);
  check("config: a malformed URL is treated as not configured", readAccountConfig({ url: "proj.supabase.co", anonKey: "x" }) === null);
}

/** A fake JWT whose payload the client can read (the server, not the client, verifies it). */

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function fakeFetch(respond: (c: Call) => { status?: number; body?: unknown } | "throw") {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c: Call = {
      url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = respond(c);
    if (r === "throw") throw new TypeError("Failed to fetch");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

await (async () => {
  const cfg = readAccountConfig({ url: "https://proj.supabase.co", anonKey: "ANON" })!;

  // PKCE pair
  const pair = await createPkcePair();
  check("pkce: the verifier is 43–128 unreserved characters", /^[A-Za-z0-9._~-]{43,128}$/.test(pair.verifier));
  check("pkce: the challenge is the base64url SHA-256 of the verifier", pair.challenge === s256(pair.verifier));
  check("pkce: two pairs are never the same", (await createPkcePair()).verifier !== pair.verifier);

  // magic link
  const ml = fakeFetch(() => ({ body: {} }));
  await requestMagicLink(cfg, "  ana@example.com ", "https://ntrux.vercel.app/sage/account", pair.challenge, ml.f);
  const c0 = ml.calls[0];
  check("magic link: POSTs to /auth/v1/otp with the redirect", c0.method === "POST" &&
    c0.url === "https://proj.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fntrux.vercel.app%2Fsage%2Faccount");
  check("magic link: sends the anon key, the trimmed email and the PKCE challenge",
    c0.headers.apikey === "ANON" &&
    json(c0.body) === json({ email: "ana@example.com", create_user: true, code_challenge: pair.challenge, code_challenge_method: "s256" }));
  let msg = "";
  try { await requestMagicLink(cfg, "not-an-email", "x", pair.challenge, ml.f); } catch (e) { msg = (e as Error).message; }
  check("magic link: a non-address is refused before any request", msg.includes("email address") && ml.calls.length === 1);
  const limited = fakeFetch(() => ({ status: 429, body: { msg: "email rate limit exceeded" } }));
  try { await requestMagicLink(cfg, "a@b.co", "x", pair.challenge, limited.f); } catch (e) { msg = (e as Error).message; }
  check("rate limit: says 'later' (the limit is hourly), not 'a minute', and keeps the server's reason",
    msg.includes("Try again later") && !msg.includes("minute") && msg.includes("rate limit"));
  const down = fakeFetch(() => "throw");
  try { await requestMagicLink(cfg, "a@b.co", "x", pair.challenge, down.f); } catch (e) { msg = (e as Error).message; }
  check("network down: says offline, and that local data is safe", msg.includes("offline") && msg.includes("safe on this device"));

  // the landing URL
  check("redirect: ?code= is a sign-in to finish", json(readRedirect("?code=abcdefgh1234", "")) === json({ kind: "code", code: "abcdefgh1234" }));
  check("redirect: a fragment carrying tokens is NOT a sign-in (login CSRF)",
    readRedirect("", `#access_token=${fakeJwt({ sub: "evil" })}&refresh_token=R`).kind === "none");
  const spoof = readRedirect("?error=server_error&error_description=Your+account+is+suspended.+Pay+at+evil.example", "");
  check("redirect: an error shows OUR sentence, never text from the URL (content spoofing)",
    spoof.kind === "error" && !spoof.message.includes("suspended") && !spoof.message.includes("evil"));
  const expired = readRedirect("?error=access_denied&error_code=otp_expired&error_description=x", "");
  check("redirect: a known error code picks the matching fixed sentence", expired.kind === "error" && expired.message.includes("expired"));
  check("redirect: …and an expired link says only the newest link works (GoTrue retires the earlier one), not just 'ask again'",
    expired.kind === "error" && expired.message.includes("only the newest link"), expired.kind === "error" ? expired.message : "");
  check("redirect: errors mirrored into the fragment are read too", readRedirect("", "#error=access_denied&error_code=otp_expired").kind === "error");
  check("redirect: an ordinary URL is nothing", readRedirect("?tab=2", "#section").kind === "none");
  check("hasAuthParams: spots code, error and token params, ignores the rest",
    hasAuthParams("?code=x", "") && hasAuthParams("", "#access_token=x") && hasAuthParams("?error=y", "") && !hasAuthParams("?tab=2", "#top"));

  // exchanging the code
  const token = fakeJwt({ sub: "user-1", email: "ana@example.com" });
  const ex = fakeFetch((c) => (c.url.endsWith("/auth/v1/token?grant_type=pkce")
    ? { body: { access_token: token, refresh_token: "R1", expires_in: 3600, user: { id: "user-1", email: "ana@example.com" } } }
    : { status: 404 }));
  const s = await exchangeCode(cfg, "CODE123", pair.verifier, ex.f, 1000);
  check("exchange: POSTs the code and the verifier to grant_type=pkce", json(ex.calls[0].body) === json({ auth_code: "CODE123", code_verifier: pair.verifier }));
  check("exchange: returns the session", s.userId === "user-1" && s.email === "ana@example.com" && s.refreshToken === "R1" && s.expiresAt === 4600);
  const wrong = fakeFetch(() => ({ status: 400, body: { error_code: "bad_code_verifier" } }));
  try { await exchangeCode(cfg, "CODE123", "nope", wrong.f); msg = ""; } catch (e) { msg = (e as Error).message; }
  check("exchange: a code from another browser (wrong verifier) is refused in plain words", msg.includes("different browser"));

  // Review 2, the platform lens (against GoTrue's own source).
  const skewed = fakeFetch(() => ({ body: { access_token: token, refresh_token: "R1", expires_in: 3600, expires_at: 999_999, user: { id: "user-1", email: "ana@example.com" } } }));
  const sk = await exchangeCode(cfg, "CODE123", pair.verifier, skewed.f, 1000);
  check("exchange: expiry is measured on THIS device's clock (now + lifetime), not on the server's expires_at",
    sk.expiresAt === 4600, String(sk.expiresAt));
  const lateLink = fakeFetch(() => ({ status: 422, body: { error_code: "flow_state_expired" } }));
  let lateErr: AccountError | null = null;
  try { await exchangeCode(cfg, "CODE123", pair.verifier, lateLink.f); } catch (e) { lateErr = e as AccountError; }
  check("exchange: a first link opened after its five minutes (422) says to ask for a new one, and is not retryable",
    !!lateErr && lateErr.message.includes("five minutes") && !lateErr.retryable, lateErr?.message ?? "no error");
  const busyEx = fakeFetch(() => ({ status: 503, body: { message: "upstream" } }));
  let busyErr: AccountError | null = null;
  try { await exchangeCode(cfg, "CODE123", pair.verifier, busyEx.f); } catch (e) { busyErr = e as AccountError; }
  check("exchange: a transient failure is retryable, and never tells anyone to open the link again",
    !!busyErr && busyErr.retryable && !busyErr.message.toLowerCase().includes("link again"), busyErr?.message ?? "no error");
  {
    const env = process.env as Record<string, string | undefined>;
    const before = { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, pub: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
    env.NEXT_PUBLIC_SUPABASE_URL = "https://p.supabase.co";
    delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
    check("config: Supabase's own variable name, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, switches accounts on",
      readAccountConfig()?.anonKey === "sb_publishable_x", json(readAccountConfig()));
    const put = (k: string, v: string | undefined) => { if (v === undefined) delete env[k]; else env[k] = v; };
    put("NEXT_PUBLIC_SUPABASE_URL", before.url);
    put("NEXT_PUBLIC_SUPABASE_ANON_KEY", before.anon);
    put("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", before.pub);
  }

  // refresh
  const t2 = fakeJwt({ sub: "user-1", email: "ana@example.com" });
  const rf = fakeFetch(() => ({ body: { access_token: t2, refresh_token: "R2", expires_in: 3600, user: { id: "user-1", email: "ana@example.com" } } }));
  const kept = await freshSession(cfg, s, rf.f, 1000);
  check("refresh: a token with time left is reused, no request", kept === s && rf.calls.length === 0);
  const renewed = await freshSession(cfg, s, rf.f, 4590);
  check("refresh: a token about to expire is refreshed", rf.calls.length === 1 && rf.calls[0].url.endsWith("/auth/v1/token?grant_type=refresh_token"));
  check("refresh: the ROTATED refresh token is kept", renewed.refreshToken === "R2" && json(rf.calls[0].body) === json({ refresh_token: "R1" }));
  let k = "";
  const dead = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
  try { await refreshSession(cfg, "R", dead.f); k = ""; } catch (e) { k = (e as AccountError).kind; }
  check("refresh: a refused refresh token means signing in again ('auth')", k === "auth");
  const busy = fakeFetch(() => ({ status: 503 }));
  try { await refreshSession(cfg, "R", busy.f); k = ""; } catch (e) { k = (e as AccountError).kind; }
  check("refresh: a busy auth server is retryable — a good session is NOT thrown away", k === "server");

  // the table
  const sess = async () => s;
  const pull = fakeFetch(() => ({ body: [{ key: "plan", value: { x: 1 }, updated_at: "2026-10-03T10:00:00.123+00:00" }] }));
  const rows = await supabaseRemote(cfg, sess, pull.f).pull();
  check("pull: reads this user's rows with the bearer token", pull.calls[0].url.includes("user_id=eq.user-1") &&
    pull.calls[0].headers.Authorization === `Bearer ${token}` && pull.calls[0].headers.apikey === "ANON");
  check("pull: PostgREST timestamps (with +00:00) become ms", rows[0].name === "plan" && rows[0].at === Date.parse("2026-10-03T10:00:00.123Z"));

  const push = fakeFetch(() => ({ body: ["chat"] }));
  const pr = await supabaseRemote(cfg, sess, push.f).push([{ name: "saved", value: ["a"], at: 0 }, { name: "chat", value: null, at: 5 }]);
  const pc = push.calls[0];
  check("push: goes through upsert_state (only newer writes win), not a blind table upsert",
    pc.method === "POST" && pc.url.endsWith("/rest/v1/rpc/upsert_state"));
  check("push: rows carry store, value and the device's write time — and NO user id (the server takes it from the token)",
    json(pc.body) === json({ rows: [
      { key: "saved", value: ["a"], updated_at: "1970-01-01T00:00:00.000Z" },
      { key: "chat", value: null, updated_at: "1970-01-01T00:00:00.005Z" },
    ] }));
  check("push: the stores the server skipped come back to the caller", json(pr) === json({ skipped: ["chat"] }));
  const none = fakeFetch(() => ({ status: 201 }));
  await supabaseRemote(cfg, sess, none.f).push([]);
  check("push: nothing to send means no request", none.calls.length === 0);

  const loneHigh = "ramen " + String.fromCharCode(0xd83c);
  const clean = wellFormed({ name: loneHigh, list: ["a" + String.fromCharCode(0) + "b", "ok"], n: 3 }) as { name: string; list: string[]; n: number };
  check("wellFormed: a lone surrogate (half an emoji) becomes U+FFFD", clean.name === "ramen " + String.fromCharCode(0xfffd));
  check("wellFormed: a NUL becomes U+FFFD, everything else untouched", clean.list[0] === "a" + String.fromCharCode(0xfffd) + "b" && clean.list[1] === "ok" && clean.n === 3);
  const whole = "noodle " + String.fromCodePoint(0x1f35c);
  check("wellFormed: a complete emoji is left alone", wellFormed(whole) === whole);
  const pushed = fakeFetch(() => ({ body: [] }));
  await supabaseRemote(cfg, sess, pushed.f).push([{ name: "imports", value: [{ name: loneHigh }], at: 0 }]);
  check("push: values are made well-formed on the way out", !JSON.stringify(pushed.calls[0].body).includes("\\ud83c"));

  const kindFor = async (status: number, src: SessionSource = sess) => {
    const ff = fakeFetch(() => ({ status, body: { message: "x" } }));
    try { await supabaseRemote(cfg, src, ff.f).push([{ name: "saved", value: [], at: 0 }]); return "none"; }
    catch (e) { return (e as AccountError).kind + ((e as AccountError).retryable ? "+retry" : ""); }
  };
  // A 401 is a refused ACCESS token, not a dead sign-in (review 2: on a device a few minutes slow,
  // every hour's 401 signed people out with a refresh token that was still good). Renew once, retry.
  {
    let renewals = 0;
    let n = 0;
    const flaky = fakeFetch(() => (n++ === 0 ? { status: 401, body: { message: "JWT expired" } } : { body: [] }));
    const renewing: SessionSource = async (o) => { if (o?.renew) renewals++; return s; };
    const out = await mayThrow(supabaseRemote(cfg, renewing, flaky.f).push([{ name: "saved", value: [], at: 0 }]));
    check("401: a refused access token is renewed once and the request retried, not treated as a sign-out",
      renewals === 1 && flaky.calls.length === 2 && Array.isArray(out?.skipped), json({ renewals, calls: flaky.calls.length }));
    const over: SessionSource = async (o) => { if (o?.renew) throw new AccountError("Your sign-in has expired.", "auth"); return s; };
    check("401: …and only a REFUSED renewal means the sign-in is over", (await kindFor(401, over)) === "auth");
    check("401: a 401 even with a just-renewed token is a retryable outage that keeps the sign-in (this app's key, say)",
      (await kindFor(401)) === "server+retry");
  }
  check("error kind: 400/403 are refusals, not retryable", (await kindFor(400)) === "rejected" && (await kindFor(403)) === "rejected");
  check("error kind: 429 and 5xx are the server's moment, retryable", (await kindFor(429)) === "server+retry" && (await kindFor(503)) === "server+retry");
  const unreachable = fakeFetch(() => "throw");
  try { await supabaseRemote(cfg, sess, unreachable.f).pull(); k = ""; } catch (e) { k = (e as AccountError).kind; }
  check("error kind: unreachable is 'network'", k === "network");

  const lo = fakeFetch(() => ({ status: 204 }));
  check("sign-out: confirmed by the server", (await signOutRemote(cfg, s, lo.f)) === true);
  check("sign-out: ends THIS browser's session only (scope=local), not every device's", lo.calls[0].url.endsWith("/auth/v1/logout?scope=local"));
  const loFail = fakeFetch(() => ({ status: 403, body: { error_code: "bad_jwt" } }));
  check("sign-out: an expired token's refusal is reported, not swallowed as success", (await signOutRemote(cfg, s, loFail.f)) === false);
  const loGone = fakeFetch(() => ({ status: 403, body: { error_code: "session_not_found" } }));
  check("sign-out: a session the server had already ended counts as ended (another tab or device signed it out)",
    (await signOutRemote(cfg, s, loGone.f)) === true);

  const del = fakeFetch(() => ({ status: 204 }));
  await deleteAccountRemote(cfg, s, del.f);
  check("delete account: calls the delete_my_account function as the user", del.calls[0].url.endsWith("/rest/v1/rpc/delete_my_account") &&
    del.calls[0].headers.Authorization === `Bearer ${token}`);
  const denied = fakeFetch(() => ({ status: 401, body: { message: "JWT expired" } }));
  try { await deleteAccountRemote(cfg, s, denied.f); msg = ""; } catch (e) { msg = (e as Error).message; }
  check("delete account: a failure says NOTHING was deleted", msg.includes("Nothing was deleted"));

  check("jwt: an unreadable token is null, not a crash", jwtClaims("garbage") === null);
})();

// =================================================================================================
// client.ts — the real browser glue, end to end, against an in-memory Supabase
// =================================================================================================

/**
 * A fake Supabase that behaves like the real one where it matters: tokens identify a user, every
 * table request is limited to that user's rows (RLS), magic links use PKCE (a code only exchanges with
 * the verifier whose SHA-256 was sent), refresh tokens rotate, writes only move a store forward in
 * time (upsert_state), values come back in jsonb key order, and deleting an account deletes its rows.
 */

const settle = () => new Promise((r) => setTimeout(r, 20));
const realNow = Date.now;
let clockOffset = 0;
/** How far the clock of the device being used right now is off true time (the clock-skew checks). */
let deviceSkew = 0;
const setClock = () => { Date.now = () => realNow() + clockOffset + deviceSkew; };
/** Move this process's clock forward, for the "come back to the tab later" checks. */
function advanceClock(ms: number) {
  clockOffset += ms;
  setClock();
}
/** Act as a device whose clock is `ms` off true time, until the next call. */
function skewClock(ms: number) {
  deviceSkew = ms;
  setClock();
}

await (async () => {
  const sb = new FakeSupabase();
  g.fetch = sb.fetch;
  const env = process.env as Record<string, string | undefined>;

  /** Sign in the way a person does: ask for a link here, then open it here. */
  async function signIn(email: string): Promise<Session | null> {
    await sendSignInLink(email);
    fakeWindow.location.search = `?code=${sb.lastCode.get(email)}`;
    return completeSignInFromUrl();
  }
  /** Leave the tab (sends what is waiting), then come back. */
  async function leaveAndReturn() {
    fakeDocument.visibilityState = "hidden";
    fakeDocument.dispatch("visibilitychange");
    await settle();
    fakeDocument.visibilityState = "visible";
  }

  // ---- no keys: everything is off and nothing is called ----
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  memory.clear();
  check("client: with NO keys, startSync is a no-op that reports 'off'", (await startSync()) === null && accountStatus().state === "off" && sb.writes === 0);
  fakeWindow.location.search = "?code=whatever";
  check("client: with NO keys, a sign-in URL is ignored and nothing is touched",
    (await completeSignInFromUrl()) === null && currentSession() === null && fakeWindow.location.search === "?code=whatever");
  fakeWindow.location.search = "";

  env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "ANON";
  check("client: keys but nobody signed in → 'signed-out'", (await startSync()) === null && accountStatus().state === "signed-out");

  // ---- login CSRF: links and tokens made by someone else must never sign this browser in ----
  memory.clear();
  storage.saveProfile(PROFILE); // the victim's private data
  const evil = sb.sessionFor("mallory@example.com");
  fakeWindow.location.hash = `#access_token=${evil.access_token}&refresh_token=${evil.refresh_token}&expires_in=3600`;
  const viaHash = await completeSignInFromUrl();
  check("login CSRF: tokens in the address are IGNORED — no session", viaHash === null && currentSession() === null);
  check("login CSRF: …and stripped from the address bar", fakeWindow.location.hash === "");
  // Mallory asks for a link in HER browser, then sends the victim the code.
  const malloryPair = await createPkcePair();
  await requestMagicLink(readAccountConfig()!, "mallory@example.com", "https://ntrux.vercel.app/sage/account", malloryPair.challenge, sb.fetch);
  fakeWindow.location.search = `?code=${sb.lastCode.get("mallory@example.com")}`;
  let csrf = "";
  try { await completeSignInFromUrl(); } catch (e) { csrf = (e as Error).message; }
  check("login CSRF: a code from someone else's browser is refused here", csrf.includes("different browser") && currentSession() === null);
  check("login CSRF: …and nothing of the victim's reached Mallory's account", sb.table("uid-mallory").size === 0);
  fakeWindow.location.search = "?error=server_error&error_description=Your+account+is+suspended";
  let spoofed = "";
  try { await completeSignInFromUrl(); } catch (e) { spoofed = (e as Error).message; }
  check("spoofing: an error in the URL is shown in OUR words only", spoofed.length > 0 && !spoofed.includes("suspended") && fakeWindow.location.search === "");

  // ---- Ana signs in on a laptop that already has her pre-account week ----
  const laptop = new MemoryStorage();
  fakeWindow.localStorage = laptop;
  storage.saveProfile(PROFILE);
  storage.savePlan(week("ANA-LAPTOP"));
  const ana = await signIn("ana@example.com");
  check("sign-in: a link this browser asked for completes", ana?.userId === "uid-ana" && currentSession()?.userId === "uid-ana");
  check("sign-in: the code is cleared from the address bar, and the verifier is used up",
    fakeWindow.location.search === "" && storage.loadPendingSignIn() === null);
  const p1 = startSync();
  check("client: a second startSync JOINS the first (one mirror per tab)", startSync() === p1);
  const r1 = await p1;
  check("first sign-in: the device's own week goes UP into the new account",
    !!r1 && r1.pushed.includes("plan") && summary(sb.table("uid-ana").get("plan")?.value) === "week ANA-LAPTOP");
  check("first sign-in: the browser now remembers it belongs to Ana", storage.loadSyncOwner() === "uid-ana");
  check("first sign-in: status 'saved'", accountStatus().state === "saved" && accountStatus().email === "ana@example.com");
  check("jsonb: the account really does hold the profile with its keys re-ordered",
    Object.keys(sb.table("uid-ana").get("profile")!.value as object).join() !== Object.keys(PROFILE).join());

  const backupsBefore = storage.loadBackups().length;
  const quiet: string[][] = [];
  const offQuiet = onPulled((r) => quiet.push(r.pulled));
  advanceClock(31_000);
  fakeDocument.dispatch("visibilitychange");
  await settle();
  offQuiet();
  check("jsonb: a re-sync with nothing changed pulls NOTHING (key order is not a change)", quiet.length === 0, json(quiet));
  check("jsonb: …and takes no backup, so real backups are never pushed out", storage.loadBackups().length === backupsBefore);

  // ---- an edit is mirrored; an unchanged re-save is not ----
  storage.savePlan(week("ANA-EDIT"));
  check("mirror: an edit is queued", accountStatus().state === "pending");
  await leaveAndReturn();
  check("mirror: leaving the tab sends the edit", summary(sb.table("uid-ana").get("plan")?.value) === "week ANA-EDIT");
  const writesBefore = sb.writes;
  storage.savePlan(JSON.parse(JSON.stringify(week("ANA-EDIT"))));
  await leaveAndReturn();
  check("mirror: re-saving the same week sends nothing", sb.writes === writesBefore);

  // ---- another device changed the account; coming back to this tab picks it up ----
  const pulledReports: string[][] = [];
  const offPulled = onPulled((r) => pulledReports.push(r.pulled));
  sb.table("uid-ana").set("saved", { value: ["Shakshuka"], updated_at: new Date(Date.now() + 5_000).toISOString() });
  advanceClock(31_000);
  fakeDocument.dispatch("visibilitychange");
  await settle();
  check("focus: returning to the tab after a while pulls another device's change", json(storage.loadSaved()) === json(["Shakshuka"]));
  check("focus: …and tells listeners, so mounted screens re-read", pulledReports.some((p) => p.includes("saved")));
  offPulled();

  // ---- a stale local edit loses to a newer one on the account, and is kept as a copy ----
  sb.table("uid-ana").set("plan", { value: week("PHONE-NEWER"), updated_at: new Date(Date.now() + 60_000).toISOString() });
  storage.savePlan(week("LAPTOP-STALE")); // written "now", older than the phone's
  await leaveAndReturn();
  await settle();
  check("stale write: the account keeps the newer week (the server refused the older write)",
    summary(sb.table("uid-ana").get("plan")?.value) === "week PHONE-NEWER");
  check("stale write: this device then pulls the newer week…", storage.loadPlan()?.weekSummary === "week PHONE-NEWER");
  check("stale write: …and keeps its own edit as a copy, because the account never saw it",
    storage.loadBackups().some((b) => summary(b.data.plan) === "week LAPTOP-STALE"));

  // ---- another tab signs in as someone else: this tab must stop, and must not write into their account ----
  const bobSession = sb.sessionFor("bob@example.com");
  storage.saveSessionRaw({
    accessToken: bobSession.access_token, refreshToken: bobSession.refresh_token, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    userId: "uid-bob", email: "bob@example.com",
  });
  const reloadsBefore = reloads;
  fakeWindow.dispatch("storage", { key: "nutriflow.session" });
  check("other tab: a different account signing in elsewhere stops this tab's sync and reloads it",
    reloads === reloadsBefore + 1 && accountStatus().state === "signed-out" && (accountStatus().message ?? "").includes("another tab"));
  storage.toggleSaved("Ana's tab edit");
  await leaveAndReturn();
  check("other tab: …so this tab's later edits never reach the other account", sb.table("uid-bob").size === 0);
  storage.saveSessionRaw(null);
  await signOut();

  // ---- the session pin: another tab's sign-in whose storage event never arrived ----
  const zedRoom = new MemoryStorage();
  fakeWindow.localStorage = zedRoom;
  await signIn("yan@example.com");
  await startSync();
  const zed = sb.sessionFor("zed@example.com");
  storage.saveSessionRaw({
    accessToken: zed.access_token, refreshToken: zed.refresh_token, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    userId: "uid-zed", email: "zed@example.com",
  }); // no "storage" event: this tab never hears about it
  storage.toggleSaved("yan's edit");
  await leaveAndReturn();
  check("session pin: a sync started for one account never pushes into another's, even with the tab event missed",
    sb.table("uid-zed").size === 0, [...sb.table("uid-zed").keys()].join());
  check("session pin: …and it stops, saying why", accountStatus().state === "signed-out" && (accountStatus().message ?? "").includes("another tab"));
  storage.saveSessionRaw(null);
  await signOut();
  fakeWindow.localStorage = laptop;

  // ---- destructive actions are pinned too (review 2: a tab that missed another tab's sign-in deleted
  //      THAT account, while telling this one its account was gone) ----
  const pinRoom = new MemoryStorage();
  fakeWindow.localStorage = pinRoom;
  await signIn("una@example.com");
  await startSync();
  const vic = sb.sessionFor("vic@example.com");
  sb.table("uid-vic").set("plan", { value: week("VIC"), updated_at: new Date().toISOString() });
  storage.saveSessionRaw({
    accessToken: vic.access_token, refreshToken: vic.refresh_token, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    userId: "uid-vic", email: "vic@example.com",
  }); // no "storage" event: this tab never hears about it
  let deleteRefused = "";
  try { await deleteAccount(); } catch (e) { deleteRefused = (e as Error).message; }
  check("pinned delete: 'Delete my account' in a tab showing Una never deletes the account another tab signed in",
    sb.users.has("uid-vic") && sb.table("uid-vic").has("plan") && deleteRefused.includes("another tab"),
    json({ vicExists: sb.users.has("uid-vic"), deleteRefused }));
  check("pinned delete: …and Una's account is untouched too", sb.users.has("uid-una"));
  const logoutsBefore = sb.logouts;
  await signOut();
  check("pinned sign-out: signing out in that tab leaves the other account's sign-in alone",
    currentSession()?.userId === "uid-vic" && sb.logouts === logoutsBefore,
    json({ session: currentSession()?.userId ?? null, logouts: sb.logouts - logoutsBefore }));
  let forgetRefused = "";
  try { await forgetThisBrowser(); } catch (e) { forgetRefused = (e as Error).message; }
  check("pinned forget: 'Delete everything in this browser' refuses while the browser holds an account this tab isn't showing",
    forgetRefused.includes("another tab") && currentSession()?.userId === "uid-vic",
    json({ forgetRefused, session: currentSession()?.userId ?? null }));
  storage.saveSessionRaw(null);
  fakeWindow.localStorage = laptop;

  // ---- sign out keeps the device's data ----
  memory.clear();
  fakeWindow.localStorage = laptop;
  await signIn("ana@example.com");
  await startSync();
  const anasRefresh = currentSession()!.refreshToken;
  await signOut();
  check("sign-out: the session is gone", currentSession() === null && accountStatus().state === "signed-out");
  check("sign-out: the device KEEPS its week (the account is a mirror)", storage.loadPlan() !== null);
  check("sign-out: no listeners are left behind", fakeDocument.count("visibilitychange") === 0 && fakeWindow.count("online") === 0);
  // Not "/logout was called": that the session is really over. GoTrue refuses its refresh token from
  // then on (the fake now ends the session as GoTrue does; it used to count the calls and nothing more).
  const renewAfter = await sb.fetch("https://fake.supabase.co/auth/v1/token?grant_type=refresh_token", {
    method: "POST", headers: { apikey: "ANON" }, body: JSON.stringify({ refresh_token: anasRefresh }),
  });
  check("sign-out: the server ended this browser's session (its refresh token no longer works)",
    renewAfter.status === 400, `renewal answered ${renewAfter.status}`);

  // ---- Bob signs in on the SAME browser: Ana's data must not go into Bob's account ----
  const anaPlan = storage.loadPlan()?.weekSummary;
  await signIn("bob@example.com");
  await startSync();
  check("account switch: NOTHING of Ana's is pushed into Bob's account", sb.table("uid-bob").size === 0, [...sb.table("uid-bob").keys()].join());
  check("account switch: the browser no longer shows Ana's week to Bob", storage.loadPlan() === null && storage.loadProfile() === null);
  const set = storage.loadBackups()[0];
  check("account switch: Ana's data is set aside as a copy, not lost",
    set?.reason.includes("different account") && summary(set.data.plan) === anaPlan);
  check("account switch: Ana's account is untouched", summary(sb.table("uid-ana").get("plan")?.value) === "week PHONE-NEWER");
  check("account switch: the status says what happened", (accountStatus().message ?? "").includes("different account"));
  check("account switch: the browser now belongs to Bob", storage.loadSyncOwner() === "uid-bob");

  // ---- a store the server refuses is 'error' and named; the rest still lands ----
  sb.refuseKey = "imports";
  storage.rememberImport({ name: "Odd caption", sourceUrl: "https://example.com/r", servings: 1, ingredients: [], steps: [] } as never);
  storage.savePlan(week("BOB-1"));
  await leaveAndReturn();
  check("refused store: the rest of the batch still lands", summary(sb.table("uid-bob").get("plan")?.value) === "week BOB-1");
  check("refused store: status 'error' naming it, not 'offline'",
    accountStatus().state === "error" && (accountStatus().message ?? "").includes("imported recipes"), json(accountStatus()));
  sb.refuseKey = null;

  // ---- offline, then back ----
  sb.down = true;
  storage.savePlan(week("BOB-2"));
  await leaveAndReturn();
  check("unreachable: status 'offline', and the edit is kept", accountStatus().state === "offline" && storage.loadPlan()?.weekSummary === "week BOB-2");
  sb.down = false;
  fakeWindow.dispatch("online");
  await settle();
  await settle();
  check("back online: the queued edit goes out", summary(sb.table("uid-bob").get("plan")?.value) === "week BOB-2");

  // ---- "Put it back" while signed in must not delete anything from the account ----
  storage.takeBackup("a copy holding only the week");
  const onlyPlan = storage.loadBackups()[0];
  onlyPlan.data = { plan: week("BOB-COPY") };
  fakeWindow.localStorage.setItem("nutriflow.backup", JSON.stringify([onlyPlan]));
  storage.restoreBackup(onlyPlan.id);
  await leaveAndReturn();
  const bobRows = sb.table("uid-bob");
  check("restore: puts the copy's week into the account", summary(bobRows.get("plan")?.value) === "week BOB-COPY",
    json({ server: summary(bobRows.get("plan")?.value), serverAt: bobRows.get("plan")?.updated_at, local: storage.loadPlan()?.weekSummary,
      localAt: storage.loadStoreMeta().plan, status: accountStatus() }));
  check("restore: NOTHING in the account is nulled (review: 'Put it back' deleted every store everywhere)",
    [...bobRows.values()].every((r) => r.value !== null), json([...bobRows.entries()].map(([k, r]) => `${k}:${r.value === null ? "NULL" : "ok"}`)));

  // ---- delete the account ----
  await deleteAccount();
  check("delete account: the account and its rows are gone on the server", !sb.users.has("uid-bob") && !sb.rows.has("uid-bob"));
  check("delete account: signed out, and the browser keeps its copy", currentSession() === null && storage.loadPlan()?.weekSummary === "week BOB-COPY",
    json({ session: currentSession()?.userId ?? null, local: storage.loadPlan()?.weekSummary }));
  check("delete account: the browser's data STAYS marked as the deleted account's (review 2: clearing that let the next sign-in upload it)",
    storage.loadSyncOwner() === "uid-bob", json(storage.loadSyncOwner()));
  await signIn("dee@example.com");
  await startSync();
  check("delete account: the next person to sign in here does NOT get the deleted account's data uploaded into theirs",
    summary(sb.table("uid-dee").get("plan")?.value) !== "week BOB-COPY", summary(sb.table("uid-dee").get("plan")?.value));
  check("delete account: …it is set aside here as a copy instead", storage.loadBackups().some((b) => summary(b.data.plan) === "week BOB-COPY"));
  await signOut();

  // ---- the account is deleted on ANOTHER device (review 2, platform-4) ----
  // PostgREST keeps honouring this device's token until it expires (a JWT is stateless), so its next
  // pull reads an empty account and its push breaks the foreign key to auth.users (23503, sent as 409).
  // That read as an ordinary refusal: "couldn't store your week… everything else is synced" for up to
  // an hour, then "your sign-in expired". Neither says what happened.
  const deleteFromPhone = async (email: string) => {
    const phone = sb.sessionFor(email); // the same account, signed in on a phone, which deletes it
    await sb.fetch("https://fake.supabase.co/rest/v1/rpc/delete_my_account", {
      method: "POST", headers: { apikey: "ANON", Authorization: `Bearer ${phone.access_token}` },
    });
  };
  fakeWindow.localStorage = new MemoryStorage();
  storage.savePlan(week("ELLA"));
  await signIn("ella@example.com");
  await startSync();
  await deleteFromPhone("ella@example.com");
  storage.savePlan(week("ELLA-AFTER")); // an edit here once the account is gone: the live mirror sends it
  await leaveAndReturn();
  check("deleted elsewhere: the live mirror's next push stops sync and says the account was deleted",
    accountStatus().state === "signed-out" && (accountStatus().message ?? "").includes("was deleted"), json(accountStatus()));
  check("deleted elsewhere: …the sign-in is forgotten, the week stays here, still marked as that account's",
    currentSession() === null && summary(storage.loadPlan()) === "week ELLA-AFTER" && storage.loadSyncOwner() === "uid-ella",
    json({ session: currentSession()?.userId ?? null, plan: summary(storage.loadPlan()), owner: storage.loadSyncOwner() }));

  // The same through a FULL sync: a page opened after the deletion, with the token still good.
  fakeWindow.localStorage = new MemoryStorage();
  storage.savePlan(week("FINN"));
  await signIn("finn@example.com");
  await deleteFromPhone("finn@example.com");
  await startSync(); // the account reads empty, and the push of this device's week is refused
  check("deleted elsewhere: a full sync says so too, rather than 'couldn't store' or 'expired'",
    accountStatus().state === "signed-out" && (accountStatus().message ?? "").includes("was deleted") && currentSession() === null,
    json(accountStatus()));
  await signIn("finn@example.com"); // the same person signs up again: a NEW account (GoTrue's new id)
  await startSync();
  check("deleted elsewhere: signing up again gets a new account, with the old data set aside rather than uploaded",
    !sb.table(currentSession()!.userId).has("plan") && storage.loadBackups().some((b) => summary(b.data.plan) === "week FINN"),
    json({ id: currentSession()?.userId, plan: summary(sb.table(currentSession()!.userId).get("plan")?.value), copies: storage.loadBackups().length }));
  await signOut();

  // ---- a first sync that FAILS: nothing is sent until a full sync succeeds, then it is retried ----
  const desk = new MemoryStorage();
  fakeWindow.localStorage = desk;
  sb.table("uid-carol").set("saved", { value: ["Dal"], updated_at: new Date(Date.now() - 60_000).toISOString() });
  await signIn("carol@example.com");
  sb.failPulls = 1; // the first sync's pull fails; pushes would still get through
  await startSync();
  check("failed first sync: status 'offline'", accountStatus().state === "offline");
  storage.toggleSaved("Shakshuka");
  await leaveAndReturn();
  check("failed first sync: an edit made before the device ever pulled is NOT pushed on its own (review: it overwrote 'Dal')",
    json(sb.table("uid-carol").get("saved")?.value) === json(["Dal"]), json(sb.table("uid-carol").get("saved")?.value));
  await startSync(); // joining a sync that never succeeded retries it
  await settle();
  check("failed first sync: the next startSync retries it and the edit goes up properly",
    json(sb.table("uid-carol").get("saved")?.value) === json(["Shakshuka"]) && accountStatus().state !== "offline");
  check("failed first sync: …and the account's earlier list is kept as a copy here, not lost",
    storage.loadBackups().some((b) => json(b.data.saved) === json(["Dal"])),
    json(storage.loadBackups().map((b) => ({ reason: b.reason, saved: b.data.saved }))));

  // ---- signing out while offline says the last edits didn't make it ----
  sb.down = true;
  storage.toggleSaved("Dal");
  await signOut();
  check("sign-out offline: says the latest changes hadn't reached the account, and that they're kept",
    (accountStatus().message ?? "").includes("hadn't reached") && json(storage.loadSaved()).includes("Dal"));
  sb.down = false;

  // ---- a FAILED first sync must still mark the browser's data as this account's (review 2, found
  //      twice: the owner was recorded only after a SUCCESSFUL first sync, so a person's unsynced data,
  //      left in a shared browser, went up into the NEXT person's account — health notes included) ----
  const sharedPc = new MemoryStorage();
  fakeWindow.localStorage = sharedPc;
  const hourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
  sb.table("uid-ben").set("plan", { value: week("BEN-OWN"), updated_at: hourAgoIso });
  sb.table("uid-ben").set("profile", { value: { ...PROFILE, name: "Ben" }, updated_at: hourAgoIso });
  await signIn("ivy@example.com");
  sb.failPulls = 1;
  await startSync();
  storage.saveProfile({ ...PROFILE, name: "Ivy", allergies: "peanuts" });
  storage.savePlan(week("IVY"));
  await signOut();
  await signIn("ben@example.com");
  await startSync();
  await settle();
  const benProfile = sb.table("uid-ben").get("profile")?.value as UserProfile | undefined;
  check("owner: after a FAILED first sync, the next person's sign-in does not upload the previous person's data",
    summary(sb.table("uid-ben").get("plan")?.value) === "week BEN-OWN" && benProfile?.name === "Ben",
    json({ plan: summary(sb.table("uid-ben").get("plan")?.value), profile: benProfile?.name }));
  check("owner: …the previous person's data is set aside here as a copy, not lost",
    storage.loadBackups().some((b) => summary(b.data.plan) === "week IVY"));
  check("owner: …and the next person sees their own week", storage.loadPlan()?.weekSummary === "week BEN-OWN");
  await signOut();

  // ---- forget this browser DURING a slow pull: the pull must not refill the cleared browser ----
  const kiosk = new MemoryStorage();
  fakeWindow.localStorage = kiosk;
  await signIn("carol@example.com");
  sb.pullDelayMs = 60;
  const inFlight = startSync();
  await new Promise((r) => setTimeout(r, 10)); // the pull is now on its way
  await forgetThisBrowser();
  await inFlight;
  await new Promise((r) => setTimeout(r, 80));
  sb.pullDelayMs = 0;
  check("forget mid-pull: a pull landing after 'delete everything' does NOT refill the browser (review)",
    storage.loadSaved().length === 0 && kiosk.keys().filter((k) => !k.startsWith("nutriflow.pkce") && k !== "nutriflow.epoch").length === 0, kiosk.keys().join());
  fakeWindow.localStorage = desk;

  // ---- forget this browser: stop syncing first, end the sign-in, clear ----
  await signIn("carol@example.com");
  await startSync();
  const carolRows = sb.table("uid-carol").size;
  await forgetThisBrowser();
  check("forget: the browser is emptied and signed out (only the new data generation remains)",
    currentSession() === null && storage.loadSaved().length === 0 && desk.keys().every((k) => k === "nutriflow.epoch"), desk.keys().join());
  check("forget: the account is untouched", sb.table("uid-carol").size === carolRows);
  storage.toggleSaved("after-forget");
  await leaveAndReturn();
  check("forget: nothing is synced afterwards (the sync really stopped)", !json(sb.table("uid-carol").get("saved")?.value).includes("after-forget"));

  // ---- an expired sign-in stops syncing cleanly and keeps the data ----
  const study = new MemoryStorage();
  fakeWindow.localStorage = study;
  sb.nextExpiresIn = -10; // the session the link produces is already expired: the next call must refresh
  await signIn("dan@example.com");
  sb.refuseRefresh = true;
  storage.savePlan(week("DAN"));
  await startSync();
  check("expired sign-in: status 'signed-out' with a sentence saying why", accountStatus().state === "signed-out" && (accountStatus().message ?? "").includes("expired"));
  check("expired sign-in: the session is dropped, the week is kept", currentSession() === null && storage.loadPlan()?.weekSummary === "week DAN");
  sb.refuseRefresh = false;

  // ---- a store too big for the account stays local and says so; the rest syncs ----
  const phone = new MemoryStorage();
  fakeWindow.localStorage = phone;
  await signIn("eve@example.com");
  storage.savePlan(week("EVE"));
  storage.saveChat([{ role: "user", text: "y".repeat(MAX_STORE_BYTES + 1) }]);
  await startSync();
  check("too large: the rest of the data syncs", summary(sb.table("uid-eve").get("plan")?.value) === "week EVE");
  check("too large: the oversized store stays local and the status names it",
    !sb.table("uid-eve").has("chat") && accountStatus().state === "error" && (accountStatus().message ?? "").includes("chat history"));
  await signOut();

  // ---- a malformed row in the account is not written here ----
  const tablet = new MemoryStorage();
  fakeWindow.localStorage = tablet;
  storage.saveProfile(PROFILE);
  await signIn("fay@example.com");
  sb.table("uid-fay").set("profile", { value: { targetCalories: "lots" }, updated_at: new Date(Date.now() + 60_000).toISOString() });
  await startSync();
  check("invalid row: an unreadable profile from the account is NOT written over this device's",
    storage.loadProfile()?.targetCalories === 2000 && (accountStatus().message ?? "").includes("couldn't be read"));
  await signOut();

  // ---- review 2, batch 3: sign-in and tokens, as the real GoTrue and PostgREST behave ----
  // A token the server refuses is renewed and the request retried: the person stays signed in. (Every
  // 401 used to sign people out, with a refresh token that was still good.)
  fakeWindow.localStorage = new MemoryStorage();
  await signIn("kai@example.com");
  await startSync();
  sb.revokeAccess();
  storage.savePlan(week("KAI-AFTER-401"));
  await leaveAndReturn();
  check("401: a refused access token is renewed, and the edit still reaches the account",
    summary(sb.table("uid-kai").get("plan")?.value) === "week KAI-AFTER-401", summary(sb.table("uid-kai").get("plan")?.value));
  check("401: …and the person stays signed in", currentSession()?.userId === "uid-kai" && accountStatus().state !== "signed-out",
    json(accountStatus()));
  await signOut();

  // A transient failure of the code exchange: the code and verifier are kept, and "Try again" finishes.
  fakeWindow.localStorage = new MemoryStorage();
  await sendSignInLink("lee@example.com");
  fakeWindow.location.search = `?code=${sb.lastCode.get("lee@example.com")}`;
  sb.failExchange = 1;
  let transient = "";
  try { await completeSignInFromUrl(); } catch (e) { transient = (e as Error).message; }
  check("sign-in: a transient failure says so and offers to try again (opening the used link again could not work)",
    transient.length > 0 && !transient.toLowerCase().includes("link again") && canRetrySignIn(), json({ transient, canRetry: canRetrySignIn() }));
  const retried = await mayThrow(retrySignIn());
  check("sign-in: …and 'Try again' finishes it with the kept code", retried?.userId === "uid-lee" && currentSession()?.userId === "uid-lee");
  check("sign-in: …after which nothing is left to retry, and the verifier is gone", !canRetrySignIn() && storage.loadPendingSignIn() === null);
  await signOut();

  // A first link opened more than five minutes after it was asked for.
  fakeWindow.localStorage = new MemoryStorage();
  sb.codeTtlMs = 300_000;
  await sendSignInLink("mo@example.com");
  advanceClock(6 * 60_000);
  fakeWindow.location.search = `?code=${sb.lastCode.get("mo@example.com")}`;
  let late = "";
  try { await completeSignInFromUrl(); } catch (e) { late = (e as Error).message; }
  check("sign-in: a first link opened after its five minutes says to ask for a new one, and offers no retry",
    late.includes("five minutes") && !canRetrySignIn(), late);
  sb.codeTtlMs = Infinity;

  // Asking again for the same address keeps the first link working (review 2: the second request
  // replaced the verifier, so the valid first link failed as "opened in a different browser").
  fakeWindow.localStorage = new MemoryStorage();
  await sendSignInLink("nia@example.com");
  const firstCode = sb.lastCode.get("nia@example.com");
  await sendSignInLink("nia@example.com");
  fakeWindow.location.search = `?code=${firstCode}`;
  const viaFirst = await mayThrow(completeSignInFromUrl());
  check("sign-in: after asking twice, the FIRST link still signs in", viaFirst?.userId === "uid-nia");
  await signOut();
  check("sign-in: …and signing out straight after works (the tab shows the account it just signed in to)",
    currentSession() === null, json({ session: currentSession()?.userId ?? null, status: accountStatus() }));

  // A mistyped address never touches the pending sign-in.
  fakeWindow.localStorage = new MemoryStorage();
  await sendSignInLink("oz@example.com");
  let typo = "";
  try { await sendSignInLink("oz@example"); } catch (e) { typo = (e as Error).message; }
  fakeWindow.location.search = `?code=${sb.lastCode.get("oz@example.com")}`;
  const afterTypo = await mayThrow(completeSignInFromUrl());
  check("sign-in: a mistyped address is refused before anything is stored, and the real link still works",
    typo.includes("email address") && afterTypo?.userId === "uid-oz", json({ typo, user: afterTypo?.userId ?? null }));
  await signOut();

  // A new request made while an earlier link's exchange is in flight keeps ITS verifier.
  fakeWindow.localStorage = new MemoryStorage();
  await sendSignInLink("pia@example.com");
  fakeWindow.location.search = `?code=${sb.lastCode.get("pia@example.com")}`;
  sb.exchangeDelayMs = 60;
  const piaSigningIn = completeSignInFromUrl();
  await sendSignInLink("quin@example.com");
  await mayThrow(piaSigningIn);
  sb.exchangeDelayMs = 0;
  await signOut();
  fakeWindow.location.search = `?code=${sb.lastCode.get("quin@example.com")}`;
  const quin = await mayThrow(completeSignInFromUrl());
  check("sign-in: a link asked for while another sign-in was finishing still works (its verifier was kept)",
    quin?.userId === "uid-quin");
  await signOut();

  // ---- review 2, batch 4 ----
  // A token renewal answered after "Delete everything in this browser" must not bring the session back
  // (found by two lenses; the same race was filed against Supabase's own Swift SDK).
  fakeWindow.localStorage = new MemoryStorage();
  sb.nextExpiresIn = 30; // the session the link gives has under a minute left: the next request renews it
  await signIn("rex@example.com");
  sb.refreshAnswerDelayMs = 120; // GoTrue renews at once; its answer is slow to arrive
  const rexSyncing = startSync();
  await settle();
  await forgetThisBrowser();
  await mayThrow(rexSyncing);
  await new Promise((r) => setTimeout(r, 160));
  check("renewal race: an answer arriving after 'Delete everything' does not bring the session back",
    currentSession() === null && fakeWindow.localStorage.getItem("nutriflow.session") === null,
    json({ session: currentSession()?.userId ?? null }));

  // A full sync's push the account skipped is followed by a second pull at once (review 2: the follow-up
  // was queued so that it only joined the finishing sync, and never ran).
  fakeWindow.localStorage = new MemoryStorage();
  await signIn("sky@example.com");
  await startSync();
  sb.table("uid-sky").set("saved", { value: ["OLD"], updated_at: new Date(Date.now() - 3_600_000).toISOString() });
  storage.writeStore("saved", ["MINE"], { at: Date.now(), silent: true }); // newer here, and not queued to send
  sb.afterPull = () => sb.table("uid-sky").set("saved", { value: ["OTHER"], updated_at: new Date(Date.now() + 60_000).toISOString() });
  fakeWindow.dispatch("online"); // a full sync: it plans to push MINE, and the push is skipped
  await settle();
  await settle();
  await settle();
  check("skipped push: the follow-up pull runs at once and brings the other device's newer write down",
    json(storage.loadSaved()) === json(["OTHER"]), json(storage.loadSaved()));
  check("skipped push: …and this device's edit is kept as a copy", storage.loadBackups().some((b) => json(b.data.saved) === json(["MINE"])));
  await signOut();

  // An edit's push answered after "Delete everything": no bookkeeping comes back into the emptied browser.
  const cleared = new MemoryStorage();
  fakeWindow.localStorage = cleared;
  await signIn("tia@example.com");
  await startSync();
  sb.pushDelayMs = 80;
  storage.toggleSaved("Shakshuka");
  fakeDocument.visibilityState = "hidden";
  fakeDocument.dispatch("visibilitychange"); // the push goes out, and is slow
  await new Promise((r) => setTimeout(r, 10));
  await forgetThisBrowser();
  await new Promise((r) => setTimeout(r, 140));
  fakeDocument.visibilityState = "visible";
  sb.pushDelayMs = 0;
  check("late answers: a push answered after 'Delete everything' writes nothing into the emptied browser, and the tab stays signed out",
    cleared.keys().every((k) => k === "nutriflow.epoch") && accountStatus().state === "signed-out",
    json({ keys: cleared.keys(), status: accountStatus().state }));

  // A full sync's push answered after "Delete everything": the same, through the sync itself.
  const cleared2 = new MemoryStorage();
  fakeWindow.localStorage = cleared2;
  await signIn("uma@example.com");
  await startSync();
  storage.writeStore("saved", ["Dal"], { at: Date.now(), silent: true }); // only a full sync will send it
  sb.pushDelayMs = 80;
  fakeWindow.dispatch("online");
  await new Promise((r) => setTimeout(r, 20)); // the full sync has pulled, and its push is in flight
  await forgetThisBrowser();
  await new Promise((r) => setTimeout(r, 140));
  sb.pushDelayMs = 0;
  check("late answers: a full sync's push answered after 'Delete everything' writes nothing into the emptied browser",
    cleared2.keys().every((k) => k === "nutriflow.epoch"), json(cleared2.keys()));

  // A re-sync queued behind a push in flight, in a tab then signed out: it must not run and claim
  // "Syncing…" for an account the tab no longer shows (review 2). Signing out HERE waits for the push
  // before it stops anything, so the re-sync starts while the tab is still current, and the sign-out's
  // own sentence comes last either way: the stop that does not wait is the next check.
  fakeWindow.localStorage = new MemoryStorage();
  await signIn("vi@example.com");
  await startSync();
  sb.pushDelayMs = 80;
  storage.toggleSaved("Tofu");
  fakeDocument.visibilityState = "hidden";
  fakeDocument.dispatch("visibilitychange"); // the push is in flight
  fakeDocument.visibilityState = "visible";
  fakeWindow.dispatch("online"); // a re-sync waits behind it
  await new Promise((r) => setTimeout(r, 10));
  await signOut();
  await new Promise((r) => setTimeout(r, 140));
  sb.pushDelayMs = 0;
  check("stopped tab: a re-sync that was waiting does not run afterwards and show 'Syncing…'",
    accountStatus().state === "signed-out", json(accountStatus()));

  // The same, stopped at once: another tab signs out while the push is in flight (as "Delete
  // everything" and a switch also do). The re-sync waiting behind the push then started in a tab that
  // had stopped, and said "Syncing…" for an account it no longer showed.
  fakeWindow.localStorage = new MemoryStorage();
  await signIn("wyn@example.com");
  await startSync();
  sb.pushDelayMs = 80;
  storage.toggleSaved("Tempeh");
  fakeDocument.visibilityState = "hidden";
  fakeDocument.dispatch("visibilitychange"); // the push is in flight
  fakeDocument.visibilityState = "visible";
  fakeWindow.dispatch("online"); // a re-sync waits behind it
  await new Promise((r) => setTimeout(r, 10));
  storage.saveSessionRaw(null);
  fakeWindow.dispatch("storage", { key: "nutriflow.session" }); // another tab signed out: this one stops now
  await new Promise((r) => setTimeout(r, 140));
  sb.pushDelayMs = 0;
  check("stopped tab: a re-sync waiting when another tab signed out does not start afterwards and show 'Syncing…'",
    accountStatus().state === "signed-out" && (accountStatus().message ?? "").includes("another tab"), json(accountStatus()));

  // ui-tests-5, ported from the reviewer's scenarios: guards no test could see.
  // Switching into an account that already HAS data keeps that account's data.
  fakeWindow.localStorage = new MemoryStorage();
  const bosHour = new Date(Date.now() - 3_600_000).toISOString();
  sb.table("uid-bo").set("profile", { value: { ...PROFILE, name: "Bo" }, updated_at: bosHour });
  sb.table("uid-bo").set("plan", { value: week("BO"), updated_at: bosHour });
  storage.saveProfile({ ...PROFILE, name: "Al" });
  storage.savePlan(week("AL"));
  await signIn("al@example.com");
  await startSync();
  await signOut();
  await signIn("bo@example.com");
  await startSync();
  await settle();
  const boProfile = sb.table("uid-bo").get("profile")?.value as UserProfile | undefined;
  check("switch: an account that already has data keeps it (the reset also forgets the previous account's write times)",
    boProfile?.name === "Bo" && summary(sb.table("uid-bo").get("plan")?.value) === "week BO",
    json({ profile: boProfile?.name ?? null, plan: summary(sb.table("uid-bo").get("plan")?.value) ?? null }));
  await signOut();

  // With no room for a safety copy, a switch empties nothing.
  const tight = new MemoryStorage();
  fakeWindow.localStorage = tight;
  storage.saveProfile(PROFILE);
  storage.savePlan(week("CY-ONLY-COPY"));
  await signIn("cy@example.com");
  await startSync();
  await signOut();
  tight.quota = tight.keys().reduce((n, k) => n + k.length + (tight.getItem(k) ?? "").length, 0) + 1500;
  await signIn("dy@example.com");
  await startSync();
  await settle();
  check("switch: with no room for a safety copy, nothing is emptied",
    summary(storage.loadPlan()) === "week CY-ONLY-COPY" || storage.loadBackups().some((b) => summary(b.data.plan) === "week CY-ONLY-COPY"),
    json({ plan: summary(storage.loadPlan()) ?? null, copies: storage.loadBackups().length, status: accountStatus() }));
  tight.quota = Infinity;
  await signOut();

  // After a token renewal the next requests still work: the ROTATED refresh token is the one kept.
  fakeWindow.localStorage = new MemoryStorage();
  storage.saveProfile(PROFILE);
  sb.nextExpiresIn = 30;
  await signIn("cal@example.com");
  await startSync();
  storage.savePlan(week("CAL"));
  await leaveAndReturn();
  check("token rotation: after a renewal, later requests still work (the rotated refresh token is the one kept)",
    accountStatus().state !== "signed-out" && summary(sb.table("uid-cal").get("plan")?.value) === "week CAL", json(accountStatus()));
  await signOut();

  // "Your sign-in expired…" survives the account page opening and calling startSync again.
  fakeWindow.localStorage = new MemoryStorage();
  sb.nextExpiresIn = -10;
  await signIn("eda@example.com");
  sb.refresh.clear(); // the renewal is refused: the sign-in is over
  await startSync();
  const why = accountStatus().message ?? "";
  await startSync();
  check("signed out: the reason survives the account page's own startSync", why.includes("expired") && (accountStatus().message ?? "") === why,
    json({ before: why.slice(0, 40), after: accountStatus() }));

  // ---- savedStore: the seam Explore saves through (review 2: no test ever imported it) ----
  // Both add and remove go through a TOGGLE, so each must check the list first: adding a recipe that is
  // already saved would un-save it, and removing one that isn't would save it.
  fakeWindow.localStorage = new MemoryStorage();
  await localSavedStore.add("Dal");
  await localSavedStore.add("Dal");
  check("savedStore: saving a recipe that is already saved keeps it saved",
    json(await localSavedStore.list()) === json(["Dal"]), json(await localSavedStore.list()));
  await localSavedStore.remove("Tofu");
  check("savedStore: removing a recipe that isn't saved changes nothing",
    json(await localSavedStore.list()) === json(["Dal"]), json(await localSavedStore.list()));
  await localSavedStore.remove("Dal");
  check("savedStore: …and removing one that is saved removes it", (await localSavedStore.list()).length === 0);
  fakeWindow.localStorage.setItem("nutriflow.saved", JSON.stringify(["Dal", 7, null, { x: 1 }, "Tofu"]));
  check("savedStore: anything but a name in storage is not shown as a saved recipe",
    json(await localSavedStore.list()) === json(["Dal", "Tofu"]), json(await localSavedStore.list()));
  check("savedStore: says 'local' when nobody is signed in", savedStore().kind === "local");
  await signIn("sol@example.com");
  check("savedStore: says 'account' when signed in, so Explore can say where saves go", savedStore().kind === "account");
  await signOut();

  // ---- a SECOND device pulls the account down, and listeners hear it ----
  const second = new MemoryStorage();
  fakeWindow.localStorage = second;
  const heard: string[][] = [];
  const off2 = onPulled((r) => heard.push(r.pulled));
  await signIn("ana@example.com");
  await startSync();
  off2();
  check("second device: Ana's week arrives on a fresh browser",
    storage.loadPlan()?.weekSummary === "week PHONE-NEWER" && storage.loadSaved().includes("Shakshuka"),
    json({ plan: storage.loadPlan()?.weekSummary, saved: storage.loadSaved() }));
  check("second device: onPulled listeners are told what came down", heard.length === 1 && heard[0].includes("plan"));
  await signOut();

  // ---- clocks: devices whose clocks are wrong (lesson 57; each reproduced before the fix) ----
  const HOUR = 3_600_000;

  // The write paths themselves: each stamps past a value that came from a clock running ahead.
  fakeWindow.localStorage = new MemoryStorage();
  const ahead = Date.now() + 10 * HOUR;
  storage.writeStore("plan", week("FROM-A-FAST-CLOCK"), { at: ahead, silent: true });
  storage.savePlan(week("EDITED-HERE"));
  check("clocks: a local edit is stamped later than the copy it replaces, even one from a clock running ahead",
    storage.loadStoreMeta().plan === ahead + 1, json(storage.loadStoreMeta()));
  storage.writeStore("imports", [{ name: "Fast", sourceUrl: "https://example.com/fast", servings: 1, ingredients: [], steps: [], importedAt: ahead }], { at: ahead, silent: true });
  const imported = storage.rememberImport({ name: "Now", sourceUrl: "https://example.com/now", servings: 1, ingredients: [], steps: [] } as never);
  check("clocks: a recipe imported now is stamped later than every import this device has seen",
    (imported[0] as { importedAt?: number }).importedAt === ahead + 1, json(imported.map((x) => (x as { importedAt?: number }).importedAt)));
  storage.takeBackup("before a test restore");
  storage.writeStore("plan", week("PULLED-FROM-A-FAST-CLOCK"), { at: ahead + 50, silent: true });
  storage.restoreBackup();
  check("clocks: \"Put it back\" is stamped later than the copy it replaces (else the next sync pulls that copy back over it)",
    storage.loadPlan()?.weekSummary === "week EDITED-HERE" && storage.loadStoreMeta().plan === ahead + 51, json(storage.loadStoreMeta()));

  // A phone whose clock runs 2 h slow (a dual boot does this), used AFTER it synced. Its edit was
  // stamped older than the week it had just pulled, and the next sync pulled that week back over it,
  // with no backup: the edit also looked older than the last agreement.
  fakeWindow.localStorage = new MemoryStorage();
  await signIn("gus@example.com");
  await startSync();
  storage.savePlan(week("GUS-LAPTOP"));
  await leaveAndReturn();
  await signOut();
  fakeWindow.localStorage = new MemoryStorage();
  skewClock(-2 * HOUR);
  await signIn("gus@example.com");
  await startSync();
  storage.savePlan(week("GUS-PHONE"));
  await leaveAndReturn();
  check("clocks: an edit on a phone whose clock runs 2 h slow reaches the account",
    summary(sb.table("uid-gus").get("plan")?.value) === "week GUS-PHONE", summary(sb.table("uid-gus").get("plan")?.value));
  fakeWindow.dispatch("online");
  await settle();
  await settle();
  check("clocks: …and survives the phone's next full sync, with nothing to back up (it was pulled back over, silently)",
    storage.loadPlan()?.weekSummary === "week GUS-PHONE" && storage.loadBackups().length === 0,
    json({ plan: storage.loadPlan()?.weekSummary, backups: storage.loadBackups().length }));
  await signOut();

  // A laptop whose clock runs a day FAST writes once, then a correct phone edits. The fast stamp
  // locked the store: every later edit was skipped by the server and reverted by the next sync.
  fakeWindow.localStorage = new MemoryStorage();
  skewClock(24 * HOUR);
  await signIn("hal@example.com");
  await startSync();
  storage.savePlan(week("HAL-FAST"));
  await leaveAndReturn();
  await signOut();
  fakeWindow.localStorage = new MemoryStorage();
  skewClock(0);
  await signIn("hal@example.com");
  await startSync();
  storage.savePlan(week("HAL-PHONE"));
  await leaveAndReturn();
  check("clocks: after a device a day fast wrote, a correct device's later edit still reaches the account",
    summary(sb.table("uid-hal").get("plan")?.value) === "week HAL-PHONE", summary(sb.table("uid-hal").get("plan")?.value));
  await signOut();

  Date.now = realNow;
  fakeWindow.localStorage = memory;
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
})();

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
