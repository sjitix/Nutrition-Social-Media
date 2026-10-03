/**
 * Accounts-lane test suite — `node scripts/test-account.mjs`.
 *
 * Proves the parts of accounts that need no keys and no network: the export file (A1), the sync
 * rules and engine (A2), and storage.ts's new bookkeeping. Runs in plain node — `window.localStorage`
 * is faked with a Map, and the account side is an in-memory fake server — so a red result can only
 * mean the code is wrong, never that a service was down.
 */

// ---- a fake browser, installed BEFORE storage.ts is imported -------------------------------------
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return [...this.m.keys()]; }
}
const memory = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: memory };

import * as storage from "@/lib/storage";
import {
  buildExport, parseExport, applyImport, describeData, exportFilename, EXPORT_FORMAT, PORTABLE_STORES,
} from "@/lib/account/portable";
import { planSync, unionStore, type Side } from "@/lib/account/merge";
import { syncNow, createMirror, localSide, type LocalAccess, type Remote, type RemoteRow } from "@/lib/account/sync";
import {
  readAccountConfig, requestMagicLink, sessionFromRedirect, freshSession, supabaseRemote, deleteAccountRemote, jwtClaims,
} from "@/lib/account/supabase";
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
    !storage.STORE_NAMES.some((n) => ["meta", "backup", "session"].includes(n)));
}

// backup + restore
{
  memory.clear();
  storage.saveProfile(PROFILE);
  storage.savePlan(week("MINE"));
  const b = storage.takeBackup("before a test");
  check("backup: snapshots the stores that hold data", b.data.plan !== undefined && b.data.profile !== undefined);
  check("backup: does not invent stores that were empty", !("batchPlan" in b.data));

  storage.savePlan(week("REPLACED"));
  storage.saveBatchPlan(week("NEW-BATCH"));
  check("restore: reports success", storage.restoreBackup() === true);
  check("restore: the replaced week is back", storage.loadPlan()?.weekSummary === "week MINE");
  check("restore: a store that was EMPTY at backup time is empty again", storage.loadBatchPlan() === null);
  check("restore: the backup is consumed, so it cannot be applied twice", storage.loadBackup() === null && storage.restoreBackup() === false);
}

// clearAll is local and silent
{
  memory.clear();
  storage.saveProfile(PROFILE);
  storage.saveSessionRaw({ access_token: "x" });
  storage.takeBackup("x");
  const seen: StoreName[] = [];
  const off = storage.onStoreChange((c) => seen.push(c.name));
  storage.clearAll();
  off();
  check("clearAll: empties every nutriflow key, including backup, meta and session", memory.keys().length === 0,
    memory.keys().join());
  check("clearAll: is SILENT — clearing a device must never empty the account as a side effect", seen.length === 0);
}

// =================================================================================================
// portable.ts — A1, the export file
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

  // round trip into a different "device"
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
  check("reject: a week plan in the wrong shape", err(good({ plan: { days: "Monday" } })).includes("week plan"));
  check("reject: visits that aren't dates", err(good({ visits: ["yesterday"] })).includes("isn't a date"));
  check("reject: a file over the size cap", err("x".repeat(5_000_001)).includes("too large"));

  const mixed = parseExport(good({ saved: ["A"], plan: { days: 3 } }));
  check("reject WHOLE: one bad store means nothing is imported", !mixed.ok && mixed.error.startsWith("Nothing was imported"));

  const future = parseExport(good({ saved: ["A"], streakBadges: [1] }));
  check("unknown store: skipped with a warning, not fatal", future.ok && future.warnings.length === 1 && future.stores.join() === "saved");
}

// =================================================================================================
// merge.ts — A2, the rules
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

  check("rule 2: local newer → push", kinds({ plan: v("L", 9) }, { plan: v("R", 5) }) === "plan:push");
  check("rule 2: remote newer → pull", kinds({ plan: v("L", 5) }, { plan: v("R", 9) }) === "plan:pull");
  check("rule 2: a newer CLEAR wins — deleting on one device deletes everywhere",
    (() => { const a = planSync({ saved: v(null, 9) }, { saved: v(["a"], 5) }, 0).actions[0]; return a.kind === "push" && a.value === null; })());
  check("rule 4: a tie goes to the account", kinds({ plan: v("L", 5) }, { plan: v("R", 5) }) === "plan:pull");

  const backup = planSync({ plan: v("L", 5) }, { plan: v("R", 9) }, 0);
  check("rule 5: replacing differing local data asks for a backup", backup.needsBackup);
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
  check("rule 3: imports dedupe by link, this device's copy first", imports.map((i) => i.name).join() === "a,b,c");
}

// =================================================================================================
// sync.ts — A2, the engine, with two fake devices and a fake server
// =================================================================================================
class FakeServer implements Remote {
  rows = new Map<StoreName, RemoteRow>();
  pushes = 0;
  failNext = 0;
  async pull() { return [...this.rows.values()].map((r) => ({ ...r })); }
  async push(rows: RemoteRow[]) {
    if (this.failNext > 0) { this.failNext--; throw new Error("network down"); }
    this.pushes++;
    for (const r of rows) this.rows.set(r.name, { ...r });
  }
  async removeAll() { this.rows.clear(); }
}

/** An in-memory device: the LocalAccess contract without a browser. */
class FakeDevice implements LocalAccess {
  names = storage.STORE_NAMES;
  data = new Map<StoreName, unknown>();
  times: Partial<Record<StoreName, number>> = {};
  backups: string[] = [];
  edit(n: StoreName, v: unknown, at: number) { this.data.set(n, v); this.times[n] = at; }
  read(n: StoreName) { return this.data.has(n) ? this.data.get(n) : null; }
  meta() { return { ...this.times }; }
  writeSilently(n: StoreName, v: unknown, at: number) { if (v === null) this.data.delete(n); else this.data.set(n, v); this.times[n] = at; }
  backup(reason: string) { this.backups.push(reason); }
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

  const r2 = await syncNow(phone, server, 200);
  check("engine: a second device pulls the account down", r2.pulled.join() === "plan,profile" &&
    (phone.read("plan") as WeekPlan).weekSummary === "week LAPTOP");

  phone.edit("plan", week("PHONE-EDIT"), 300);
  await syncNow(phone, server, 310);
  await syncNow(laptop, server, 320);
  check("engine: an edit on one device reaches the other", (laptop.read("plan") as WeekPlan).weekSummary === "week PHONE-EDIT");

  // The case to design out first: a device that already has its own week signs in to an account
  // that has a different, newer one.
  const tablet = new FakeDevice();
  tablet.edit("plan", week("TABLET-OWN"), 50);
  const r3 = await syncNow(tablet, server, 400);
  check("engine: the newer account week wins on a device with an older week", (tablet.read("plan") as WeekPlan).weekSummary === "week PHONE-EDIT");
  check("engine: …but the device's own week is BACKED UP first, never silently lost", r3.backedUp && tablet.backups.length === 1);

  // Pre-sync data with no timestamp (written by an older app version) loses to the account but is backed up.
  const old = new FakeDevice();
  old.data.set("plan", week("LEGACY"));
  const side = localSide(old);
  check("engine: legacy data with no timestamp is treated as oldest", side.plan?.at === 0);
  const r4 = await syncNow(old, server, 500);
  check("engine: …and is backed up before the account replaces it", r4.backedUp);

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
  const mirror = createMirror(server, { ...timers, onStatus: (s) => statuses.push(s) });

  mirror.enqueue("plan", "v1", 1);
  mirror.enqueue("plan", "v2", 2);
  mirror.enqueue("saved", ["a"], 3);
  check("mirror: nothing is sent before the debounce fires", server.pushes === 0 && mirror.status() === "pending");
  await mirror.flush();
  check("mirror: edits to one store collapse — the LAST value is sent", server.rows.get("plan")?.value === "v2");
  check("mirror: one push for a burst of edits", server.pushes === 1);
  check("mirror: status ends 'saved'", mirror.status() === "saved");

  server.failNext = 1;
  mirror.enqueue("plan", "v3", 4);
  await mirror.flush();
  check("mirror: a failed push reports 'offline'", mirror.status() === "offline");
  check("mirror: …and keeps the edit queued, not dropped", server.rows.get("plan")?.value === "v2");
  mirror.enqueue("saved", ["a", "b"], 5);
  await mirror.flush();
  check("mirror: the late edit goes out with the next one", server.rows.get("plan")?.value === "v3" && json(server.rows.get("saved")?.value) === json(["a", "b"]));

  mirror.stop();
  mirror.enqueue("plan", "after-stop", 9);
  await mirror.flush();
  check("mirror: stopped (signed out) means nothing more is sent", server.rows.get("plan")?.value === "v3");
  check("mirror: statuses were reported as they happened", statuses.includes("saving") && statuses.includes("offline"));
})();

// =================================================================================================
// supabase.ts — A4, the REST client, against a fake fetch
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

  // magic link
  const ml = fakeFetch(() => ({ body: {} }));
  await requestMagicLink(cfg, "  ana@example.com ", "https://ntrux.vercel.app/sage/account", ml.f);
  const c0 = ml.calls[0];
  check("magic link: POSTs to /auth/v1/otp with the redirect", c0.method === "POST" &&
    c0.url === "https://proj.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fntrux.vercel.app%2Fsage%2Faccount");
  check("magic link: sends the anon key and the trimmed email", c0.headers.apikey === "ANON" && json(c0.body) === json({ email: "ana@example.com", create_user: true }));
  let msg = "";
  try { await requestMagicLink(cfg, "not-an-email", "x", ml.f); } catch (e) { msg = (e as Error).message; }
  check("magic link: a non-address is refused before any request", msg.includes("email address") && ml.calls.length === 1);
  const limited = fakeFetch(() => ({ status: 429, body: { msg: "rate" } }));
  try { await requestMagicLink(cfg, "a@b.co", "x", limited.f); } catch (e) { msg = (e as Error).message; }
  check("magic link: rate limiting reads as advice, not a code", msg.startsWith("Too many sign-in emails"));
  const down = fakeFetch(() => "throw");
  try { await requestMagicLink(cfg, "a@b.co", "x", down.f); } catch (e) { msg = (e as Error).message; }
  check("network down: says offline, and that local data is safe", msg.includes("offline") && msg.includes("safe on this device"));

  // the redirect
  const token = fakeJwt({ sub: "user-1", email: "ana@example.com" });
  const s = sessionFromRedirect(`#access_token=${token}&refresh_token=R1&expires_in=3600&token_type=bearer&type=magiclink`, 1000);
  check("redirect: reads the session from the URL hash", s?.userId === "user-1" && s.email === "ana@example.com" && s.refreshToken === "R1" && s.expiresAt === 4600);
  check("redirect: a URL with no sign-in in it is null, not an error", sessionFromRedirect("#section-2") === null && sessionFromRedirect("") === null);
  try { sessionFromRedirect("#error=access_denied&error_description=Email+link+is+invalid+or+has+expired"); msg = ""; } catch (e) { msg = (e as Error).message; }
  check("redirect: an expired link says so and says what to do", msg.includes("expired") && msg.includes("new one"));

  // refresh
  const t2 = fakeJwt({ sub: "user-1", email: "ana@example.com" });
  const rf = fakeFetch(() => ({ body: { access_token: t2, refresh_token: "R2", expires_in: 3600, user: { id: "user-1", email: "ana@example.com" } } }));
  const kept = await freshSession(cfg, s!, rf.f, 1000);
  check("refresh: a token with time left is reused, no request", kept === s && rf.calls.length === 0);
  const renewed = await freshSession(cfg, s!, rf.f, 4590);
  check("refresh: a token about to expire is refreshed", rf.calls.length === 1 && rf.calls[0].url.endsWith("/auth/v1/token?grant_type=refresh_token"));
  check("refresh: the ROTATED refresh token is kept", renewed.refreshToken === "R2" && json(rf.calls[0].body) === json({ refresh_token: "R1" }));

  // the table
  const sess = async () => s!;
  const pull = fakeFetch(() => ({ body: [{ key: "plan", value: { x: 1 }, updated_at: "2026-10-03T10:00:00.000Z" }] }));
  const rows = await supabaseRemote(cfg, sess, pull.f).pull();
  check("pull: reads this user's rows with the bearer token", pull.calls[0].url.includes("user_id=eq.user-1") &&
    pull.calls[0].headers.Authorization === `Bearer ${token}` && pull.calls[0].headers.apikey === "ANON");
  check("pull: rows become versioned stores (ISO time → ms)", rows[0].name === "plan" && rows[0].at === Date.parse("2026-10-03T10:00:00.000Z"));

  const push = fakeFetch(() => ({ status: 201 }));
  await supabaseRemote(cfg, sess, push.f).push([{ name: "saved", value: ["a"], at: 0 }, { name: "chat", value: null, at: 5 }]);
  const pc = push.calls[0];
  check("push: an UPSERT on (user_id, key)", pc.method === "POST" && pc.url.endsWith("on_conflict=user_id,key") &&
    pc.headers.Prefer.includes("resolution=merge-duplicates"));
  check("push: rows carry user, store, value and the device's write time", json(pc.body) === json([
    { user_id: "user-1", key: "saved", value: ["a"], updated_at: "1970-01-01T00:00:00.000Z" },
    { user_id: "user-1", key: "chat", value: null, updated_at: "1970-01-01T00:00:00.005Z" },
  ]));
  const none = fakeFetch(() => ({ status: 201 }));
  await supabaseRemote(cfg, sess, none.f).push([]);
  check("push: nothing to send means no request", none.calls.length === 0);

  const del = fakeFetch(() => ({ status: 204 }));
  await deleteAccountRemote(cfg, s!, del.f);
  check("delete account: calls the delete_my_account function as the user", del.calls[0].url.endsWith("/rest/v1/rpc/delete_my_account") &&
    del.calls[0].headers.Authorization === `Bearer ${token}`);
  const denied = fakeFetch(() => ({ status: 401, body: { message: "JWT expired" } }));
  try { await deleteAccountRemote(cfg, s!, denied.f); msg = ""; } catch (e) { msg = (e as Error).message; }
  check("delete account: a failure says NOTHING was deleted", msg.includes("Nothing was deleted"));

  check("jwt: an unreadable token is null, not a crash", jwtClaims("garbage") === null);
})();

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
