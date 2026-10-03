/**
 * The browser side of accounts: the session, the one running sync, and its status.
 *
 * Everything below is a thin wire between pieces that are tested on their own — `storage.ts` (the
 * local copy), `sync.ts` (the rules and the mirror) and `supabase.ts` (the REST calls). If accounts
 * are not configured for this build, every entry point here is a no-op and reports `off`.
 *
 * ONE sync per tab, held in this module. The account page and the always-mounted `<AccountSync/>`
 * both call `startSync`; the second call joins the first rather than starting a second mirror,
 * which would push every edit twice and race itself.
 */
import {
  STORE_NAMES, loadSessionRaw, loadStoreMeta, onStoreChange, readStore, saveSessionRaw, takeBackup, writeStore,
} from "../storage";
import { createMirror, syncNow, type LocalAccess, type Mirror, type SyncReport } from "./sync";
import {
  AccountError, deleteAccountRemote, freshSession, readAccountConfig, requestMagicLink, sessionFromRedirect,
  signOutRemote, supabaseRemote, type AccountConfig, type Session,
} from "./supabase";

export type AccountState =
  /** Accounts are not switched on for this build (no Supabase URL/key). */
  | "off"
  | "signed-out"
  | "syncing"
  | "saved"
  /** Edits made, not yet sent (the debounce window). */
  | "pending"
  /** The last send failed; edits are queued and go out when the network is back. */
  | "offline"
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

/** The session, refreshed when close to expiry and persisted. Throws when the sign-in is dead. */
async function liveSession(cfg: AccountConfig): Promise<Session> {
  const s = currentSession();
  if (!s) throw new AccountError("You're signed out.");
  const next = await freshSession(cfg, s);
  if (next !== s) saveSessionRaw(next);
  return next;
}

/** This browser's storage, as the sync engine sees it. */
const localAccess: LocalAccess = {
  names: STORE_NAMES,
  read: (n) => readStore(n),
  meta: () => loadStoreMeta(),
  writeSilently: (n, v, at) => writeStore(n, v, { at, silent: true }),
  backup: (reason) => {
    takeBackup(reason);
  },
};

/* ---- sign in / out ---- */

export async function sendSignInLink(email: string): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  await requestMagicLink(cfg, email, `${window.location.origin}${window.location.pathname}`);
}

/**
 * If this page was opened from a sign-in link, keep the session and strip the tokens from the address
 * bar (so they are not left in history or a copied URL). Returns the session, or null when the page
 * was opened normally. Throws a readable error for an expired or used link.
 */
export function completeSignInFromUrl(): Session | null {
  if (typeof window === "undefined" || !window.location.hash) return null;
  const s = sessionFromRedirect(window.location.hash);
  if (s || /error/.test(window.location.hash)) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  if (s) saveSessionRaw(s);
  return s;
}

/* ---- the running sync ---- */

let running: { stop: () => void; mirror: Mirror; ready: Promise<SyncReport | null> } | null = null;

/**
 * Sync now, then mirror every local edit. Safe to call any number of times: joins the running sync.
 * `onPulled` hears which stores came down from the account, so mounted screens can re-read them.
 */
export function startSync(onPulled?: (report: SyncReport) => void): Promise<SyncReport | null> {
  const cfg = accountConfig();
  if (!cfg) {
    setStatus({ state: "off" });
    return Promise.resolve(null);
  }
  const session = currentSession();
  if (!session) {
    setStatus({ state: "signed-out" });
    return Promise.resolve(null);
  }
  if (running) return running.ready;

  const remote = supabaseRemote(cfg, () => liveSession(cfg));
  const email = session.email;
  const mirror = createMirror(remote, {
    onStatus: (s) => {
      if (s === "idle") return;
      const map = { pending: "pending", saving: "syncing", saved: "saved", offline: "offline" } as const;
      setStatus({
        state: map[s],
        email,
        lastSyncedAt: s === "saved" ? Date.now() : status.lastSyncedAt,
        message: s === "offline" ? "Couldn't reach your account. Your changes are kept here and will be sent when you're back online." : undefined,
      });
    },
  });

  // Every local edit from here on goes up. Subscribed BEFORE the first sync, so an edit made while it
  // runs is queued, not missed.
  const unsubscribe = onStoreChange((c) => mirror.enqueue(c.name, c.value, c.at));
  const flushNow = () => void mirror.flush();
  const onHide = () => {
    if (document.visibilityState === "hidden") flushNow();
  };
  window.addEventListener("online", flushNow);
  document.addEventListener("visibilitychange", onHide);

  setStatus({ state: "syncing", email });
  const ready = syncNow(localAccess, remote)
    .then((report) => {
      setStatus({
        state: "saved",
        email,
        lastSyncedAt: Date.now(),
        message: report.backedUp
          ? "Your account had newer data, so it replaced some of what was on this device. The previous copy is kept on the account page."
          : undefined,
      });
      if (report.pulled.length || report.merged.length) onPulled?.(report);
      return report;
    })
    .catch((e: unknown) => {
      setStatus({ state: "offline", email, message: e instanceof Error ? e.message : "Couldn't sync just now." });
      return null;
    });

  running = {
    mirror,
    ready,
    stop: () => {
      unsubscribe();
      mirror.stop();
      window.removeEventListener("online", flushNow);
      document.removeEventListener("visibilitychange", onHide);
    },
  };
  return ready;
}

/** Send anything still waiting, then stop mirroring. */
async function stopSync(): Promise<void> {
  if (!running) return;
  await running.mirror.flush().catch(() => {});
  running.stop();
  running = null;
}

/**
 * Sign out. This device KEEPS its data — local-first means the account is a mirror, and signing out
 * stops the mirror rather than emptying the working copy. Deleting local data is its own action.
 */
export async function signOut(): Promise<void> {
  const cfg = accountConfig();
  const s = currentSession();
  await stopSync();
  if (cfg && s) await signOutRemote(cfg, s);
  saveSessionRaw(null);
  setStatus({ state: cfg ? "signed-out" : "off" });
}

/** Delete the account and everything stored in it. This device's copy is left for the person to decide. */
export async function deleteAccount(): Promise<void> {
  const cfg = accountConfig();
  if (!cfg) throw new AccountError("Accounts aren't switched on for this copy of the app.");
  const s = await liveSession(cfg);
  if (running) {
    running.stop(); // do NOT flush: pending edits must not recreate rows we are about to delete
    running = null;
  }
  await deleteAccountRemote(cfg, s);
  saveSessionRaw(null);
  setStatus({ state: "signed-out", message: "Your account and everything in it are deleted." });
}
