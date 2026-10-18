/**
 * THE LOCAL LIVE RUN: the real client.ts and storage.ts against the REAL GoTrue, PostgREST and Postgres
 * (scripts/account-live/stack.sh), not the fake every other suite uses. Run by scripts/account-live/run.mjs,
 * which brings the stack up, bundles one copy of the app's modules per device, and tears it all down.
 *
 * Why it exists: this lane's worst bugs hid behind fakes that were kinder than the platform (lesson 52).
 * Every check here is something only the real servers can answer: the email GoTrue really sends, the
 * redirect /verify really makes, its 60-second limit, token rotation, RLS and upsert_state as PostgREST
 * really runs them, and what a deleted account's still-valid token really gets back.
 *
 * Devices: Sam's laptop and phone (separate browsers), Rob on a browser of his own, and a fourth browser
 * ("Late") that opens a link Rob already used.
 */
import { execFileSync } from "node:child_process";
import { MemoryStorage, Events, PROFILE, week, summary } from "../account-fakes";

type Device = { storage: typeof import("@/lib/storage"); client: typeof import("@/lib/account/client") };
type Win = Events & {
  localStorage: MemoryStorage;
  sessionStorage: MemoryStorage;
  location: { origin: string; pathname: string; search: string; hash: string; reload: () => void };
};

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const windows: Record<string, Win> = {};
const docs: Record<string, Events & { visibilityState: "visible" | "hidden" }> = {};

function makeDevice(name: string) {
  const window = Object.assign(new Events(), {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    location: { origin: "http://localhost:3000", pathname: "/sage/account", search: "", hash: "", reload: () => {} },
  }) as Win;
  const document = Object.assign(new Events(), { visibilityState: "visible" as "visible" | "hidden" });
  const history = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, window.location.origin);
      window.location.pathname = u.pathname;
      window.location.search = u.search;
      window.location.hash = u.hash;
    },
  };
  windows[name] = window;
  docs[name] = document;
  (globalThis as unknown as Record<string, unknown>)[`__TAB_${name}`] = { window, document, history };
}
const load = async (page: string): Promise<Device> => import(new URL(`./account-tab-${page}.mjs`, import.meta.url).href);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ""}`); }
}
const json = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function mayThrow<T>(p: Promise<T>): Promise<T | Error> {
  try { return await p; } catch (e) { return e as Error; }
}

// ---- the real servers, seen from outside the app ----
const seen = new Map<string, number>();
/** The newest sign-in email for this address, once it arrives (GoTrue sends it, the catcher keeps it). */
async function newMail(email: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const r = await fetch(`${URL_}/__live/mail?to=${encodeURIComponent(email)}`);
    if (r.ok) {
      const m = (await r.json()) as { url: string; at: number };
      if (m.at > (seen.get(email) ?? 0)) {
        seen.set(email, m.at);
        return m.url;
      }
    }
    await sleep(100);
  }
  throw new Error(`no new email for ${email}`);
}
/** Open a link as a browser would, up to the first redirect: where /verify sends the browser. */
async function open(url: string): Promise<URL> {
  const r = await fetch(url, { redirect: "manual" });
  const to = r.headers.get("location");
  if (!to) throw new Error(`no redirect from ${url}: ${r.status}`);
  return new URL(to);
}
async function landOn(name: string, to: URL) {
  windows[name].location.search = to.search;
  windows[name].location.hash = to.hash;
}
async function signIn(d: Device, name: string, email: string) {
  await d.client.sendSignInLink(email);
  await landOn(name, await open(await newMail(email)));
  return d.client.completeSignInFromUrl();
}
/** PostgREST as a signed-in user, the way the app reaches it. */
async function rest(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.text();
  return { status: r.status, body: body ? JSON.parse(body) : null };
}
/** Postgres as the project's own SQL editor sees it (superuser), for what no API shows. */
function db(sql: string): unknown[] {
  const out = execFileSync("wsl", ["-d", "Ubuntu", "--", `${process.env.LIVE_WSL_HOME}/.cache/nutriflow-live/node/bin/node`,
    `${process.env.LIVE_REPO}/scripts/account-live/db.mjs`, "query", sql], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}
async function hide(name: string) {
  docs[name].visibilityState = "hidden";
  docs[name].dispatch("visibilitychange");
  await sleep(800);
  docs[name].visibilityState = "visible";
}

for (const name of ["Lap", "Pho", "Rob", "Late"]) makeDevice(name);
const Lap = await load("Lap");
const Pho = await load("Pho");
const Rob = await load("Rob");
const Late = await load("Late");
const sam = "sam.live@example.com";
const rob = "rob.live@example.com";

// =================================================================================================
// 1. Sign in on a laptop that already has a week, and the week goes up
// =================================================================================================
Lap.storage.saveProfile({ ...PROFILE, name: "Sam", allergies: "peanuts" });
Lap.storage.savePlan(week("LAPTOP"));
const lapSession = await mayThrow(signIn(Lap, "Lap", sam));
check("sign-in: the real GoTrue's PKCE link signs the laptop in",
  !(lapSession instanceof Error) && !!lapSession && /^[0-9a-f-]{36}$/.test(lapSession.userId), String(lapSession instanceof Error ? lapSession.message : json(lapSession)));
check("sign-in: the address bar is cleared of the code", windows.Lap.location.search === "", windows.Lap.location.search);
await Lap.client.startSync();
const samToken = Lap.client.currentSession()!.accessToken;
const samId = Lap.client.currentSession()!.userId;
const rows = await rest("user_state?select=key,value", samToken);
check("first sync: the laptop's week and profile are in Sam's account, through the real PostgREST",
  rows.status === 200 && rows.body.some((r: { key: string; value: unknown }) => r.key === "plan" && summary(r.value) === "week LAPTOP") &&
    rows.body.some((r: { key: string }) => r.key === "profile"), json(rows));

// =================================================================================================
// 2. The phone, a minute later: GoTrue's per-person email limit is real, then the week comes down
// =================================================================================================
const tooSoon = await mayThrow(Pho.client.sendSignInLink(sam));
check("rate limit: a second link for the same person within a minute is refused (429), and says so",
  tooSoon instanceof Error && /too many sign-in emails/i.test(tooSoon.message), String(tooSoon instanceof Error ? tooSoon.message : "no error"));
console.log("      (waiting out GoTrue's 60-second per-person email limit)");
await sleep(61_000);
const phoSession = await mayThrow(signIn(Pho, "Pho", sam));
check("sign-in: the phone signs in to the same account (the verifier kept from the refused request still works)",
  !(phoSession instanceof Error) && phoSession?.userId === samId, String(phoSession instanceof Error ? phoSession.message : json(phoSession)));
await Pho.client.startSync();
check("second device: the phone pulls the laptop's week", summary(Pho.storage.loadPlan()) === "week LAPTOP", summary(Pho.storage.loadPlan()));

// =================================================================================================
// 3. An edit on the phone reaches the laptop
// =================================================================================================
Pho.storage.savePlan(week("PHONE"));
await hide("Pho"); // leaving the tab sends what is waiting
windows.Lap.dispatch("online"); // the laptop comes back: it pulls
await sleep(1500);
check("mirror: the phone's edit reaches the account and comes down on the laptop",
  summary(Lap.storage.loadPlan()) === "week PHONE", summary(Lap.storage.loadPlan()));

// =================================================================================================
// 4. upsert_state on the real server: a write older than the account's copy is skipped
// =================================================================================================
const stale = await rest("rpc/upsert_state", samToken, {
  method: "POST", body: json({ rows: [{ key: "plan", value: week("OLD"), updated_at: "2001-01-01T00:00:00Z" }] }),
});
check("upsert_state: an older write is skipped, and named as skipped", stale.status === 200 && json(stale.body) === json(["plan"]), json(stale));
check("upsert_state: …and the account still holds the newer week",
  summary((await rest("user_state?key=eq.plan&select=value", samToken)).body?.[0]?.value) === "week PHONE");

// =================================================================================================
// 5. A token past its expiry is renewed, and the rotated refresh token is the one kept
// =================================================================================================
const before = Pho.storage.loadSessionRaw() as { refreshToken: string; expiresAt: number };
Pho.storage.saveSessionRaw({ ...before, expiresAt: Math.floor(Date.now() / 1000) - 5 });
Pho.storage.toggleSaved("Lentil soup");
await hide("Pho");
const after = Pho.storage.loadSessionRaw() as { refreshToken: string; expiresAt: number; accessToken: string };
const saved = await rest("user_state?key=eq.saved&select=value", after.accessToken);
check("renewal: an expired token is renewed by the real GoTrue before the push",
  after.refreshToken !== before.refreshToken && after.expiresAt > Date.now() / 1000, json({ before: before.refreshToken.slice(0, 6), after: after.refreshToken.slice(0, 6) }));
check("renewal: …and the edit went up with the new token", json(saved.body?.[0]?.value ?? null).includes("Lentil soup"), json(saved));
const reuse = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
  method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: json({ refresh_token: before.refreshToken }),
});
console.log(`      (the spent refresh token, reused: ${reuse.status})`);

// =================================================================================================
// 6. Another person: RLS keeps the accounts apart, and signing out really ends the session
// =================================================================================================
await signIn(Rob, "Rob", rob);
await Rob.client.startSync();
const robToken = Rob.client.currentSession()!.accessToken;
const peek = await rest(`user_state?user_id=eq.${samId}&select=key`, robToken);
check("RLS: Rob asking for Sam's rows by her id gets none", peek.status === 200 && Array.isArray(peek.body) && peek.body.length === 0, json(peek));
const forge = await rest("user_state", robToken, { method: "POST", body: json({ user_id: samId, key: "saved", value: ["forged"] }) });
check("RLS: Rob cannot write a row carrying Sam's id", forge.status >= 400, json(forge));
const robRefresh = Rob.client.currentSession()!.refreshToken;
await Rob.client.signOut();
const afterOut = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
  method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: json({ refresh_token: robRefresh }),
});
check("sign-out: the real GoTrue refuses the signed-out session's refresh token", afterOut.status >= 400, String(afterOut.status));
check("sign-out: …and the page says nothing about the server being unreachable",
  !(Rob.client.accountStatus().message ?? "").includes("couldn't be reached"), json(Rob.client.accountStatus()));

// A used link, opened again (the newest-link sentence, batch 5)
const robLink = (await (await fetch(`${URL_}/__live/mail?to=${encodeURIComponent(rob)}`)).json()) as { url: string };
await landOn("Late", await open(robLink.url));
const reopened = await mayThrow(Late.client.completeSignInFromUrl());
check("used link: opening it again is refused, with the sentence that says only the newest link works",
  reopened instanceof Error && reopened.message.includes("only the newest link"), String(reopened instanceof Error ? reopened.message : json(reopened)));

// =================================================================================================
// 7. Sam deletes her account on the phone; the laptop, still holding a valid token, finds out
// =================================================================================================
const lapToken = Lap.client.currentSession()!.accessToken;
await Pho.client.deleteAccount();
check("delete: the account and every row of it are gone from the real database",
  json(db(`select count(*)::int as n from auth.users where id = '${samId}'`)) === json([{ n: 0 }]) &&
    json(db(`select count(*)::int as n from public.user_state where user_id = '${samId}'`)) === json([{ n: 0 }]));
Lap.storage.savePlan(week("LAPTOP-AFTER"));
await hide("Lap"); // the laptop's push meets the deleted account: 23503, a 409 from the real PostgREST
check("deleted elsewhere: the laptop says the account was deleted, and stops",
  Lap.client.accountStatus().state === "signed-out" && (Lap.client.accountStatus().message ?? "").includes("was deleted"),
  json(Lap.client.accountStatus()));
check("deleted elsewhere: …and keeps its week", summary(Lap.storage.loadPlan()) === "week LAPTOP-AFTER");
const logout = await fetch(`${URL_}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${lapToken}` } });
const logoutBody = (await logout.json().catch(() => ({}))) as { error_code?: string; code?: string };
check("platform: /logout with a deleted account's token answers 403 user_not_found (what signOutRemote treats as ended)",
  logout.status === 403 && (logoutBody.error_code ?? logoutBody.code) === "user_not_found", json({ status: logout.status, logoutBody }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
