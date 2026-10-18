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
// Batch 6's scenarios (the review of batches 4-5), loaded where they are used.
for (const t of ["Q", "R", "S", "T", "U", "V", "X", "Y", "Z", "W", "J", "I", "O", "Ca", "Da", "Cb", "Db", "Cc", "Dc", "Ka", "Ya", "Yb", "Ga", "Gb"]) {
  makeTab(t, sharedStorage(t), true);
}
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

/** The same account, signed in on a phone, deletes itself there (batch 5: the 23503 path). */
async function deleteFromPhone(email: string) {
  const phone = sb.sessionFor(email);
  await sb.fetch("https://fake.supabase.co/rest/v1/rpc/delete_my_account", {
    method: "POST", headers: { apikey: "ANON", Authorization: `Bearer ${phone.access_token}` },
  } as never);
}
/** Hold every request whose URL contains `path` until the returned function is called. */
function holdRequests(path: string): () => void {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const real = g.fetch;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  g.fetch = (async (input: string, init?: RequestInit) => {
    if (String(input).includes(path)) await gate;
    return real(input, init);
  }) as typeof fetch;
  return () => {
    g.fetch = real;
    open();
  };
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
  // Without this, a slow run would let M's answer land BEFORE the switch, and every check below would
  // pass without testing anything (the review of batches 4-5).
  check("setup: tab M's answer has not landed yet (the race this scenario is about)",
    M.client.accountStatus().state === "syncing", json(M.client.accountStatus()));
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

// =================================================================================================
// 8-19. The review of batches 4-5 (batch 6). Several were written by its test-fidelity lens, which
// proved each one fails without the guard it covers.
// =================================================================================================

// 8. A token renewal answered after ANOTHER account signed in, in another tab. liveSession's check that
//    the stored session is still Qia's is all that stands between that late answer and Rob's session
//    being used for her queued edit: her profile, allergies included, upserted into Rob's account.
{
  shared.clear();
  const Q = await load("Q");
  const R = await load("R");
  Q.storage.saveProfile({ ...PROFILE, name: "Qia", allergies: "shellfish" });
  await signIn(Q, "Q", "qia@example.com");
  await Q.client.startSync();
  mountAccountSync(Q, "Q");
  sb.user("rob@example.com");
  advance(3_700_000); // Q's access token has expired: its next request renews it first
  sb.refreshAnswerDelayMs = 150; // GoTrue renews at once; its answer is slow to come back
  Q.storage.saveProfile({ ...PROFILE, name: "Qia", allergies: "shellfish, sesame" }); // an edit, queued
  tabs.Q.document.visibilityState = "hidden";
  tabs.Q.document.dispatch("visibilitychange"); // the mirror flushes: its push asks for a live session
  await settle(20);
  await signIn(R, "R", "rob@example.com"); // Rob signs in, in tab R, while Q's renewal is on its way
  await settle(250);
  tabs.Q.document.visibilityState = "visible";
  check("renewal race: an answer arriving after another account signed in sends nothing into THAT account",
    !sb.table("uid-rob").has("profile"), json(sb.table("uid-rob").get("profile")?.value ?? null));
  await R.client.signOut();
}

// 9. "Delete everything in this browser" pressed in a tab that has not reloaded yet still deletes it all:
//    clearing removes the stores directly, whatever the write fence says.
{
  shared.clear();
  const S = await load("S");
  const T = await load("T");
  S.storage.loadPlan(); // tab S's screens load: it works from this generation
  await T.client.forgetThisBrowser(); // tab T clears the browser: a new generation starts
  T.storage.saveProfile({ ...PROFILE, name: "Tam", allergies: "milk" }); // and someone starts afresh there
  await S.client.forgetThisBrowser(); // tab S, not reloaded yet: "Delete everything in this browser"
  const left = [...shared.keys()].filter((k) => k !== "nutriflow.epoch");
  check("fence: 'Delete everything' from a tab that has not reloaded yet still deletes everything", left.length === 0, json(left));
}

// 10. With accounts switched OFF, another tab clearing the browser still reloads this one: its screens
//     hold data that is gone, and the fence would quietly refuse every save they make.
{
  shared.clear();
  const U = await load("U");
  const V = await load("V");
  const keep = { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  U.storage.savePlan(week("OFF"));
  mountAccountSync(U, "U");
  const before = reloads.U;
  await V.client.forgetThisBrowser();
  await settle();
  check("fence: with accounts switched off, a tab reloads when another tab clears the browser",
    reloads.U > before, `reloads ${reloads.U - before}`);
  env.NEXT_PUBLIC_SUPABASE_URL = keep.url;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = keep.key;
}

// 11. The account is deleted elsewhere while this tab's push is in flight, and meanwhile another tab
//     signs a DIFFERENT person in. The 23503 answer must not sign that person out.
{
  shared.clear();
  const X = await load("X");
  const Y = await load("Y");
  await signIn(X, "X", "xan@example.com");
  await X.client.startSync();
  mountAccountSync(X, "X");
  await deleteFromPhone("xan@example.com");
  deafen("X");
  sb.pushDelayMs = 80;
  X.storage.savePlan(week("XAN-AFTER"));
  tabs.X.document.visibilityState = "hidden";
  tabs.X.document.dispatch("visibilitychange"); // X's push goes out, and is slow
  await settle(10);
  await signIn(Y, "Y", "yul@example.com"); // Yul signs in, in tab Y, while X's push is on its way
  await settle(150);
  sb.pushDelayMs = 0;
  tabs.X.document.visibilityState = "visible";
  const stored = Y.storage.loadSessionRaw() as { userId?: string } | null;
  check("deleted elsewhere: the 23503 in one tab does not sign out the account another tab just signed in",
    stored?.userId === "uid-yul", json(stored?.userId ?? null));
  await hear("X");
  await Y.client.signOut();
}

// 12. After "this account was deleted", a later edit must not restart anything, or change what is said.
{
  shared.clear();
  const Z = await load("Z");
  await signIn(Z, "Z", "zed@example.com");
  await Z.client.startSync();
  await deleteFromPhone("zed@example.com");
  Z.storage.savePlan(week("ZED-AFTER"));
  await hide("Z"); // the mirror pushes: 23503, "this account was deleted"
  const first = Z.client.accountStatus();
  Z.storage.savePlan(week("ZED-AFTER-2")); // the person carries on editing
  await hide("Z");
  const later = Z.client.accountStatus();
  check("deleted elsewhere: a later edit leaves 'this account was deleted' in place (the sync stopped)",
    first.state === "signed-out" && later.state === "signed-out" && (later.message ?? "").includes("was deleted"), json(later));
  tabs.Z.document.visibilityState = "visible";
}

// 13. Signing out on a device whose account was deleted elsewhere. GoTrue answers that token's /logout
//     with 403 user_not_found (it loads the user first), which means the sign-in is already over: not
//     "the server couldn't be reached".
{
  shared.clear();
  const W = await load("W");
  await signIn(W, "W", "wes@example.com");
  await W.client.startSync();
  await deleteFromPhone("wes@example.com");
  await W.client.signOut();
  check("deleted elsewhere: signing out does not claim the server couldn't be reached",
    W.client.accountStatus().state === "signed-out" && !(W.client.accountStatus().message ?? "").includes("couldn't be reached"),
    json(W.client.accountStatus()));
}

// 14. Signing out with an edit not yet sent, on a device whose account was deleted elsewhere: the send
//     finds the account gone. That is what to say, not "your changes go up next time you sign in".
{
  shared.clear();
  const J = await load("J");
  await signIn(J, "J", "jo@example.com");
  await J.client.startSync();
  await deleteFromPhone("jo@example.com");
  J.storage.savePlan(week("JO-AFTER")); // an edit, still waiting out the debounce
  await J.client.signOut();
  const said = J.client.accountStatus().message ?? "";
  check("deleted elsewhere: signing out with an unsent edit says the account was deleted, not 'next time'",
    said.includes("was deleted") && !said.includes("next time"), said);
}

// 15. "Delete everything in this browser" waits for /logout; meanwhile another tab signs someone else
//     in. Clearing after that wait wiped THEIR sign-in and the week that had just come down for them.
{
  shared.clear();
  const I = await load("I");
  const O = await load("O");
  I.storage.saveProfile({ ...PROFILE, name: "Ida" });
  I.storage.savePlan(week("IDA"));
  await signIn(I, "I", "ida@example.com");
  await I.client.startSync();
  await settle();
  sb.user("oz@example.com");
  sb.table("uid-oz").set("plan", { value: week("OZ"), updated_at: new Date(Date.now() - 60_000).toISOString() });
  const release = holdRequests("/auth/v1/logout");
  const cleared = I.client.forgetThisBrowser().then(() => "cleared", (e: Error) => `refused: ${e.message}`);
  await settle();
  await signIn(O, "O", "oz@example.com"); // Oz signs in, in tab O, while tab I waits
  await O.client.startSync();
  await settle();
  release();
  const outcome = await cleared;
  await settle();
  check("delete everything: a sign-in made in another tab during the wait is not wiped",
    O.client.currentSession()?.userId === "uid-oz" && summary(O.storage.loadPlan()) === "week OZ",
    json({ session: O.client.currentSession()?.userId ?? null, plan: summary(O.storage.loadPlan()) }));
  check("delete everything: …and the tab that waited says nothing was deleted", outcome.includes("nothing was deleted"), outcome);
  await O.client.signOut();
}

// 16. Signing out sends what is waiting first; meanwhile another tab signs someone else in. Sign-out used
//     to fall back to whatever session was stored by then, and so ended THEIR sign-in.
{
  shared.clear();
  const Ca = await load("Ca");
  const Da = await load("Da");
  Ca.storage.saveProfile({ ...PROFILE, name: "Cyan" });
  await signIn(Ca, "Ca", "cyan@example.com");
  await Ca.client.startSync();
  await settle();
  sb.user("dell@example.com");
  Ca.storage.savePlan(week("CYAN-EDIT")); // an edit still waiting in the mirror
  sb.pushDelayMs = 300; // the send that sign-out does first takes a moment
  const out = Ca.client.signOut();
  await settle(20);
  await signIn(Da, "Da", "dell@example.com"); // Dell signs in, in tab Da, meanwhile
  sb.pushDelayMs = 0;
  await Da.client.startSync();
  const dell = Da.client.currentSession();
  await out;
  await settle();
  check("sign-out: a sign-in made in another tab while the last edit was sent is left alone",
    Da.client.currentSession()?.userId === "uid-dell" && !!dell && sb.refresh.has(dell.refreshToken),
    json({ session: Da.client.currentSession()?.userId ?? null, refreshAlive: dell ? sb.refresh.has(dell.refreshToken) : null }));
  check("sign-out: …and the tab that signed out says another tab signed someone in",
    (Ca.client.accountStatus().message ?? "").includes("another tab"), json(Ca.client.accountStatus()));
  await Da.client.signOut();
}
// 16b. The same, while /logout is answering: the local sign-in is forgotten only if it is still this one's.
{
  shared.clear();
  const Cb = await load("Cb");
  const Db = await load("Db");
  await signIn(Cb, "Cb", "cyd@example.com");
  await Cb.client.startSync();
  sb.user("dex@example.com");
  const release = holdRequests("/auth/v1/logout");
  const out = Cb.client.signOut(); // nothing waiting: straight to /logout, which is slow
  await settle();
  await signIn(Db, "Db", "dex@example.com");
  await Db.client.startSync();
  release();
  await out;
  await settle();
  check("sign-out: a sign-in made in another tab while /logout answered is not forgotten here",
    Db.client.currentSession()?.userId === "uid-dex", json(Db.client.currentSession()?.userId ?? null));
  await Db.client.signOut();
}
// 16c. The same, while the renewal that /logout needs is answered: a renewal refused for a different
//      account must never send THAT account's token to /logout.
{
  shared.clear();
  const Cc = await load("Cc");
  const Dc = await load("Dc");
  await signIn(Cc, "Cc", "cole@example.com");
  await Cc.client.startSync();
  sb.user("dana@example.com");
  advance(3_700_000); // Cole's access token has expired: signing out renews it first, for /logout
  sb.refreshAnswerDelayMs = 150;
  const out = Cc.client.signOut();
  await settle(20);
  await signIn(Dc, "Dc", "dana@example.com"); // Dana signs in while that renewal is answered
  await Dc.client.startSync();
  const dana = Dc.client.currentSession();
  await out;
  await settle(200);
  check("sign-out: a renewal answered after another account signed in never ends THAT account's sign-in",
    Dc.client.currentSession()?.userId === "uid-dana" && !!dana && sb.refresh.has(dana.refreshToken),
    json({ session: Dc.client.currentSession()?.userId ?? null, refreshAlive: dana ? sb.refresh.has(dana.refreshToken) : null }));
  await Dc.client.signOut();
}

// 17. What a reload carries is what the sync DID, once. The whole status line used to be carried, so a
//     held-back store's sentence, which the next sync says again by itself, appeared twice.
{
  shared.clear();
  const Ka1 = await load("Ka1");
  Ka1.storage.saveChat([{ role: "user", text: "y".repeat(900_001) }] as never); // too large to sync
  Ka1.storage.savePlan(week("KAI-LOCAL")); // never synced: the account's newer week replaces it
  sb.user("kai@example.com");
  sb.table("uid-kai").set("plan", { value: week("KAI-ACCOUNT"), updated_at: new Date(Date.now() + 60_000).toISOString() });
  await signIn(Ka1, "Ka", "kai@example.com");
  await Ka1.client.startSync();
  const said = Ka1.client.accountStatus().message ?? "";
  Ka1.client.carryNoteAcrossReload(); // what <AccountSync/> does just before reloading for the pull
  const Ka2 = await load("Ka2"); // the same tab, reloaded
  await Ka2.client.startSync();
  const after = Ka2.client.accountStatus().message ?? "";
  const times = (s: string, part: string) => s.split(part).length - 1;
  check("carried note: 'newer data' survives the reload, and the held store is still named, each said ONCE",
    times(said, "newer data") === 1 && times(after, "newer data") === 1 && times(after, "too large to keep in your account") === 1,
    json({ said, after }));
  await Ka2.client.signOut();
}

// 18. A note carried for one account is never shown to another: here the reloaded page's first sync
//     fails, another tab signs someone else in, and this tab reloads for that.
{
  shared.clear();
  const Ya1 = await load("Ya1");
  Ya1.storage.savePlan(week("YAN-LOCAL"));
  sb.user("yan@example.com");
  sb.table("uid-yan").set("plan", { value: week("YAN-ACCOUNT"), updated_at: new Date(Date.now() + 60_000).toISOString() });
  await signIn(Ya1, "Ya", "yan@example.com");
  await Ya1.client.startSync(); // "your account had newer data"
  Ya1.client.carryNoteAcrossReload();
  const Ya2 = await load("Ya2"); // the reload; its first sync does not get through
  sb.down = true;
  await Ya2.client.startSync();
  sb.down = false;
  const Yb = await load("Yb");
  await signIn(Yb, "Yb", "yara@example.com"); // another tab signs someone else in
  await Yb.client.startSync();
  const Ya3 = await load("Ya3"); // tab Ya reloads for the change of hands: its first sync is Yara's
  await Ya3.client.startSync();
  check("carried note: a sentence about one account is never shown to the next one in that tab",
    Ya3.client.currentSession()?.userId === "uid-yara" && !(Ya3.client.accountStatus().message ?? "").includes("newer data"),
    json(Ya3.client.accountStatus()));
  await Yb.client.signOut();
}

// 19. When one tab finds the account deleted, the browser's other tabs do not claim the person signed
//     out: they cannot tell why the sign-in ended, so they say only what is true.
{
  shared.clear();
  const Ga = await load("Ga");
  const Gb = await load("Gb");
  Ga.storage.savePlan(week("GIL"));
  await signIn(Ga, "Ga", "gil@example.com");
  await Ga.client.startSync();
  await Gb.client.startSync(); // tab Gb mirrors the same account
  await settle();
  await deleteFromPhone("gil@example.com");
  Ga.storage.savePlan(week("GIL-AFTER"));
  await hide("Ga"); // tab Ga's push meets the deleted account
  await settle();
  check("deleted elsewhere: the tab that found out says so", (Ga.client.accountStatus().message ?? "").includes("was deleted"),
    json(Ga.client.accountStatus()));
  check("deleted elsewhere: …and another tab of the browser does not claim the person signed out",
    Gb.client.accountStatus().state === "signed-out" && !(Gb.client.accountStatus().message ?? "").startsWith("You signed out"),
    json(Gb.client.accountStatus()));
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
