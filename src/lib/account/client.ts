/**
 * The browser side of accounts: the session, the one running sync, and its status.
 *
 * Everything below is a thin wire between pieces that are tested on their own — `storage.ts` (the
 * local copy), `sync.ts` (the rules and the mirror) and `supabase.ts` (the REST calls) — and the wire
 * itself is tested end to end against an in-memory fake Supabase in `scripts/test-account.mts`. If
 * accounts are not configured for this build, every entry point here is a no-op and reports `off`.
 *
 * ONE sync per tab, held in this module. The account page and the always-mounted `<AccountSync/>`
 * both call `startSync`; the second call joins the first rather than starting a second mirror, which
 * would push every edit twice and race itself. Each caller registers its own `onPulled` listener.
 */
import {
  STORE_NAMES, claimSyncReload, clearAll, clearPendingSignIn, loadPendingSignIn, loadSessionRaw, loadSignInCode,
  loadStoreMeta, loadSyncedAt, loadSyncOwner, markSynced, onSignInChangedElsewhere, onStoreChange,
  onStoresChangedElsewhere, readStore, resetStoresSilently, savePendingSignIn, saveSessionRaw, saveSignInCode,
  saveSyncOwner, takeBackup, writeStore, type StoreName,
} from "../storage";
import { createMirror, syncNow, type HeldReason, type LocalAccess, type Mirror, type SyncReport } from "./sync";
import {
  AccountError, challengeFor, createPkcePair, deleteAccountRemote, exchangeCode, freshSession, hasAuthParams,
  looksLikeEmail, readAccountConfig, readRedirect, refreshSession, requestMagicLink, signOutRemote, supabaseRemote,
  type AccountConfig, type Session,
} from "./supabase";
import { checkStore } from "./validate";

export type AccountState =
  /** Accounts are not switched on for this build (no Supabase URL/key). */
  | "off"
  | "signed-out"
  | "syncing"
  | "saved"
  /** Edits made, not yet sent (the debounce window). */
  | "pending"
  /** The last send failed for a transient reason; edits are queued and go out when it can. */
  | "offline"
  /** The account refused something; waiting will not fix it. The message says what. */
  | "error";

export interface AccountStatus {
  state: AccountState;
  email?: string;
  /**
   * The account THIS TAB is showing. Destructive actions act on this account only, never on whatever
   * session another tab may have stored since (see `shownUser`).
   */
  userId?: string;
  /** A sentence for the person, when there is something to say. */
  message?: string;
  lastSyncedAt?: number;
}

/* ---- status: a tiny pub-sub so any component can show it ---- */

let status: AccountStatus = { state: "off" };
const watchers = new Set<(s: AccountStatus) => void>();
function setStatus(next: AccountStatus): void {
  status = next;
  for (const w of watchers) w(status);
}
export function accountStatus(): AccountStatus {
  return status;
}
export function onAccountStatus(fn: (s: AccountStatus) => void): () => void {
  watchers.add(fn);
  fn(status);
  return () => {
    watchers.delete(fn);
  };
}

/* ---- pulled-data listeners: every mounted screen that needs to re-read hears about a pull ---- */

const pulledListeners = new Set<(r: SyncReport) => void>();
/** Be told whenever data comes DOWN from the account (first sync, or a re-sync on focus). */
export function onPulled(fn: (r: SyncReport) => void): () => void {
  pulledListeners.add(fn);
  return () => {
    pulledListeners.delete(fn);
  };
}
function announcePulled(r: SyncReport): void {
  if (r.pulled.length || r.merged.length) for (const fn of pulledListeners) fn(r);
}

/* ---- configuration and session ---- */

export function accountConfig(): AccountConfig | null {
  return readAccountConfig();
}

function isSession(v: unknown): v is Session {
  const s = v as Session;
  return !!s && typeof s.accessToken === "string" && typeof s.refreshToken === "string" && typeof s.userId === "string";
}

export function currentSession(): Session | null {
  const raw = loadSessionRaw();
  return isSession(raw) ? raw : null;
}

/**
 * The session, refreshed when close to expiry and persisted. Throws when the sign-in is dead.
 *
 * `forUser` PINS it: a sync started for one account asks for that account's session on every request,
 * and if this browser is now signed in as SOMEONE ELSE (another tab signed in) it gets a `superseded`
 * error instead of the new account's token. Without the pin, a mirror running in one tab would follow
 * whatever session another tab stored, and push this tab's edits into the other person's account.
 */
async function liveSession(cfg: AccountConfig, forUser?: string, opts: { renew?: boolean } = {}): Promise<Session> {
  const s = currentSession();
  if (!s) throw new AccountError("You're signed out.", "auth");
  if (forUser && s.userId !== forUser) {
    throw new AccountError("This browser signed in to a different account in another tab, so this tab stopped syncing. Reload it to carry on.", "superseded");
  }
  // `renew`: the server refused this access token although this device judged it fresh (supabase.ts
  // `authorized`). Renew it whatever the expiry says. Only a refused renewal means signed out.
  const next = opts.renew ? await refreshSession(cfg, s.refreshToken) : await freshSession(cfg, s);
  // Saved only if the stored session is still the one renewed: a renewal landing after a sign-out or
  // "Delete everything in this browser" must not bring the session back.
  if (next !== s && currentSession()?.refreshToken === s.refreshToken) saveSessionRaw(next);
  return next;
}

/** This browser's storage, as the sync engine sees it. */
const localAccess: LocalAccess = {
  names: STORE_NAMES,
  read: (n) => readStore(n),
  meta: () => loadStoreMeta(),
  syncedAt: () => loadSyncedAt(),
  markSynced: (n, at) => markSynced(n, at),
  writeSilently: (n, v, at) => writeStore(n, v, { at, silent: true }),
  backup: (reason) => {
    takeBackup(reason);
  },
  backupValues: (reason, data) => {
    takeBackup(reason, { data });
  },
  // Rows from the account are outside data: held to the same checks as an imported file.
  accepts: (n, v) => checkStore(n, v) === null,
};

const LABEL: Record<StoreName, string> = {
  profile: "your profile", plan: "your week", batchPlan: "your meal-prep week", chat: "your chat history",
  imports: "your imported recipes", saved: "your saved recipes", groceriesChecked: "your ticked groceries",
  visits: "your visit history",
};

/* ---- sign in / out ---- */

/** A link older than this is not worth completing: Supabase's own links expire long before it. */
const PENDING_SIGN_IN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a repeat request for the same address reuses the pending verifier. Links last an hour. */
const REUSE_VERIFIER_MS = 60 * 60 * 1000;

/**
 * Email a sign-in link. The PKCE verifier is kept in THIS browser first, so the link can only complete
 * here (see `supabase.ts` — that is what makes a link made by someone else worthless).
 *
 * The address is checked BEFORE anything is stored, and a repeat request for the same address reuses
 * the verifier, so every link issued to this person completes here, whichever arrives first. Before,
 * each request replaced the verifier, even a request with a typo or one the server then refused for
 * being too soon. The valid link already in the inbox then failed as "opened in a different browser",
 * though it was opened in this one (review 2).
 */
export async function sendSignInLink(email: string): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  const address = email.trim();
  if (!looksLikeEmail(address)) throw new AccountError("That doesn't look like an email address.");
  const pending = loadPendingSignIn();
  const reuse = !!pending && pending.email === address && Date.now() - pending.at < REUSE_VERIFIER_MS;
  const verifier = reuse && pending ? pending.verifier : (await createPkcePair()).verifier;
  if (!reuse) savePendingSignIn({ verifier, email: address, at: Date.now() });
  await requestMagicLink(cfg, address, `${window.location.origin}${window.location.pathname}`, await challengeFor(verifier));
}

/**
 * If this page was opened from a sign-in link, finish signing in. Returns the session, or null when
 * the page was opened normally (or accounts are off). Throws a readable error for a link that failed.
 *
 * Three guarantees, each from the security review:
 *  - **Only a link THIS browser asked for completes.** The `?code=` is exchanged with the verifier
 *    kept when the link was requested; with no verifier here, nothing happens.
 *  - **Tokens pasted into the address are ignored.** A `#access_token=` fragment is never a sign-in.
 *  - **The address bar is cleared first**, success or failure, so neither a code nor any error text
 *    lingers in history or a copied URL — and the text shown is always one of OUR sentences, never
 *    words taken from the URL.
 */
export async function completeSignInFromUrl(): Promise<Session | null> {
  if (typeof window === "undefined") return null;
  const cfg = accountConfig();
  if (!cfg) return null; // accounts off: a sign-in URL means nothing here, and nothing is touched
  const { search, hash } = window.location;
  if (!hasAuthParams(search, hash)) return null;
  history.replaceState(null, "", window.location.pathname);

  const result = readRedirect(search, hash);
  if (result.kind === "none") return null;
  // A failed link keeps the verifier: another link issued to the same request may still work.
  if (result.kind === "error") throw new AccountError(result.message, "auth");
  const pending = loadPendingSignIn();
  if (!pending || Date.now() - pending.at > PENDING_SIGN_IN_TTL_MS) {
    savePendingSignIn(null);
    throw new AccountError(
      "That sign-in link was opened in a different browser from the one that asked for it. Ask for a new link here, and open it in this browser.",
      "auth",
    );
  }
  return exchangeWith(cfg, result.code, pending.verifier);
}

/**
 * Exchange a link's code for a session, and decide what to keep.
 *  - Success: the verifier that was used is forgotten. Only that one, compared by value: a newer
 *    request made while this exchange was in flight keeps its own (review 2).
 *  - A TRANSIENT failure (offline, 429, 5xx): the code is still good for a few minutes, so it is kept,
 *    with its verifier, for "Try again" (`retrySignIn`). The emailed link was used up when it was
 *    opened, so telling the person to open it again (as this once did) could never work.
 *  - Any other failure: the code is dropped; the verifier stays for another link from the same
 *    request, until its time runs out.
 */
async function exchangeWith(cfg: AccountConfig, code: string, verifier: string): Promise<Session> {
  let s: Session;
  try {
    s = await exchangeCode(cfg, code, verifier);
  } catch (e) {
    saveSignInCode(e instanceof AccountError && e.retryable ? code : null);
    throw e;
  }
  saveSignInCode(null);
  clearPendingSignIn(verifier);
  saveSessionRaw(s);
  // This tab now shows this account, so sign-out and delete act on it (see `shownUser`). Its sync,
  // which the caller starts next, replaces this status with its own.
  setStatus({ state: "syncing", email: s.email, userId: s.userId });
  return s;
}

/** Whether this page was opened from a sign-in link, so the panel can say it is signing in. */
export function openedFromSignInLink(): boolean {
  return !!accountConfig() && typeof window !== "undefined" && hasAuthParams(window.location.search, window.location.hash);
}

/** Whether a sign-in can be finished with "Try again": its exchange failed for a transient reason. */
export function canRetrySignIn(): boolean {
  return !!accountConfig() && !!loadSignInCode() && !!loadPendingSignIn();
}

/** "Try again": finish the sign-in whose exchange failed for a transient reason. */
export async function retrySignIn(): Promise<Session | null> {
  const cfg = accountConfig();
  const code = loadSignInCode();
  const pending = loadPendingSignIn();
  if (!cfg || !code || !pending) return null;
  return exchangeWith(cfg, code, pending.verifier);
}

/* ---- the running sync ---- */

interface Running {
  userId: string;
  mirror: Mirror;
  /** The latest full sync; what a joining `startSync` caller waits on. */
  ready: Promise<SyncReport | null>;
  /** Run a full sync now (sending what is waiting first), unless one is already running. */
  resync(): Promise<SyncReport | null>;
  /** True once a full sync has succeeded in this tab. */
  everSynced(): boolean;
  stop(): void;
}
let running: Running | null = null;
/**
 * Bumped whenever a running sync is stopped. A full sync still in flight compares it after its pull
 * returns and applies nothing if it changed — so a pull landing after "delete everything in this
 * browser", a sign-out or an account switch cannot refill the browser.
 */
let generation = 0;

/**
 * Whose data this tab's screens were showing: the browser's owner when `watchOtherTabs` started, and
 * then whichever account this tab itself syncs. Null until known, and after this tab clears the browser.
 */
let tabOwner: string | null = null;

/** The stores the screens keep a copy of while mounted: the assistant, the one-step undo. */
const HELD_BY_SCREENS: ReadonlySet<StoreName> = new Set<StoreName>(["plan", "batchPlan", "profile"]);

/**
 * Watch what OTHER tabs of this browser do, for as long as this tab is open. `<AccountSync/>` calls
 * this once per tab: `reload` reloads the page, `refresh` tells mounted screens to re-read.
 *
 * Two things make a tab's screens unsafe to keep running as they are (review 2, found by two lenses):
 *  - THE BROWSER CHANGED HANDS. Another tab signed someone else in, so the switch guard set this
 *    data aside and brought theirs down, or another tab cleared the browser. This tab's screens
 *    still hold the previous person's week and profile, and their next save writes it into storage
 *    that now belongs to someone else, whose sync uploads it. So this tab reloads, always.
 *  - ANOTHER TAB CHANGED A STORE THIS TAB'S SCREENS HOLD, while signed in: its pull of another
 *    device's week, say. This tab's own sync then finds nothing to pull, so it is never told, and its
 *    next save writes the old week back as the newest edit, erasing the other device's change on
 *    every device. So this tab reloads too (at most once per 30 s; otherwise its screens are told).
 * A sign-out or a refreshed token in another tab changes neither, and disturbs nothing here. With
 * nobody signed in, another tab's edit stays on this device, as it always has.
 */
export function watchOtherTabs(on: { reload: () => void; refresh: () => void }): () => void {
  if (!accountConfig() || typeof window === "undefined") return () => {};
  const whose = () => loadSyncOwner() ?? currentSession()?.userId ?? null;
  tabOwner = tabOwner ?? whose();
  const offSignIn = onSignInChangedElsewhere(() => {
    if (tabOwner !== null && whose() !== tabOwner) on.reload();
  });
  const offStores = onStoresChangedElsewhere((names) => {
    if (!currentSession()) return;
    if (names.some((n) => HELD_BY_SCREENS.has(n)) && claimSyncReload()) on.reload();
    else on.refresh();
  });
  return () => {
    offSignIn();
    offStores();
  };
}

/** Stop the running sync WITHOUT sending what is waiting, and invalidate any sync in flight. */
function stopRunning(): void {
  generation++;
  if (running) {
    running.stop();
    running = null;
  }
}

/** How long a tab must have been away before coming back triggers a fresh pull. */
const RESYNC_AFTER_MS = 30_000;

/**
 * Sync now, then mirror every local edit. Safe to call any number of times: joins the running sync,
 * and retries it at once if it has never succeeded (it was offline when the page loaded).
 *
 * THE ACCOUNT-SWITCH GUARD. A browser remembers which account its data last synced with (the owner).
 *  - Never synced: the data is the person's own, from before they had an account. It comes with
 *    them — the first sync uploads it (and backs up anything the account replaces).
 *  - Same account: an ordinary sync.
 *  - A DIFFERENT account: this data belongs to whoever used the browser before. It must not be pushed
 *    into the new account. It is backed up (so nothing is lost — the account page offers it back), the
 *    stores are emptied, and the new account's own data comes down.
 *
 * NOTHING IS SENT BEFORE THE FIRST FULL SYNC SUCCEEDS. Edits are queued from the start, but the mirror
 * stays paused until this tab has seen the account's data: pushing a whole store built on a copy that
 * never pulled would overwrite newer edits from other devices without the comparison, union or backup
 * a full sync gives them. Edits made meanwhile are still in storage with fresh times, so the full sync
 * itself sends them.
 */
export function startSync(): Promise<SyncReport | null> {
  const cfg = accountConfig();
  if (!cfg) {
    setStatus({ state: "off" });
    return Promise.resolve(null);
  }
  const session = currentSession();
  if (!session) {
    if (status.state !== "signed-out" || !status.message) setStatus({ state: "signed-out" });
    return Promise.resolve(null);
  }
  if (running && running.userId === session.userId) {
    return running.everSynced() ? running.ready : running.resync();
  }
  // A different account's sync is still running in this tab (a sign-in without a sign-out). Stop it
  // without sending: its pending edits belong to the account that is leaving.
  stopRunning();

  const userId = session.userId;
  const email = session.email;
  const owner = loadSyncOwner();
  let switchedFrom = false;
  if (owner && owner !== userId) {
    try {
      takeBackup(`from a different account, before ${email || "this account"} signed in`);
    } catch (e) {
      // No room for a safety copy: do NOT empty anything. Stay signed in but don't sync, and say why.
      setStatus({ state: "error", email, userId, message: e instanceof Error ? e.message : "Couldn't keep a safety copy, so nothing was synced." });
      return Promise.resolve(null);
    }
    resetStoresSilently();
    // Recorded NOW, not after the first sync succeeds: from this moment the (now empty) local data is
    // this account's. If it waited, a failed first sync followed by a reload would run this guard a
    // second time and back up the empty stores over the copy that holds the previous account's data.
    saveSyncOwner(userId);
    switchedFrom = true;
  } else if (!owner) {
    // Never synced: the data here is this person's own, and it is this account's from NOW, not from
    // the first sync that succeeds. Waiting let a failed first sync leave the browser unowned, so the
    // next person to sign in skipped the guard above and got this person's unsynced data (profile
    // and health notes included) uploaded into THEIR account (review 2, found twice).
    saveSyncOwner(userId);
  }

  // From here this tab's screens show this account's data (see `watchOtherTabs`).
  tabOwner = userId;

  const gen = ++generation;
  const isCurrent = () => gen === generation;
  // Pinned: every request asks for THIS account's session, never whichever one another tab stored.
  const remote = supabaseRemote(cfg, (o) => liveSession(cfg, userId, o));
  // What is being kept on this device only, and why — mirrored from the mirror so the status line can
  // keep naming it until it actually syncs, rather than a later "saved" quietly erasing the warning.
  let held: ReadonlyMap<StoreName, HeldReason> = new Map();
  let everSynced = false;
  let lastPull = 0;
  let inFlight: Promise<SyncReport | null> | null = null;

  const mirror = createMirror(remote, {
    startPaused: true,
    onStatus: (s) => {
      if (s === "idle" || !isCurrent()) return;
      if (s === "error") {
        // A refused or oversized store is held back; transient failures arrive via onError instead.
        if (held.size) setStatus({ state: "error", email, userId, lastSyncedAt: status.lastSyncedAt, message: heldMessage(held) });
        return;
      }
      const map = { pending: "pending", saving: "syncing", saved: "saved", offline: "offline" } as const;
      setStatus({
        state: map[s],
        email,
        userId,
        lastSyncedAt: s === "saved" ? Date.now() : status.lastSyncedAt,
        message: s === "offline" ? "Couldn't reach your account. Your changes are kept here and will be sent when you're back online." : undefined,
      });
    },
    onError: (e) => {
      if (isCurrent()) handleFailure(e, email, userId);
    },
    onHeld: (h) => {
      held = h;
    },
    onSaved: (rows) => {
      for (const r of rows) markSynced(r.name, r.at);
    },
    // The account already had a newer write for these stores: pull before sending them again.
    onStale: () => void resync(),
  });

  // Every local edit from here on is queued. Subscribed BEFORE the first sync, so an edit made while it
  // runs is not missed.
  const unsubscribe = onStoreChange((c) => mirror.enqueue(c.name, c.value, c.at));

  function resync(): Promise<SyncReport | null> {
    if (inFlight) return inFlight;
    // Send what is waiting FIRST, so a pull cannot overwrite an edit that simply hadn't gone up yet.
    inFlight = mirror
      .flush()
      .then(() => runSync())
      .finally(() => {
        inFlight = null;
      });
    if (running && running.userId === userId) running.ready = inFlight;
    return inFlight;
  }

  async function runSync(): Promise<SyncReport | null> {
    const first = !everSynced;
    setStatus({ state: "syncing", email, userId });
    try {
      const report = await syncNow(localAccess, remote, { stillCurrent: isCurrent });
      if (report.cancelled || !isCurrent()) return null;
      lastPull = Date.now();
      everSynced = true;
      saveSyncOwner(userId);
      // Edits the full sync just sent are already in the account; start sending everything newer.
      mirror.dropSynced(loadSyncedAt());
      mirror.resume();
      const notes: string[] = [];
      if (first && switchedFrom) {
        notes.push("This browser held data from a different account. It is set aside on the account page, not added to this one.");
      }
      if (report.backedUp) {
        notes.push("Your account had newer data, so it replaced some of what was on this device. The previous copy is kept on the account page.");
      }
      if (report.keptAccountCopy?.length) {
        notes.push(`This device's newer changes replaced ${list(report.keptAccountCopy)} in your account. The account's previous copy is kept on the account page.`);
      }
      if (report.invalid.length) {
        notes.push(`${capital(list(report.invalid))} in your account couldn't be read by this version of the app, so this device kept its own copy.`);
      }
      // The full sync's verdict on each store feeds the mirror's held-back set, so the warning
      // persists until that store genuinely gets through.
      for (const n of report.tooLarge) mirror.hold(n, "too-large");
      for (const n of report.refused) mirror.hold(n, "refused");
      for (const n of [...report.pushed, ...report.merged]) mirror.release(n);
      if (held.size) notes.push(heldMessage(held));
      setStatus({
        state: held.size ? "error" : "saved",
        email,
        userId,
        lastSyncedAt: Date.now(),
        message: notes.join(" ") || undefined,
      });
      announcePulled(report);
      if (report.skipped.length) void Promise.resolve().then(() => resync()); // the account moved on mid-sync
      return report;
    } catch (e) {
      if (isCurrent()) handleFailure(e, email, userId);
      return null;
    }
  }

  const onOnline = () => void resync(); // back online: other devices may have moved on meanwhile
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void mirror.flush();
    // Back on this tab after a while: another device may have changed things.
    else if (Date.now() - lastPull > RESYNC_AFTER_MS) void resync();
  };
  // Another tab signed in or out. If this browser now belongs to someone else, this tab's screens are
  // showing the previous account's data and must not keep writing it: stop, and reload so every screen
  // re-reads the new account's data. If the other tab only signed out, just stop.
  const offElsewhere = onSignInChangedElsewhere(() => {
    const now = currentSession();
    if (now && now.userId === userId) return; // same account, e.g. a token refreshed in another tab
    if (running && running.userId === userId) stopRunning();
    if (now) {
      setStatus({ state: "signed-out", message: "This browser signed in to a different account in another tab. Reloading to show it." });
      if (typeof window.location.reload === "function") window.location.reload();
    } else {
      setStatus({ state: "signed-out", message: "You signed out in another tab. Everything is still on this device." });
    }
  });
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);

  const handle: Running = {
    userId,
    mirror,
    ready: Promise.resolve(null),
    resync,
    everSynced: () => everSynced,
    stop: () => {
      unsubscribe();
      mirror.stop();
      window.removeEventListener("online", onOnline);
      offElsewhere();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
  running = handle;
  handle.ready = resync();
  return handle.ready;
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const list = (names: StoreName[]) => names.map((n) => LABEL[n]).join(" and ");

/** "Your chat history is too large to keep in your account…" — one sentence per reason. */
function heldMessage(held: ReadonlyMap<StoreName, HeldReason>): string {
  const sentence = (names: StoreName[], why: string) => {
    if (!names.length) return "";
    const plural = names.length > 1;
    return `${capital(list(names))} ${plural ? "are" : "is"} ${why}, so ${plural ? "they stay" : "it stays"} on this device only.`;
  };
  const by = (r: HeldReason) => [...held].filter(([, why]) => why === r).map(([n]) => n);
  return [
    sentence(by("too-large"), "too large to keep in your account"),
    sentence(by("refused"), "something your account couldn't store"),
    "Everything else is synced.",
  ].filter(Boolean).join(" ");
}

/**
 * Turn a failure into the right state. A dead sign-in is not "offline": the sync stops, the session
 * is dropped (this device keeps every bit of its data), and the person is told to sign in again.
 */
function handleFailure(e: unknown, email: string, userId: string): void {
  if (e instanceof AccountError && e.kind === "superseded") {
    // Someone else's session is now the browser's. Stop this tab's sync and leave theirs alone.
    stopRunning();
    setStatus({ state: "signed-out", message: e.message });
    return;
  }
  if (e instanceof AccountError && e.kind === "auth") {
    stopRunning();
    saveSessionRaw(null);
    setStatus({
      state: "signed-out",
      message: "Your sign-in expired, so syncing has stopped. Everything is still on this device — sign in again to carry on.",
    });
    return;
  }
  // Network and server trouble arrive as retryable AccountErrors. Anything else — a refusal, or a
  // local problem such as no room for a safety copy — will not fix itself by waiting.
  const permanent = !(e instanceof AccountError) || !e.retryable;
  setStatus({
    state: permanent ? "error" : "offline",
    email,
    userId,
    message: e instanceof Error ? e.message : "Couldn't sync just now.",
  });
}

/**
 * The account this tab is showing, or null. Sign-out, "Delete my account" and "Delete everything in
 * this browser" act on THIS account and refuse when the browser now holds another one.
 *
 * Why (review 2): the session lives in storage every tab shares. When another tab signed this browser
 * in as Bob and this tab missed the event (a page restored from the back/forward cache, for one), this
 * tab still showed Ana, and "Delete my account" deleted BOB's account, for good, while telling Ana hers
 * was gone. The running sync was already pinned to its account; these actions were not.
 */
function shownUser(): string | null {
  return status.userId ?? running?.userId ?? null;
}

const ANOTHER_TAB = "This browser signed in to a different account in another tab";

/**
 * Send anything still waiting, then stop mirroring. Returns true when some edits could NOT be sent
 * (offline, or the first sync never completed), so the caller can say so instead of implying they
 * reached the account.
 */
async function stopSync(): Promise<boolean> {
  if (!running) return false;
  const r = running;
  if (r.everSynced()) await r.mirror.flush().catch(() => {});
  const unsent = r.mirror.queued() > 0 || r.mirror.status() === "offline" || !r.everSynced();
  stopRunning();
  return unsent;
}

/**
 * Sign out. This device KEEPS its data — local-first means the account is a mirror, and signing out
 * stops the mirror rather than emptying the working copy. Deleting local data is its own action.
 * The owner is kept too: signing back in as the same account is an ordinary sync (which sends any
 * edits that didn't make it), and signing in as someone else sets this data aside instead.
 */
export async function signOut(): Promise<void> {
  const cfg = accountConfig();
  const mine = shownUser();
  const stored = currentSession();
  if (stored && stored.userId !== mine) {
    // The browser is signed in as an account this tab isn't showing: another tab signed in, and this
    // one missed it. Signing out here would end THEIR sign-in. Stop this tab, and leave theirs alone.
    stopRunning();
    setStatus({ state: "signed-out", message: `${ANOTHER_TAB}, so this tab stopped and left that sign-in alone. Reload it to see which account it is.` });
    return;
  }
  const unsent = await stopSync();
  let ended = true;
  if (cfg && currentSession()) {
    // /logout refuses an expired access token, which would leave the server session alive while the
    // page said "signed out". Renew it first; if that fails too, use what there is.
    const s = await liveSession(cfg, mine ?? undefined).catch(() => currentSession());
    ended = s ? await signOutRemote(cfg, s) : false;
  }
  saveSessionRaw(null);
  const notes = [
    unsent ? "Your latest changes hadn't reached your account yet. They are kept on this device and go up the next time you sign in to this account here." : "",
    ended ? "" : "The account server couldn't be reached to end the sign-in there as well.",
  ].filter(Boolean);
  setStatus({ state: cfg ? "signed-out" : "off", message: notes.join(" ") || undefined });
}

/**
 * "Delete everything in this browser": stop syncing FIRST (and cancel a sync in flight, so a pull
 * landing a moment later can't refill the browser), end the sign-in, then clear. The account itself
 * is untouched — deleting it is its own action.
 */
export async function forgetThisBrowser(): Promise<void> {
  const cfg = accountConfig();
  const s = currentSession();
  if (s && s.userId !== shownUser()) {
    // This browser now holds an account this tab isn't showing (another tab signed in). Clearing it
    // from here would wipe THAT account's data on this browser and end its sign-in, unseen.
    throw new AccountError(`${ANOTHER_TAB}, so nothing was deleted. Reload this page to see it first.`, "superseded");
  }
  stopRunning();
  if (cfg && s) {
    const live = await liveSession(cfg).catch(() => s);
    await signOutRemote(cfg, live);
  }
  clearAll();
  tabOwner = null;
  setStatus({ state: cfg ? "signed-out" : "off" });
}

/**
 * Delete the account this tab is showing, and everything stored in it. This device's copy is left for
 * the person to decide about.
 *
 * The browser's data STAYS marked as the deleted account's. Clearing that mark (as this once did) made
 * the browser look as if it had never synced, so the next person to sign in here skipped the switch
 * guard and got the deleted account's data uploaded into theirs (review 2). Kept, whoever signs in
 * next, the same person with a new account included, gets it set aside as a copy they can put back.
 */
export async function deleteAccount(): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  const mine = shownUser();
  if (!mine) throw new AccountError("Reload this page, then try again: it isn't showing an account to delete.", "superseded");
  let s: Session;
  try {
    s = await liveSession(cfg, mine);
  } catch (e) {
    if (e instanceof AccountError && e.kind === "superseded") {
      stopRunning();
      const why = `${ANOTHER_TAB}, so nothing was deleted. Reload this page to see which account it is.`;
      setStatus({ state: "signed-out", message: why });
      throw new AccountError(why, "superseded");
    }
    throw e;
  }
  stopRunning(); // do NOT send: pending edits must not recreate rows we are about to delete
  try {
    await deleteAccountRemote(cfg, (o) => (o?.renew ? liveSession(cfg, mine, o) : Promise.resolve(s)));
  } catch (e) {
    // Nothing was deleted, so the account is still live: resume mirroring it before reporting.
    void startSync();
    throw e;
  }
  saveSessionRaw(null);
  setStatus({
    state: "signed-out",
    message: "Your account and everything stored in it are deleted. (The sign-in service keeps its own record of past sign-ins for a limited time.) This browser still has its copy. If anyone signs in here again, you with a new account included, it is set aside as a copy rather than added to that account.",
  });
}
