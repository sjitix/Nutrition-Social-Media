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
  STORE_NAMES, clearAll, loadPendingSignIn, loadSessionRaw, loadStoreMeta, loadSyncedAt, loadSyncOwner, markSynced,
  onSignInChangedElsewhere, onStoreChange, readStore, resetStoresSilently, savePendingSignIn, saveSessionRaw,
  saveSyncOwner, takeBackup, writeStore, type StoreName,
} from "../storage";
import { createMirror, syncNow, type HeldReason, type LocalAccess, type Mirror, type SyncReport } from "./sync";
import {
  AccountError, createPkcePair, deleteAccountRemote, exchangeCode, freshSession, hasAuthParams, readAccountConfig,
  readRedirect, requestMagicLink, signOutRemote, supabaseRemote, type AccountConfig, type Session,
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
async function liveSession(cfg: AccountConfig, forUser?: string): Promise<Session> {
  const s = currentSession();
  if (!s) throw new AccountError("You're signed out.", "auth");
  if (forUser && s.userId !== forUser) {
    throw new AccountError("This browser signed in to a different account in another tab, so this tab stopped syncing. Reload it to carry on.", "superseded");
  }
  const next = await freshSession(cfg, s);
  if (next !== s) saveSessionRaw(next);
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

/**
 * Email a sign-in link. A fresh PKCE verifier is kept in THIS browser first, so the link can only
 * complete here (see `supabase.ts` — that is what makes a link made by someone else worthless).
 */
export async function sendSignInLink(email: string): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  const { verifier, challenge } = await createPkcePair();
  savePendingSignIn({ verifier, email: email.trim(), at: Date.now() });
  await requestMagicLink(cfg, email, `${window.location.origin}${window.location.pathname}`, challenge);
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
  if (result.kind === "error") {
    savePendingSignIn(null);
    throw new AccountError(result.message, "auth");
  }
  const pending = loadPendingSignIn();
  if (!pending || Date.now() - pending.at > PENDING_SIGN_IN_TTL_MS) {
    savePendingSignIn(null);
    throw new AccountError(
      "That sign-in link was opened in a different browser from the one that asked for it. Ask for a new link here, and open it in this browser.",
      "auth",
    );
  }
  let s: Session;
  try {
    s = await exchangeCode(cfg, result.code, pending.verifier);
  } finally {
    savePendingSignIn(null); // one link, one use — the code is gone from the address bar either way
  }
  saveSessionRaw(s);
  return s;
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
      setStatus({ state: "error", email, message: e instanceof Error ? e.message : "Couldn't keep a safety copy, so nothing was synced." });
      return Promise.resolve(null);
    }
    resetStoresSilently();
    // Recorded NOW, not after the first sync succeeds: from this moment the (now empty) local data is
    // this account's. If it waited, a failed first sync followed by a reload would run this guard a
    // second time and back up the empty stores over the copy that holds the previous account's data.
    saveSyncOwner(userId);
    switchedFrom = true;
  }

  const gen = ++generation;
  const isCurrent = () => gen === generation;
  // Pinned: every request asks for THIS account's session, never whichever one another tab stored.
  const remote = supabaseRemote(cfg, () => liveSession(cfg, userId));
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
        if (held.size) setStatus({ state: "error", email, lastSyncedAt: status.lastSyncedAt, message: heldMessage(held) });
        return;
      }
      const map = { pending: "pending", saving: "syncing", saved: "saved", offline: "offline" } as const;
      setStatus({
        state: map[s],
        email,
        lastSyncedAt: s === "saved" ? Date.now() : status.lastSyncedAt,
        message: s === "offline" ? "Couldn't reach your account. Your changes are kept here and will be sent when you're back online." : undefined,
      });
    },
    onError: (e) => {
      if (isCurrent()) handleFailure(e, email);
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
    setStatus({ state: "syncing", email });
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
        lastSyncedAt: Date.now(),
        message: notes.join(" ") || undefined,
      });
      announcePulled(report);
      if (report.skipped.length) void Promise.resolve().then(() => resync()); // the account moved on mid-sync
      return report;
    } catch (e) {
      if (isCurrent()) handleFailure(e, email);
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
function handleFailure(e: unknown, email: string): void {
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
    message: e instanceof Error ? e.message : "Couldn't sync just now.",
  });
}

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
  const unsent = await stopSync();
  let ended = true;
  if (cfg && currentSession()) {
    // /logout refuses an expired access token, which would leave the server session alive while the
    // page said "signed out". Renew it first; if that fails too, use what there is.
    const s = await liveSession(cfg).catch(() => currentSession());
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
  stopRunning();
  if (cfg && s) {
    const live = await liveSession(cfg).catch(() => s);
    await signOutRemote(cfg, live);
  }
  clearAll();
  setStatus({ state: cfg ? "signed-out" : "off" });
}

/**
 * Delete the account and everything stored in it. This device's copy is left for the person to
 * decide about, and it becomes theirs again rather than the deleted account's: the owner is cleared,
 * so if they sign up again later, this data comes with them like any pre-account data.
 */
export async function deleteAccount(): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  const s = await liveSession(cfg);
  stopRunning(); // do NOT send: pending edits must not recreate rows we are about to delete
  try {
    await deleteAccountRemote(cfg, s);
  } catch (e) {
    // Nothing was deleted, so the account is still live: resume mirroring it before reporting.
    void startSync();
    throw e;
  }
  saveSessionRaw(null);
  saveSyncOwner(null);
  setStatus({
    state: "signed-out",
    message: "Your account and everything stored in it are deleted. (The sign-in service keeps its own record of past sign-ins for a limited time.) This browser still has its copy.",
  });
}
