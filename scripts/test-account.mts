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
import { createHash } from "node:crypto";

// ---- a fake browser -------------------------------------------------------------------------------
// Nothing in storage.ts or client.ts touches `window` at import time, only when called, so installing
// these globals in the module body (which runs after hoisted imports) is early enough.
class MemoryStorage {
  private m = new Map<string, string>();
  /** Total characters allowed, like a browser's per-origin quota. Infinity unless a test sets it. */
  quota = Infinity;
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) {
    const next = String(v);
    const used = [...this.m.entries()].reduce((s, [key, val]) => s + (key === k ? 0 : key.length + val.length), 0);
    if (used + k.length + next.length > this.quota) throw new Error("QuotaExceededError");
    this.m.set(k, next);
  }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return [...this.m.keys()]; }
}
class Events {
  private l = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(t: string, f: (e: unknown) => void) { (this.l.get(t) ?? this.l.set(t, new Set()).get(t)!).add(f); }
  removeEventListener(t: string, f: (e: unknown) => void) { this.l.get(t)?.delete(f); }
  dispatch(t: string, e: unknown = {}) { for (const f of [...(this.l.get(t) ?? [])]) f(e); }
  count(t: string) { return this.l.get(t)?.size ?? 0; }
}
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
import { planSync, unionStore, canonical, type Side } from "@/lib/account/merge";
import {
  syncNow, createMirror, localSide, partitionBySize, pushOrIsolate, MAX_STORE_BYTES,
  type LocalAccess, type Remote, type RemoteRow, type PushResult,
} from "@/lib/account/sync";
import {
  readAccountConfig, requestMagicLink, readRedirect, hasAuthParams, exchangeCode, createPkcePair, freshSession,
  refreshSession, supabaseRemote, deleteAccountRemote, jwtClaims, AccountError, wellFormed, signOutRemote,
  type Session,
} from "@/lib/account/supabase";
import {
  startSync, signOut, deleteAccount, completeSignInFromUrl, sendSignInLink, forgetThisBrowser, onPulled,
  accountStatus, currentSession,
} from "@/lib/account/client";
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

// ---- fixtures ------------------------------------------------------------------------------------
const PROFILE: UserProfile = {
  name: "Ana", goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200, fatGrams: 65,
  maxCookTime: 30, maxIngredients: 10,
};
function meal(name: string, type: "breakfast" | "lunch" | "dinner") {
  return {
    name, type, description: "", calories: 600, proteinGrams: 45, carbsGrams: 60, fatGrams: 20,
    timeMinutes: 20, ingredients: [{ name: "rice", quantity: "80 g" }], steps: ["cook"],
  };
}
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
function week(tag: string): WeekPlan {
  return {
    days: DAYS.map((day) => ({ day, meals: [meal(`${tag} oats`, "breakfast"), meal(`${tag} bowl`, "lunch"), meal(`${tag} stew`, "dinner")] })),
    weekSummary: `week ${tag}`,
  } as WeekPlan;
}
const summary = (v: unknown) => (v as WeekPlan | null)?.weekSummary;

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
  check("clearAll: empties every nutriflow key, including backups, meta, synced, owner and session", memory.keys().length === 0,
    memory.keys().join());
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

  check("validate: a cleared store (null) is always acceptable", checkStore("plan", null) === null);
  check("validate: a real week and a real import pass",
    checkStore("plan", week("OK")) === null && checkStore("imports", [{ name: "R", sourceUrl: "https://e.com/r", ingredients: [], steps: [] }]) === null);
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
function jsonbOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonbOrder((v as Record<string, unknown>)[k])]));
  }
  return v;
}

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
function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

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

  const kindFor = async (status: number) => {
    const ff = fakeFetch(() => ({ status, body: { message: "x" } }));
    try { await supabaseRemote(cfg, sess, ff.f).push([{ name: "saved", value: [], at: 0 }]); return "none"; }
    catch (e) { return (e as AccountError).kind + ((e as AccountError).retryable ? "+retry" : ""); }
  };
  check("error kind: 401 is an expired sign-in, not retryable", (await kindFor(401)) === "auth");
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
class FakeSupabase {
  users = new Map<string, { id: string; email: string }>();
  rows = new Map<string, Map<string, { value: unknown; updated_at: string }>>();
  access = new Map<string, string>();
  refresh = new Map<string, string>();
  codes = new Map<string, { email: string; challenge: string }>();
  lastCode = new Map<string, string>();
  down = false;
  refuseRefresh = false;
  /** A store whose rows Postgres refuses (e.g. a value jsonb can't hold); a batch containing it fails whole. */
  refuseKey: string | null = null;
  /** Make the next N pulls fail with a 503 while everything else works (a transient server error). */
  failPulls = 0;
  /** Make pulls take this long, so a test can act while one is in flight. */
  pullDelayMs = 0;
  /** Lifetime of the next issued access token, in seconds (negative = already expired). */
  nextExpiresIn = 3600;
  writes = 0;
  logouts = 0;
  private n = 0;
  user(email: string) {
    const id = `uid-${email.split("@")[0]}`;
    if (!this.users.has(id)) this.users.set(id, { id, email });
    return this.users.get(id)!;
  }
  private issue(id: string) {
    const u = this.users.get(id)!;
    const access = fakeJwt({ sub: id, email: u.email, n: ++this.n });
    const refresh = `rt-${this.n}`;
    this.access.set(access, id);
    this.refresh.set(refresh, id);
    const expiresIn = this.nextExpiresIn;
    this.nextExpiresIn = 3600;
    return { access_token: access, refresh_token: refresh, expires_in: expiresIn, user: u };
  }
  /** Hand out a session directly (as an attacker would have for their OWN account). */
  sessionFor(email: string) {
    return this.issue(this.user(email).id);
  }
  table(id: string) {
    return this.rows.get(id) ?? this.rows.set(id, new Map()).get(id)!;
  }
  fetch = (async (input: string, init: RequestInit = {}) => {
    if (this.down) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
    if (headers.apikey !== "ANON") return reply(401, { message: "No API key found in request" });

    if (url.pathname === "/auth/v1/otp" && method === "POST") {
      if (!body?.code_challenge) return reply(400, { msg: "this fake only does PKCE" });
      this.user(body.email);
      const code = `code${++this.n}xyz`;
      this.codes.set(code, { email: body.email, challenge: body.code_challenge });
      this.lastCode.set(body.email, code);
      return reply(200, {});
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const c = this.codes.get(body?.auth_code);
      if (!c) return reply(404, { error_code: "flow_state_not_found" });
      if (s256(body.code_verifier ?? "") !== c.challenge) return reply(400, { error_code: "bad_code_verifier" });
      this.codes.delete(body.auth_code); // one use
      return reply(200, this.issue(this.user(c.email).id));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const id = this.refresh.get(body?.refresh_token);
      if (!id || this.refuseRefresh || !this.users.has(id)) return reply(400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
      this.refresh.delete(body.refresh_token); // rotation: an old refresh token works once
      return reply(200, this.issue(id));
    }
    const uid = this.access.get((headers.Authorization ?? "").replace(/^Bearer /, ""));
    if (url.pathname === "/auth/v1/logout") {
      if (!uid) return reply(403, { error_code: "bad_jwt" });
      this.logouts++;
      return reply(204);
    }
    if (!uid || !this.users.has(uid)) return reply(401, { message: "JWT expired" });

    if (url.pathname === "/rest/v1/rpc/delete_my_account" && method === "POST") {
      this.users.delete(uid);
      this.rows.delete(uid);
      return reply(204);
    }
    if (url.pathname === "/rest/v1/rpc/upsert_state" && method === "POST") {
      const incoming = (body?.rows ?? []) as { key: string; value: unknown; updated_at: string }[];
      // One SQL statement: refused whole.
      if (this.refuseKey && incoming.some((r) => r.key === this.refuseKey)) return reply(400, { code: "22P05", message: "unsupported Unicode escape sequence" });
      if (incoming.some((r) => JSON.stringify(r.value).length > 1_000_000)) return reply(400, { code: "23514", message: "user_state_value_size" });
      const skipped: string[] = [];
      for (const r of incoming) {
        const cur = this.table(uid).get(r.key);
        if (cur && Date.parse(cur.updated_at) >= Date.parse(r.updated_at)) skipped.push(r.key);
        else this.table(uid).set(r.key, { value: jsonbOrder(r.value), updated_at: r.updated_at });
      }
      this.writes++;
      return reply(200, skipped);
    }
    if (url.pathname === "/rest/v1/user_state") {
      const filterUser = (url.searchParams.get("user_id") ?? "").replace(/^eq\./, "");
      // RLS: only your own rows exist, whatever the filter says.
      const mine = filterUser && filterUser !== uid ? new Map() : this.table(uid);
      if (method === "GET") {
        if (this.failPulls > 0) {
          this.failPulls--;
          return reply(503, { message: "upstream timeout" });
        }
        if (this.pullDelayMs) await new Promise((r) => setTimeout(r, this.pullDelayMs));
        return reply(200, [...mine.entries()].map(([key, r]) => ({ key, value: r.value, updated_at: r.updated_at })));
      }
      if (method === "DELETE") {
        this.rows.delete(uid);
        return reply(204);
      }
    }
    return reply(404, { message: `no route ${method} ${url.pathname}` });
  }) as typeof fetch;
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const realNow = Date.now;
let clockOffset = 0;
/** Move this process's clock forward, for the "come back to the tab later" checks. */
function advanceClock(ms: number) {
  clockOffset += ms;
  Date.now = () => realNow() + clockOffset;
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

  // ---- sign out keeps the device's data ----
  memory.clear();
  fakeWindow.localStorage = laptop;
  await signIn("ana@example.com");
  await startSync();
  await signOut();
  check("sign-out: the session is gone", currentSession() === null && accountStatus().state === "signed-out");
  check("sign-out: the device KEEPS its week (the account is a mirror)", storage.loadPlan() !== null);
  check("sign-out: no listeners are left behind", fakeDocument.count("visibilitychange") === 0 && fakeWindow.count("online") === 0);
  check("sign-out: the server ended this browser's session", sb.logouts > 0);

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
  check("delete account: the browser's data is no longer tied to the deleted account", storage.loadSyncOwner() === null);

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
  check("failed first sync: …with the account's earlier list kept as a copy, not lost",
    storage.loadBackups().some((b) => json(b.data.saved) === json(["Dal"])) || json(storage.loadSaved()) === json(["Shakshuka"]));

  // ---- signing out while offline says the last edits didn't make it ----
  sb.down = true;
  storage.toggleSaved("Dal");
  await signOut();
  check("sign-out offline: says the latest changes hadn't reached the account, and that they're kept",
    (accountStatus().message ?? "").includes("hadn't reached") && json(storage.loadSaved()).includes("Dal"));
  sb.down = false;

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
    storage.loadSaved().length === 0 && kiosk.keys().filter((k) => !k.startsWith("nutriflow.pkce")).length === 0, kiosk.keys().join());
  fakeWindow.localStorage = desk;

  // ---- forget this browser: stop syncing first, end the sign-in, clear ----
  await signIn("carol@example.com");
  await startSync();
  const carolRows = sb.table("uid-carol").size;
  await forgetThisBrowser();
  check("forget: the browser is emptied and signed out", currentSession() === null && storage.loadSaved().length === 0 && desk.keys().length === 0);
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
