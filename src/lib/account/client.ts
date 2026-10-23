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
  STORE_NAMES, claimSyncReload, clearAll, clearPendingSignIn, dataGeneration, loadPendingSignIn, loadSessionRaw,
  loadSignInCode, loadStoreMeta, loadSyncedAt, loadSyncOwner, markSynced, onBrowserChangedHandsElsewhere,
  onSignInChangedElsewhere, onStoreChange, onStoresChangedElsewhere, readStore, resetStoresSilently, saveCarriedNote,
  savePendingSignIn, saveSessionRaw, saveSignInCode, saveSyncOwner, takeBackup, takeCarriedNote, writeStore,
  type KeptSignIn, type StoreName,
} from "../persistence";
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
  if (next === s) return s;
  // A renewal takes a round trip, and storage may have moved on meanwhile. Its result is kept only if
  // storage still holds the session it renewed (review 2, found by two lenses; the same race was
  // filed against Supabase's own Swift SDK).
  const stored = currentSession();
  // Signed out, or the browser cleared: a late answer must not bring the session back. PostgREST
  // would honour its token for an hour, and the next page load would pull the account down again.
  if (!stored) throw new AccountError("You're signed out.", "auth");
  // Another account signed in meanwhile: stop, never overwrite their session.
  if (stored.userId !== s.userId) {
    throw new AccountError("This browser signed in to a different account in another tab, so this tab stopped syncing. Reload it to carry on.", "superseded");
  }
  // Another request renewed it first: use that one. Saving this one would bring back a token the
  // server has since moved past.
  if (stored.refreshToken !== s.refreshToken) return stored;
  saveSessionRaw(next);
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

/**
 * A request older than this is treated as gone. It must outlast every link that can still work. GoTrue's
 * own default link life is a day (Mailer.OtpExp, 86400 s; a hosted project starts at an hour), and a
 * repeat request reuses the verifier for up to an hour without restamping it (REUSE_VERIFIER_MS), so
 * the newest link can be an hour younger than the request it finishes. At 24 h, such a link opened late
 * on its last day was refused with the no-request sentence, whose every cause was then false (the
 * review of the Site URL batch).
 */
const PENDING_SIGN_IN_TTL_MS = 25 * 60 * 60 * 1000;
/** How long a repeat request for the same address reuses the pending verifier. Links last an hour. */
const REUSE_VERIFIER_MS = 60 * 60 * 1000;
/**
 * Whether two addresses are one person to GoTrue, which lowercases an address before it looks anyone up
 * (mail.go validateEmail). Compared as typed, "Sam@" after "sam@" made a new verifier, and gave up a
 * sign-in kept for "Try again"; and if that request never reached GoTrue, the link already sent could no
 * longer be finished (the third and fourth reviews of the Try-again batch).
 */
function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Email a sign-in link. The PKCE verifier is kept in THIS browser first, so the link can only complete
 * here (see `supabase.ts` — that is what makes a link made by someone else worthless).
 *
 * The address is checked BEFORE anything is stored, and a repeat request for the same address, in any
 * letter case, reuses the verifier. Before, each request replaced the verifier, even one with a typo, one
 * that never reached the server, or one the server refused while rolling it back (a first link's sign-up
 * with "Confirm email" on, refused as too soon). The valid link already in the inbox then failed as
 * "opened in a different browser", though it was opened in this one (review 2). A refused request is
 * otherwise harmless here: GoTrue records it as the person's latest anyway, so the link is issued for it. A request the server ACCEPTS is different: GoTrue keeps one link per person, so it retires
 * the earlier link, and only the newest one works (the link-error sentence in supabase.ts says so).
 */
export async function sendSignInLink(email: string): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  const address = email.trim();
  if (!looksLikeEmail(address)) throw new AccountError("That doesn't look like an email address.");
  const pending = loadPendingSignIn();
  const reuse = !!pending && sameAddress(pending.email, address) && Date.now() - pending.at < REUSE_VERIFIER_MS;
  const verifier = reuse && pending ? pending.verifier : (await createPkcePair()).verifier;
  if (!reuse) savePendingSignIn({ verifier, email: address, at: Date.now() });
  // A request for another address gives up the sign-in this tab kept for "Try again", so "Finish the
  // earlier sign-in" never offers one the person has moved on from. Decided by the kept sign-in's own
  // address, not the pending request's, which another tab can have replaced (the fourth review).
  const kept = loadSignInCode();
  if (kept && !sameAddress(kept.email, address)) saveSignInCode(null);
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
  // Nothing held here has three causes, and this page cannot tell them apart:
  //  - another browser asked for the link;
  //  - another web address of the app asked. GoTrue sends a link whose return address the allow list
  //    refuses to the Site URL (supabase/README.md, step 3), a different origin with storage of its own,
  //    so a person asking on such an address lands here in the very browser they asked from;
  //  - this browser's data was cleared since, by "Delete everything in this browser" or a browser that
  //    clears site data on exit.
  // "Web" keeps it from reading as their email address.
  if (!pending || Date.now() - pending.at > PENDING_SIGN_IN_TTL_MS) {
    savePendingSignIn(null);
    // Signed in already, the page says so first. Two cases land here: a link asked for on another device
    // and opened in this one, and a newer link for a sign-in that "Try again" finished meanwhile, for which
    // every cause above would be false (the fourth and fifth reviews).
    const already = currentSession();
    if (already) {
      throw new AccountError(
        `That sign-in link can't be used here: this browser is already signed in${already.email ? ` as ${already.email}` : ""} and has no sign-in waiting for it. If you asked for it on another device or browser, ask again there and open it there. To sign in here as someone else, sign out first, then ask for a new link here.`,
        "auth",
      );
    }
    throw new AccountError(
      "That sign-in link can't be finished here: it was opened somewhere other than where it was asked for (in a different browser, or at a different web address), or this browser's data was cleared since. Ask for a new link here, and open it in this browser.",
      "auth",
    );
  }
  return exchangeWith(cfg, { code: result.code, verifier: pending.verifier, email: pending.email });
}

/**
 * Exchange a link's code for a session, and decide what to keep.
 *  - Success: the verifier that was used is forgotten. Only that one, compared by value: a newer
 *    request made while this exchange was in flight keeps its own (review 2).
 *  - A TRANSIENT failure (offline, 429, 5xx): the code is kept for "Try again" (`retrySignIn`), with the
 *    verifier this exchange used (the one pending when the link landed) and that request's address. Kept
 *    together, in this tab: the pending request is one per browser, and another tab's request can replace
 *    it. The code is usually still good, for five minutes after the link was
 *    opened (for a first link with "Confirm email" on, after it was asked for). The emailed link was used
 *    up when it was opened, so telling the person to open it again (as this once did) could never work.
 *  - Any other failure: the code is dropped; the verifier stays for another link from the same
 *    request, until its time runs out. That includes a 200 whose body was cut off: GoTrue had already
 *    used the code, so `exchangeCode` says so, and there is nothing to try again.
 * A transient failure can also be a lost RESPONSE, after GoTrue already used the code. Then "Try
 * again" is refused (404), and `retry` lets `exchangeCode` say so rather than blame the link; it does the
 * same for a retry pressed after the five minutes (422).
 */
async function exchangeWith(cfg: AccountConfig, attempt: KeptSignIn, retry = false): Promise<Session> {
  // The browser's generation when this attempt began. Cleared (or changed hands) while the exchange was in
  // flight, nothing of it may land in the new one, neither the session nor a code kept for "Try again":
  // "Delete everything" pressed while "Trying…" was signing in once let both through (the fifth review).
  const generation = dataGeneration();
  let s: Session;
  try {
    s = await exchangeCode(cfg, attempt.code, attempt.verifier, undefined, undefined, retry);
  } catch (e) {
    saveSignInCode(e instanceof AccountError && e.retryable && dataGeneration() === generation ? attempt : null);
    throw e;
  }
  if (dataGeneration() !== generation) {
    saveSignInCode(null);
    throw new AccountError(
      "This browser was cleared, or signed in to another account, while that sign-in was finishing, so it was not kept. Ask for a new link here to sign in.",
      "auth",
    );
  }
  saveSignInCode(null);
  clearPendingSignIn(attempt.verifier);
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

/**
 * The sign-in "Try again" would finish, if any: one this tab kept after a transient failure, from the
 * browser's current generation of data (storage.ts drops it once the browser is cleared or changes hands),
 * while nobody is signed in. Signed in since (in another tab, say), there is nothing left to finish, and a
 * retry could only sign someone in again over that sign-in (the fourth review of the Try-again batch).
 */
function keptToFinish(): KeptSignIn | null {
  if (!accountConfig()) return null;
  if (currentSession()) {
    // Dropped, not just hidden: after a sign-out it would come back (the fifth review).
    saveSignInCode(null);
    return null;
  }
  return loadSignInCode();
}

/** Whether a sign-in can be finished with "Try again": its exchange failed for a transient reason. */
export function canRetrySignIn(): boolean {
  return !!keptToFinish();
}

/**
 * "Try again": finish the sign-in whose exchange failed for a transient reason, with the verifier that
 * exchange used. Not the one pending now: another tab's request may have replaced it, and the code with
 * that one could only be refused (bad_code_verifier). A takeover can still refuse the kept one, since
 * GoTrue binds a link's code to the person's latest request when the link is opened, and the sentence
 * for that says so. With nothing to finish it throws, so a button pressed late never reads as a sign-in.
 */
export async function retrySignIn(): Promise<Session> {
  const cfg = accountConfig();
  const kept = keptToFinish();
  if (!cfg || !kept) {
    throw new AccountError(
      currentSession()
        ? "There's nothing to finish here: this browser is already signed in."
        : "That sign-in can't be finished from here any more. Ask for a new link here.",
      "auth",
    );
  }
  return exchangeWith(cfg, kept, true);
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

/** The stores the screens keep a copy of while mounted: the assistant, the one-step undo. */
const HELD_BY_SCREENS: ReadonlySet<StoreName> = new Set<StoreName>(["plan", "batchPlan", "profile"]);

/**
 * Watch what OTHER tabs of this browser do, for as long as this tab is open. `<AccountSync/>` calls
 * this once per tab: `reload` reloads the page, `refresh` tells mounted screens to re-read.
 *
 * Two things make a tab's screens unsafe to keep running as they are (review 2, found by three lenses):
 *  - THE BROWSER CHANGED HANDS. Another tab signed someone else in (the switch guard set this data
 *    aside and brought theirs down), or another tab cleared the browser. This tab's screens still
 *    hold the previous person's week and profile, and their next save would write them into storage
 *    that now belongs to someone else, whose sync would upload them. So this tab reloads, always. The
 *    signal is the browser's data generation (storage.ts, THE WRITE FENCE), which also refuses any
 *    save this tab makes before the reload. It is watched with accounts switched off too, where
 *    "Delete everything in this browser" in one tab was otherwise undone by another tab's next save.
 *  - ANOTHER TAB CHANGED A STORE THIS TAB'S SCREENS HOLD, while signed in: its pull of another
 *    device's week, say. This tab's own sync then finds nothing to pull, so it is never told, and its
 *    next save writes the old week back as the newest edit, erasing the other device's change on
 *    every device. So this tab reloads too (at most once per 30 s; otherwise its screens are told).
 * A sign-out or a refreshed token in another tab changes neither, and disturbs nothing here. With
 * nobody signed in, another tab's edit stays on this device, as it always has.
 */
export function watchOtherTabs(on: { reload: () => void; refresh: () => void }): () => void {
  if (typeof window === "undefined") return () => {};
  // A sign-in this tab kept for "Try again" belongs to the generation that just ended. It is dropped before
  // the reload, so no working code and verifier outlive "Delete everything in this browser" in this tab.
  const offHands = onBrowserChangedHandsElsewhere(() => {
    saveSignInCode(null);
    on.reload();
  });
  if (!accountConfig()) return offHands;
  // Signed in in another tab: a sign-in this tab kept for "Try again" has nothing left to finish. Dropped,
  // not just hidden, or a sign-out there would bring it back (the fifth review).
  const offSignIn = onSignInChangedElsewhere(() => {
    if (currentSession()) saveSignInCode(null);
  });
  const offStores = onStoresChangedElsewhere((names) => {
    if (!currentSession()) return;
    if (names.some((n) => HELD_BY_SCREENS.has(n)) && claimSyncReload()) on.reload();
    else on.refresh();
  });
  return () => {
    offHands();
    offSignIn();
    offStores();
  };
}

/**
 * Keep what the last sync DID across the reload it is about to cause. `<AccountSync/>` calls it just
 * before reloading for a pull, so "set aside" or "your account had newer data" is still said afterwards:
 * the reload used to wipe it before anyone could read it (review 2).
 *
 * Only the one-off sentences, and tagged with the account they were about (review of batches 4-5).
 * The whole status line used to be carried: a held-back store's sentence, which the next sync says again
 * by itself, then appeared twice, and a note left waiting by a page whose next sync never succeeded was
 * shown to whichever account signed in next in that tab.
 */
export function carryNoteAcrossReload(): void {
  if (lastNotes && lastNotes.userId === status.userId && lastNotes.oneOff.length) saveCarriedNote(JSON.stringify(lastNotes));
}

/** The one-off sentences the last successful sync said, and whose account they were about. */
let lastNotes: { userId: string; oneOff: string[] } | null = null;
const unique = (xs: string[]) => [...new Set(xs)];

/** What a reload carried for THIS account. A note about anyone else is dropped, unread. */
function takeCarriedNotes(userId: string): string[] {
  const raw = takeCarriedNote();
  if (!raw) return [];
  try {
    const c = JSON.parse(raw) as { userId?: unknown; oneOff?: unknown };
    return c.userId === userId && Array.isArray(c.oneOff) ? c.oneOff.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // a bare sentence carried by an earlier version: no account attached, so not shown
  }
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
    // Both are answers to pushes that may arrive after this sync was stopped ("delete everything", a
    // sign-out): then they must neither write bookkeeping into the emptied browser nor restart the
    // stopped sync and show it as "Syncing…" (review 2).
    onSaved: (rows) => {
      if (!isCurrent()) return;
      for (const r of rows) markSynced(r.name, r.at);
    },
    // The account already had a newer write for these stores: pull before sending them again.
    onStale: () => {
      if (isCurrent()) void resync();
    },
  });

  // Every local edit from here on is queued. Subscribed BEFORE the first sync, so an edit made while it
  // runs is not missed.
  const unsubscribe = onStoreChange((c) => mirror.enqueue(c.name, c.value, c.at));

  // The account moved on while a full sync was pushing (a push was skipped): pull again as soon as
  // this sync finishes. It used to be queued as a microtask, which ran while `inFlight` was still set
  // and so only joined the finishing sync: it never ran at all, and the status said "saved" over a
  // store the account held differently (review 2). Bounded, so a store that keeps being skipped
  // cannot loop.
  let wantFollowUp = false;
  let followUps = 0;
  const MAX_FOLLOW_UPS = 2;

  function resync(): Promise<SyncReport | null> {
    if (inFlight) return inFlight;
    // Send what is waiting FIRST, so a pull cannot overwrite an edit that simply hadn't gone up yet.
    inFlight = mirror
      .flush()
      .then(() => runSync())
      .finally(() => {
        inFlight = null;
        if (wantFollowUp && isCurrent() && followUps < MAX_FOLLOW_UPS) {
          wantFollowUp = false;
          followUps++;
          void resync();
        } else {
          wantFollowUp = false;
          followUps = 0;
        }
      });
    if (running && running.userId === userId) running.ready = inFlight;
    return inFlight;
  }

  async function runSync(): Promise<SyncReport | null> {
    // Not for a sync that was stopped while this one waited its turn: its status would claim a
    // stopped tab is "Syncing…" for an account it no longer shows (review 2).
    if (!isCurrent()) return null;
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
      // Two kinds of sentence (review of batches 4-5). ONE-OFF notes say what this sync DID ("set
      // aside", "your account had newer data"): nothing will say them again, so they are what a reload
      // must carry. CONDITIONS say what is still true (a store held back, a row this version can't
      // read): the next sync works them out afresh, and carrying them only made them appear twice.
      // What the previous page's sync said comes first, if a reload for it wiped it before anyone could
      // read it, and only if it was said about THIS account.
      const oneOff: string[] = first ? takeCarriedNotes(userId) : [];
      if (first && switchedFrom) {
        oneOff.push("This browser held data from a different account. It is set aside on the account page, not added to this one.");
      }
      if (report.backedUp) {
        oneOff.push("Your account had newer data, so it replaced some of what was on this device. The previous copy is kept on the account page.");
      }
      if (report.keptAccountCopy?.length) {
        oneOff.push(`This device's newer changes replaced ${list(report.keptAccountCopy)} in your account. The account's previous copy is kept on the account page.`);
      }
      const conditions: string[] = [];
      if (report.invalid.length) {
        conditions.push(`${capital(list(report.invalid))} in your account couldn't be read by this version of the app, so this device kept its own copy.`);
      }
      // The full sync's verdict on each store feeds the mirror's held-back set, so the warning
      // persists until that store genuinely gets through.
      for (const n of report.tooLarge) mirror.hold(n, "too-large");
      for (const n of report.refused) mirror.hold(n, "refused");
      for (const n of [...report.pushed, ...report.merged]) mirror.release(n);
      if (held.size) conditions.push(heldMessage(held));
      lastNotes = { userId, oneOff: unique(oneOff) };
      setStatus({
        state: held.size ? "error" : "saved",
        email,
        userId,
        lastSyncedAt: Date.now(),
        message: unique([...oneOff, ...conditions]).join(" ") || undefined,
      });
      announcePulled(report);
      if (report.skipped.length) wantFollowUp = true; // the account moved on mid-sync: see `resync`
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
      // Not "you signed out": the other tab may have found the account deleted, or the sign-in expired
      // (review of batches 4-5). This tab cannot tell which; what it can say is true either way, and
      // the tab that knows says why.
      setStatus({ state: "signed-out", message: "This browser was signed out in another tab. Everything is still on this device." });
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
  if (e instanceof AccountError && e.kind === "gone") {
    // The account was deleted while this device still held a working token: on another device, say.
    // Nothing here can reach it any more, so stop and forget the sign-in (only if it is still that
    // account's: another tab may have signed someone else in meanwhile). The data stays here, still
    // marked as the deleted account's, so whoever signs in next has it set aside rather than uploaded,
    // exactly as on the device that deleted it.
    stopRunning();
    if (currentSession()?.userId === userId) saveSessionRaw(null);
    setStatus({
      state: "signed-out",
      message: "This account was deleted, perhaps on another device, so this device has stopped syncing and signed out. Everything is still here. If anyone signs in here again, you with a new account included, it is set aside as a copy rather than added to that account.",
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
 * tab still showed Sam, and "Delete my account" deleted BOB's account, for good, while telling Sam hers
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
  const unsent = await stopSync();
  // Who is signed in is checked AFTER the wait, and again after each one below (review of batches 4-5):
  // the sign-in can change while this tab sends what was waiting, or while /logout answers. This one
  // check also covers a tab that missed another tab's sign-in before it ever started (review 2); a
  // separate check before the wait added nothing this one doesn't do, so it went. The send itself
  // cannot carry this tab's edits to the other account: each request is pinned to this tab's account.
  const now = currentSession();
  if (!now) {
    // The send itself ended the sign-in (the account turned out to have been deleted), or another tab
    // signed out meanwhile. What was said about that stands; there is nothing left here to end.
    takeCarriedNote();
    if (!(status.state === "signed-out" && status.message)) setStatus({ state: cfg ? "signed-out" : "off" });
    return;
  }
  if (now.userId !== mine) {
    // Someone else signed in, in another tab, while this one was sending. Not this tab's to end.
    setStatus({ state: "signed-out", message: `${ANOTHER_TAB}, so this tab stopped and left that sign-in alone. Reload it to see which account it is.` });
    return;
  }
  let ended = true;
  if (cfg) {
    // /logout refuses an expired access token, which would leave the server session alive while the
    // page said "signed out". Renew it first; if that fails too, use the stored one, but only while it
    // is still THIS account's. Falling back to whatever was stored ended another person's sign-in.
    const s = await liveSession(cfg, mine ?? undefined).catch(() => (currentSession()?.userId === mine ? currentSession() : null));
    ended = s ? await signOutRemote(cfg, s) : false;
  }
  if (currentSession()?.userId === mine) saveSessionRaw(null);
  takeCarriedNote(); // a sentence waiting for this account's next page load is not for whoever comes next
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
    const live = await liveSession(cfg, s.userId).catch(() => s);
    await signOutRemote(cfg, live);
  }
  // Checked again after the wait (review of batches 4-5): if another tab signed someone in while
  // /logout answered, clearing now would wipe THEIR sign-in and the data that just came down for them.
  const now = currentSession();
  if (now && now.userId !== s?.userId) {
    throw new AccountError(`${ANOTHER_TAB} while this one was signing out, so nothing was deleted. Reload this page to see it first.`, "superseded");
  }
  clearAll();
  takeCarriedNote();
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
  takeCarriedNote();
  setStatus({
    state: "signed-out",
    message: "Your account and everything stored in it are deleted. (Sign-in logs and the email service's records are not part of the account: they keep your email address for as long as those services' log settings keep them.) This browser still has its copy. If anyone signs in here again, you with a new account included, it is set aside as a copy rather than added to that account.",
  });
}
