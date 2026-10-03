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
const tabs: Record<string, { window: Win; document: Doc; shared: boolean; deaf: boolean; missed: (() => void)[] }> = {};
const reloads: Record<string, number> = {};
const refreshes: Record<string, number> = {};

/** The browser's one localStorage, as tab `self` sees it: a write fires `storage` in the other tabs. */
function sharedStorage(self: string) {
  const tell = (key: string | null, oldValue: string | null, newValue: string | null) => {
    for (const [name, t] of Object.entries(tabs)) {
      if (name === self || !t.shared) continue;
      const deliver = () => t.window.dispatch("storage", { key, oldValue, newValue });
      if (t.deaf) t.missed.push(deliver);
      else setTimeout(deliver, 0);
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
  tabs[name] = { window, document, shared: isShared, deaf: false, missed: [] };
  (globalThis as unknown as Record<string, unknown>)[`__TAB_${name}`] = { window, document, history };
}

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "ANON";
const sb = new FakeSupabase();
(globalThis as unknown as Record<string, unknown>).fetch = sb.fetch;

for (const t of ["A", "B", "C", "D", "E", "F", "G", "H", "K", "L", "M", "N"]) makeTab(t, sharedStorage(t), true);
makeTab("P", new MemoryStorage(), false);
const load = async (t: string): Promise<Tab> => import(new URL(`./account-tab-${t}.mjs`, import.meta.url).href);
const A = await load("A");
const B = await load("B");
const C = await load("C");
const D = await load("D");
const E = await load("E");
const F = await load("F");
const G = await load("G");
const H = await load("H");
const K = await load("K");
const L = await load("L");
const M = await load("M");
const N = await load("N");
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
/**
 * A tab that hears late: a busy or background tab. Its `storage` events wait until `hear`, while its
 * own work (a sync whose answer arrives) carries on. That gap is where a stale tab can still write.
 */
function deafen(name: string) {
  tabs[name].deaf = true;
}
async function hear(name: string) {
  tabs[name].deaf = false;
  for (const deliver of tabs[name].missed.splice(0)) deliver();
  await settle();
}
/** The browser's whole localStorage, to prove an action changed none of it. */
const snapshot = () => JSON.stringify([...shared.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const changedKeys = (before: string, after: string) => {
  const b = new Map<string, string>(JSON.parse(before));
  const a = new Map<string, string>(JSON.parse(after));
  return [...new Set([...b.keys(), ...a.keys()])].filter((k) => b.get(k) !== a.get(k)).join(", ") || "none";
};
/** Run `act` (which may throw), and say whether the browser's storage is exactly as it was. */
function unchanged(act: () => unknown): { same: boolean; result: unknown; changed: string } {
  const before = snapshot();
  let result: unknown;
  try {
    result = act();
  } catch (e) {
    result = e;
  }
  const after = snapshot();
  return { same: after === before, result, changed: changedKeys(before, after) };
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

// =================================================================================================
// 4. THE WRITE FENCE: a save already under way when another tab switches accounts (review 2)
// =================================================================================================
// The reload above happens when the storage event arrives, a moment after the switch. A save made in
// between (an assistant turn finishing) used to land in the new account's storage, stamped newest.
{
  shared.clear();
  G.storage.saveProfile({ ...PROFILE, name: "Gia", allergies: "sesame" });
  G.storage.savePlan(week("GIA"));
  await signIn(G, "G", "gia@example.com");
  await G.client.startSync();
  const giaWeek = G.storage.loadPlan(); // what tab G's screens hold
  await G.client.signOut();
  sb.user("hal2@example.com");
  sb.table("uid-hal2").set("plan", { value: week("HAL2"), updated_at: new Date(Date.now() - 3_600_000).toISOString() });
  await signIn(H, "H", "hal2@example.com");
  await H.client.startSync(); // the switch: Gia's data set aside, Hal's brought down
  // Tab G saves its stale copy before it has reloaded:
  G.storage.savePlan({ ...(giaWeek as object), weekSummary: "week GIA + one more change" } as never);
  G.storage.saveProfile({ ...PROFILE, name: "Gia", allergies: "sesame" });
  check("fence: a tab that loaded the previous account's data cannot write it into the new account's storage",
    summary(H.storage.loadPlan()) === "week HAL2" && H.storage.loadProfile()?.name !== "Gia",
    json({ plan: summary(H.storage.loadPlan()), profile: H.storage.loadProfile()?.name ?? null }));

  // Everything else a stale tab could still write is refused too, and changes NOTHING (batch 4).
  const setAside = G.storage.loadBackups()[0];
  check("setup: the switch set Gia's data aside as a copy", summary(setAside?.data.plan) === "week GIA", json(setAside?.reason ?? null));
  const marked = unchanged(() => G.storage.markSynced("plan", Date.now()));
  check("fence: a stale tab's sync cannot mark stores synced in the new generation", marked.same, marked.changed);
  const restored = unchanged(() => G.storage.restoreBackup());
  check("fence: a stale tab cannot put a copy back into the new generation",
    restored.same && restored.result === false, `${restored.changed}; returned ${json(restored.result)}`);
  const putBack = unchanged(() => G.storage.putBackCopy(setAside.id, "before putting back the copy"));
  check("fence: …nor from the account page, whose safety copy alone could push another copy out of the three kept",
    putBack.same && putBack.result instanceof Error && String((putBack.result as Error).message).includes("another tab"),
    `${putBack.changed}; ${String(putBack.result)}`);
  const copied = unchanged(() => G.storage.takeBackup("taken in a stale tab"));
  check("fence: a stale tab cannot take a copy (before an import, or a sync's safety copy)",
    copied.same && copied.result instanceof Error, `${copied.changed}; ${String(copied.result)}`);
  const owned = unchanged(() => G.storage.saveSyncOwner("uid-gia"));
  check("fence: a stale tab cannot make the previous account this browser's owner", owned.same, owned.changed);

  advance(31_000);
  tabs.H.document.dispatch("visibilitychange");
  await settle();
  await settle();
  check("fence: …so nothing of the previous account reaches the new account",
    summary(sb.table("uid-hal2").get("plan")?.value) === "week HAL2" && !sb.table("uid-hal2").has("profile"),
    json({ plan: summary(sb.table("uid-hal2").get("plan")?.value), profile: sb.table("uid-hal2").has("profile") }));
  await H.client.signOut();

  // A tab that has only LISTED the copies (the account page, signed out) is just as stale. It learned
  // its generation from that read: learning it at its first write instead adopted the new one there.
  const G2 = await load("G2"); // tab G reloaded: a fresh page that reads nothing but the list of copies
  const listed = G2.storage.loadBackups();
  await signIn(H, "H", "ivy@example.com");
  await H.client.startSync(); // the browser changes hands again: Hal's data set aside for Ivy
  const late = unchanged(() => G2.storage.putBackCopy(listed[0].id, "before putting back the copy"));
  check("fence: a tab that had only listed the copies cannot put one back once the browser changed hands",
    late.same && late.result instanceof Error, `${late.changed}; ${String(late.result)}`);
  await H.client.signOut();
}

// =================================================================================================
// 5. What a sync said survives the reload it caused (review 2, ui-tests-10)
// =================================================================================================
{
  shared.clear();
  K.storage.saveProfile({ ...PROFILE, name: "Kim" });
  K.storage.savePlan(week("KIM"));
  await signIn(K, "K", "kim@example.com");
  await K.client.startSync();
  await K.client.signOut();
  sb.user("lou@example.com");
  sb.table("uid-lou").set("plan", { value: week("LOU"), updated_at: new Date(Date.now() - 3_600_000).toISOString() });
  await signIn(K, "K", "lou@example.com");
  await K.client.startSync(); // "set aside", and the week comes down: <AccountSync/> reloads the tab
  const said = K.client.accountStatus().message ?? "";
  K.client.carryNoteAcrossReload(); // what <AccountSync/> does just before reloading
  const K2 = await load("K2"); // the same tab, reloaded
  await K2.client.startSync();
  check("reload: what the sync said before the reload is still said after it",
    said.includes("set aside") && (K2.client.accountStatus().message ?? "").includes("set aside"),
    json({ before: said.slice(0, 60), after: K2.client.accountStatus().message ?? null }));
  await K2.client.signOut();
}

// =================================================================================================
// 6. The switch guard runs ONCE, even when the first sync fails and the page is reloaded (ui-tests-5 C4)
// =================================================================================================
{
  shared.clear();
  L.storage.saveProfile({ ...PROFILE, name: "Lia" });
  L.storage.savePlan(week("LIA"));
  await signIn(L, "L", "lia@example.com");
  await L.client.startSync();
  await L.client.signOut();
  await signIn(L, "L", "mo2@example.com");
  sb.failPulls = 1;
  await L.client.startSync(); // the switch: Lia's data set aside; then the first sync fails
  for (const page of ["L2", "L3", "L4"]) {
    const again = await load(page); // the person reloads; the first sync fails again
    sb.failPulls = 1;
    await again.client.startSync();
  }
  sb.failPulls = 0;
  check("switch guard: the previous account's data survives a failed first sync and three reloads",
    L.storage.loadBackups().some((b) => summary(b.data.plan) === "week LIA"),
    json(L.storage.loadBackups().map((b) => `${b.reason} -> ${Object.keys(b.data).join("+") || "empty"}`)));
}

// =================================================================================================
// 7. A stale tab's sync, answered after another tab switched accounts (review 2, batch 4)
// =================================================================================================
// Tab M's sync asks Max's account for its data. Before the answer arrives, Nia signs in in tab N and
// the browser changes hands; tab M has not heard yet (a busy tab hears late). Then M's answer lands
// and its sync runs to the end. Nothing of it may reach Nia's storage, and above all it must not
// record Max as the owner of what is now Nia's data: the next time Max signed in here, the switch
// guard would see the same account, and upload Nia's data, health notes included, into Max's account.
{
  shared.clear();
  M.storage.saveProfile({ ...PROFILE, name: "Max" });
  M.storage.savePlan(week("MAX"));
  await signIn(M, "M", "max@example.com");
  await M.client.startSync();
  mountAccountSync(M, "M");
  sb.user("nia@example.com");
  sb.table("uid-nia").set("plan", { value: week("NIA"), updated_at: new Date(Date.now() - 3_600_000).toISOString() });
  deafen("M");
  sb.nextPullDelayMs = 80;
  advance(31_000);
  tabs.M.document.dispatch("visibilitychange"); // back on tab M after a while: its sync pulls again
  await settle(10); // M's pull is on its way
  await signIn(N, "N", "nia@example.com");
  await N.client.startSync(); // the switch: Max's data set aside, Nia's brought down
  check("setup: the browser now holds Nia's week, and is hers",
    summary(N.storage.loadPlan()) === "week NIA" && N.storage.loadSyncOwner() === "uid-nia");
  const switched = snapshot();
  await settle(150); // tab M's answer lands, and its sync runs to the end
  check("stale sync: an answer landing after another tab switched accounts changes nothing in the browser",
    snapshot() === switched, changedKeys(switched, snapshot()));
  check("stale sync: …above all, the previous account is not recorded as the owner of the new one's data",
    N.storage.loadSyncOwner() === "uid-nia", json(N.storage.loadSyncOwner()));
  const before = reloads.M;
  await hear("M");
  check("stale sync: once tab M hears, it reloads", reloads.M > before, `reloads ${reloads.M - before}`);
  await N.client.signOut();
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
