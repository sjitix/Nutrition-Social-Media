/**
 * Accounts across the TABS of one browser. Run by `node scripts/test-account.mjs`, after the main suite.
 *
 * Each tab is its own instance of the real `storage.ts` and `client.ts` (`account-tab.mts`, bundled
 * once per tab with esbuild `define` pointing `window`, `document` and `history` at that tab's own
 * objects), so module state (the running sync, the status, every listener) is per tab, as in a
 * browser. The tabs share ONE localStorage, and a write in one fires a `storage` event in the OTHERS
 * only, a moment later, as a browser does. A phone has storage of its own. Everything runs against
 * the same FakeSupabase as the main suite (`account-fakes.mts`).
 *
 * Why it exists: review 2 found bugs that only happen with two tabs open (a tab left open while the
 * browser changes hands, a tab whose screens hold a week another tab replaced), and the single-tab
 * suite could not even express them.
 */
import { FakeSupabase, MemoryStorage, Events, PROFILE, week, summary } from "./account-fakes";

type Tab = { storage: typeof import("@/lib/storage"); client: typeof import("@/lib/account/client") };
type Doc = Events & { visibilityState: "visible" | "hidden" };
type Win = Events & {
  localStorage: unknown;
  sessionStorage: MemoryStorage;
  location: { origin: string; pathname: string; search: string; hash: string; reload: () => void };
};

// ---- one browser, several tabs ----------------------------------------------------------------
const shared = new Map<string, string>();
const tabs: Record<string, { window: Win; document: Doc; shared: boolean }> = {};
const reloads: Record<string, number> = {};
const refreshes: Record<string, number> = {};

/** The browser's one localStorage, as tab `self` sees it: a write fires `storage` in the other tabs. */
function sharedStorage(self: string) {
  const tell = (key: string | null, oldValue: string | null, newValue: string | null) => {
    for (const [name, t] of Object.entries(tabs)) {
      if (name !== self && t.shared) setTimeout(() => t.window.dispatch("storage", { key, oldValue, newValue }), 0);
    }
  };
  return {
    getItem: (k: string) => (shared.has(k) ? shared.get(k)! : null),
    setItem: (k: string, v: string) => {
      const old = shared.has(k) ? shared.get(k)! : null;
      const next = String(v);
      shared.set(k, next);
      if (old !== next) tell(k, old, next);
    },
    removeItem: (k: string) => {
      if (!shared.has(k)) return;
      const old = shared.get(k)!;
      shared.delete(k);
      tell(k, old, null);
    },
    clear: () => {
      shared.clear();
      tell(null, null, null);
    },
    keys: () => [...shared.keys()],
  };
}

function makeTab(name: string, storage: unknown, isShared: boolean): void {
  reloads[name] = 0;
  refreshes[name] = 0;
  const window = Object.assign(new Events(), {
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
    location: { origin: "https://ntrux.vercel.app", pathname: "/sage/plan", search: "", hash: "", reload: () => { reloads[name]++; } },
  }) as Win;
  const document = Object.assign(new Events(), { visibilityState: "visible" as "visible" | "hidden" }) as Doc;
  const history = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, window.location.origin);
      window.location.pathname = u.pathname;
      window.location.search = u.search;
      window.location.hash = u.hash;
    },
  };
  tabs[name] = { window, document, shared: isShared };
  (globalThis as unknown as Record<string, unknown>)[`__TAB_${name}`] = { window, document, history };
}

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "ANON";
const sb = new FakeSupabase();
(globalThis as unknown as Record<string, unknown>).fetch = sb.fetch;

for (const t of ["A", "B", "C", "D", "E", "F"]) makeTab(t, sharedStorage(t), true);
makeTab("P", new MemoryStorage(), false);
const load = async (t: string): Promise<Tab> => import(new URL(`./account-tab-${t}.mjs`, import.meta.url).href);
const A = await load("A");
const B = await load("B");
const C = await load("C");
const D = await load("D");
const E = await load("E");
const F = await load("F");
const P = await load("P");

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ""}`); }
}
const json = (v: unknown) => JSON.stringify(v);
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;
let offset = 0;
const advance = (ms: number) => { offset += ms; Date.now = () => realNow() + offset; };

async function signIn(T: Tab, name: string, email: string) {
  await T.client.sendSignInLink(email);
  tabs[name].window.location.search = `?code=${sb.lastCode.get(email)}`;
  return T.client.completeSignInFromUrl();
}
async function hide(name: string) {
  tabs[name].document.visibilityState = "hidden";
  tabs[name].document.dispatch("visibilitychange");
  await settle();
  await settle();
}
async function show(name: string) {
  advance(31_000);
  tabs[name].document.visibilityState = "visible";
  tabs[name].document.dispatch("visibilitychange");
  await settle();
  await settle();
  await settle();
}
/** What each tab's <AccountSync/> does on mount: watch the other tabs, with the page's own reload. */
function mountAccountSync(T: Tab, name: string) {
  return T.client.watchOtherTabs({
    reload: () => tabs[name].window.location.reload(),
    refresh: () => { refreshes[name]++; },
  });
}

// =================================================================================================
// 1. A tab left open while the browser changes hands (review 2, ui-tests-2)
// =================================================================================================
// Tab A: Ana is signed in with the assistant open, so its screen holds her week and profile in memory.
// In tab B, Ana signs out and Bob signs in. Tab A was never reloaded, so its next assistant turn
// wrote Ana's profile and week into storage that was now Bob's, and Bob's sync uploaded them.
{
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  sb.user("bob@example.com");
  sb.table("uid-bob").set("plan", { value: week("BOB"), updated_at: hourAgo });

  A.storage.saveProfile({ ...PROFILE, name: "Ana", allergies: "peanuts" });
  A.storage.savePlan(week("ANA"));
  await signIn(A, "A", "ana@example.com");
  await A.client.startSync();
  mountAccountSync(A, "A");
  mountAccountSync(B, "B");
  await B.client.startSync();
  await settle();
  check("setup: Ana's week is in her account", summary(sb.table("uid-ana").get("plan")?.value) === "week ANA");

  const before = reloads.A;
  // A token refreshed in tab B is the same person: no reason to disturb tab A.
  const s = B.storage.loadSessionRaw() as Record<string, unknown>;
  B.storage.saveSessionRaw({ ...s, accessToken: `${String(s.accessToken)}-refreshed` });
  await settle();
  check("tabs: a token refreshed in another tab does not reload this one", reloads.A === before, `reloads ${reloads.A - before}`);

  await B.client.signOut();
  await settle();
  check("tabs: a sign-out in another tab does not reload this one (the data here is still that person's)",
    reloads.A === before, `reloads ${reloads.A - before}`);

  // Tab A reloaded less than 30 s ago (its once-per-30-s reload for data is used up), so only the
  // unconditional reload for a browser changing hands can reload it now: what this check is about.
  A.storage.claimSyncReload();
  await signIn(B, "B", "bob@example.com");
  await B.client.startSync();
  await settle();
  await settle();
  check("tabs: when the browser changes hands in another tab, this tab reloads (its screens hold the previous account's data)",
    reloads.A > before, `reloads ${reloads.A - before}`);
  check("tabs: …and the other account's data never reaches the new account through the tab that switched",
    summary(sb.table("uid-bob").get("plan")?.value) === "week BOB" && !sb.table("uid-bob").has("profile"),
    json({ plan: summary(sb.table("uid-bob").get("plan")?.value), profile: sb.table("uid-bob").has("profile") }));
  await B.client.signOut();
}

// =================================================================================================
// 2. Another tab pulled the week this tab's screens hold (review 2, sync-4 / ui-tests-3)
// =================================================================================================
// Tabs C (Week) and D (Assistant) on a laptop, both signed in as Cy. The phone edits the week. Tab C
// pulls it into the shared storage, and its own sync reloads it. Tab D's sync then found nothing to
// pull, since C had already written it, so D was never told. D's next assistant turn wrote the OLD
// week back as the newest edit, and the phone's edit was gone on every device, with no copy.
{
  C.storage.savePlan(week("LAPTOP"));
  await signIn(C, "C", "cy@example.com");
  await C.client.startSync();
  mountAccountSync(C, "C");
  mountAccountSync(D, "D");
  await D.client.startSync();
  await settle();
  await hide("C");
  await hide("D");

  await signIn(P, "P", "cy@example.com");
  await P.client.startSync();
  P.storage.savePlan(week("PHONE"));
  await hide("P");
  check("setup: the phone's week is in the account", summary(sb.table("uid-cy").get("plan")?.value) === "week PHONE");

  const before = reloads.D;
  await show("C");
  check("tabs: tab C pulls the phone's week", summary(C.storage.loadPlan()) === "week PHONE");
  await settle();
  check("tabs: tab D, whose screens hold the week C just replaced, is reloaded too",
    reloads.D > before, `reloads ${reloads.D - before}`);

  // Signed out, another tab's edit is this device's own business again: no reloads for it here.
  await C.client.signOut();
  await settle();
  advance(31_000); // past tab D's once-per-30-s reload window, so only the signed-out rule can hold it back
  const quiet = reloads.D;
  const quietRefreshes = refreshes.D;
  C.storage.savePlan(week("SIGNED-OUT-EDIT"));
  await settle();
  check("tabs: with nobody signed in, another tab's edit neither reloads nor disturbs this one",
    reloads.D === quiet && refreshes.D === quietRefreshes, `reloads ${reloads.D - quiet}, refreshes ${refreshes.D - quietRefreshes}`);
}

// =================================================================================================
// 3. Another tab clears the browser ("Delete everything in this browser")
// =================================================================================================
// This tab's screens still hold data that is gone. Kept, their next save would put it back into a
// browser with no owner, and the next person to sign in would get it uploaded into THEIR account.
{
  await signIn(E, "E", "eve@example.com");
  await E.client.startSync();
  E.storage.savePlan(week("EVE"));
  mountAccountSync(E, "E");
  mountAccountSync(F, "F");
  await F.client.startSync();
  await settle();
  E.storage.claimSyncReload(); // as in 1: only the reload for a browser changing hands can fire now
  const before = reloads.E;
  await F.client.forgetThisBrowser();
  await settle();
  await settle();
  check("tabs: when another tab clears the browser, this tab reloads (its screens hold data that is gone)",
    reloads.E > before, `reloads ${reloads.E - before}`);
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
