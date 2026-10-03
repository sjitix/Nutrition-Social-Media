import type { ChatMessage, UserProfile, WeekPlan } from "./types";
import type { ImportedRecipe } from "./import";
import { canonical, nextStamp } from "./account/merge";

// Client-side persistence. The browser copy is ALWAYS the working copy every screen reads,
// synchronously. Accounts (src/lib/account/) mirror it to a hosted database underneath — local-first,
// the account is a mirror — which is why nothing about this module's load/save API changed when
// they arrived, and why no screen had to either. See docs/parallel/lane-accounts.md.

const KEYS = {
  profile: "nutriflow.profile",
  plan: "nutriflow.plan",
  chat: "nutriflow.chat",
  imports: "nutriflow.imports",
  saved: "nutriflow.saved",
  groceriesChecked: "nutriflow.groceriesChecked",
  visits: "nutriflow.visits",
  // The batch-mode week, cached alongside the fresh week (under `plan`) so a fresh<->batch toggle is
  // instant and lossless. One key, defined here only — a second ad-hoc key once drifted (savedStore.ts).
  batchPlan: "nutriflow.batchPlan",
} as const;

/**
 * Bookkeeping keys. NOT user data: never exported, never synced, never shown as "your data".
 *
 * - `meta`    — the write time of each store's current value (ms since epoch): this device's clock
 *               for its own edits, but never earlier than the value replaced (merge.ts `nextStamp`),
 *               or the account's time for a value that came from there. Sync compares it with the
 *               account's copy to decide which side is newer.
 * - `synced`  — for each store, the write time this device and the account last AGREED on (after a
 *               push or a pull). A store whose `meta` is newer than its `synced` holds an edit the
 *               account has never seen — the only kind of local data a sync must back up before
 *               replacing. Without it every routine pull took a backup and the important ones (the
 *               week from before signing in, the state before an import) were pushed out.
 * - `backup`  — the last few snapshots of every store, taken immediately before something replaces
 *               local data wholesale. What makes those actions undoable.
 * - `session` — the signed-in account's tokens. A credential: never exported, never synced.
 * - `owner`   — the id of the account this browser's data was last synced with. It is what stops
 *               one account's week being pushed into another's when someone else signs in on the
 *               same browser (see `src/lib/account/client.ts`). Unset means "never synced": the
 *               data is the person's own pre-account data, and comes with them when they sign in.
 * - `pkce`    — the secret half of a sign-in THIS browser asked for. A sign-in link only completes
 *               where its verifier is, which is what stops someone else's link (or a pasted token)
 *               signing this browser into their account. A credential: never exported, never synced.
 */
const INTERNAL = {
  meta: "nutriflow.meta",
  synced: "nutriflow.synced",
  backup: "nutriflow.backup",
  session: "nutriflow.session",
  owner: "nutriflow.owner",
  pkce: "nutriflow.pkce",
  // Which generation of this browser's data is current: see THE WRITE FENCE below.
  epoch: "nutriflow.epoch",
} as const;

/**
 * Per-TAB bookkeeping (sessionStorage), so none of it can outlive the tab.
 * - `syncReload` — when this tab last reloaded itself for sync (see `claimSyncReload`).
 * - `signInCode` — the one-time code from a sign-in link whose exchange failed for a TRANSIENT reason.
 *   It stays good for a few minutes, so "Try again" can finish the sign-in. The emailed link was used
 *   up when it was opened, so opening it again could not.
 * - `carriedNote` — what this tab's sync had just said when this tab reloaded itself for it, so the
 *   sentence ("set aside", "your account had newer data") survives the reload it caused.
 */
const TAB = {
  syncReload: "nutriflow.syncReload",
  signInCode: "nutriflow.signInCode",
  carriedNote: "nutriflow.carriedNote",
} as const;

/* ------------------------------------------------------------------------------------------------
 * THE WRITE FENCE.
 *
 * Which GENERATION of this browser's data each tab's screens loaded. A new generation starts whenever
 * the browser changes hands: the account-switch guard resets the stores for someone else, or "Delete
 * everything in this browser" clears them. A tab still working from an earlier generation is refused
 * every write into the new one.
 *
 * Why (review 2, found by three lenses): another tab's sign-in, or a clear, reaches this tab as a
 * `storage` event a moment later, and the tab then reloads (client.ts `watchOtherTabs`). But a save
 * already under way, such as an assistant turn finishing, landed in between. It wrote the previous
 * person's profile and week into storage that now belonged to someone else, stamped newest, and their
 * sync uploaded it into the wrong account. Or, after a clear, it wrote them back into an emptied
 * browser. Reloading made that unlikely; the fence makes it impossible.
 *
 * The same key is the reload signal: `onBrowserChangedHandsElsewhere`. A sign-out or a refreshed token
 * changes neither the data nor the generation, so neither fences nor reloads anything.
 *
 * What it covers is everything a stale tab could still write, not only the stores: their write times
 * and sync markers, the account this browser's data belongs to, and the copies. A stale tab's sync,
 * answered late, would otherwise record the previous account as the owner, and the next time that
 * person signed in here, the new person's data would be taken for theirs and uploaded into their
 * account. A copy taken from a stale tab could push the previous person's set-aside data out of the
 * three kept, or file the previous account's values where the next person sees them (review 2, batch 4).
 * Left out on purpose: forgetting a copy (it only removes, and someone deleting a copy of their data
 * must never be refused), the sign-in itself (pinned by user id instead: client.ts `liveSession`), and
 * resetting or clearing, which are what START a generation.
 * ---------------------------------------------------------------------------------------------- */

/** What a refused action says, where the person is waiting for an answer (a copy, an import). */
const CHANGED_HANDS =
  "This browser was signed in to a different account, or cleared, in another tab, so nothing was changed here. Reload this tab to see what it holds now.";

/**
 * The generation this tab is working from, per storage: in a browser there is exactly one
 * `localStorage`, so this is simply "this tab's generation". Keyed by the storage object so that a
 * test swapping in another device's storage under the same module is another device, not a stale tab.
 */
const knownEpoch = new WeakMap<object, string | null>();

const storedEpoch = (): string | null => window.localStorage.getItem(INTERNAL.epoch);

/**
 * This tab's first read or write, of ANY key: from now on, it works from the generation it found.
 * Not only a store read: a tab that had only listed the copies, then put one back after another tab
 * switched accounts, would otherwise have adopted the new generation at that very write.
 */
function knowEpoch(): void {
  if (!knownEpoch.has(window.localStorage)) knownEpoch.set(window.localStorage, storedEpoch());
}

/** This tab is the one changing hands: start a new generation, and work from it. */
function newEpoch(): void {
  const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(INTERNAL.epoch, next);
  knownEpoch.set(window.localStorage, next);
}

/** False once another tab has moved the browser to a new generation: this tab must not write. */
function fenceHolds(): boolean {
  knowEpoch();
  const now = storedEpoch();
  if (now === knownEpoch.get(window.localStorage)) return true;
  // No generation stored at all: nothing in the app started one (only clearing the site's data from
  // outside the app removes it), so there is nothing to fence. Work from here.
  if (now === null) {
    knownEpoch.set(window.localStorage, null);
    return true;
  }
  console.warn("NutriFlow: this browser changed hands in another tab, so this tab's save was refused. The tab reloads.");
  return false;
}

/** The names of the user-data stores. This list IS the contract with the export file and the server. */
export type StoreName = keyof typeof KEYS;
export const STORE_NAMES = Object.keys(KEYS) as StoreName[];

const IMPORTS_CAP = 24;
const VISITS_CAP = 400; // ~13 months of daily-use history is plenty for a streak

function readKey<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    // Inside the try: where touching storage throws at all (Safari with site data blocked, some
    // private modes), a read must still come back empty rather than crash the screen (batch 4).
    knowEpoch(); // what a tab has read is what it may write back: THE WRITE FENCE
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeKey(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

/* ------------------------------------------------------------------------------------------------
 * Change notification — the seam sync hangs off.
 * ---------------------------------------------------------------------------------------------- */

export interface StoreChange {
  name: StoreName;
  /** The new value, or null when the store was cleared. */
  value: unknown;
  /** When this device wrote it (ms since epoch). */
  at: number;
}
type Listener = (change: StoreChange) => void;
const listeners = new Set<Listener>();

/** Be told about every local write to a user-data store. Returns an unsubscribe function. */
export function onStoreChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Per-store last-write times on this device. */
export function loadStoreMeta(): Partial<Record<StoreName, number>> {
  return readKey<Partial<Record<StoreName, number>>>(INTERNAL.meta) ?? {};
}

function stamp(name: StoreName, at: number): void {
  writeKey(INTERNAL.meta, { ...loadStoreMeta(), [name]: at });
}

/** Per-store write times this device and the account last agreed on. */
export function loadSyncedAt(): Partial<Record<StoreName, number>> {
  return readKey<Partial<Record<StoreName, number>>>(INTERNAL.synced) ?? {};
}
/** Record that the account now holds this store as written at `at` (after a push or a pull). */
export function markSynced(name: StoreName, at: number): void {
  if (!fenceHolds()) return; // a stale tab's sync must not write into the new generation's bookkeeping
  writeKey(INTERNAL.synced, { ...loadSyncedAt(), [name]: at });
}

/** Forget one store on this device entirely — value, write time and sync marker — without announcing it. */
function forgetStore(name: StoreName): void {
  window.localStorage.removeItem(KEYS[name]);
  const meta = loadStoreMeta();
  delete meta[name];
  writeKey(INTERNAL.meta, meta);
  const synced = loadSyncedAt();
  delete synced[name];
  writeKey(INTERNAL.synced, synced);
}

/**
 * The one write path for user data. Every save below goes through here, so the timestamp and the
 * change event cannot be forgotten by a save function added later.
 *
 * An UNCHANGED value is not an edit. Several screens re-save what they just loaded (the grocery
 * list on opening, the assistant after a turn that changed nothing). Before accounts that was
 * harmless; with sync, stamping it "now" made a stale device's copy look like the newest edit and
 * overwrite real edits from another device. So a save that changes nothing — the same content, or
 * an empty list/null over a store that doesn't exist — stamps nothing and announces nothing.
 *
 * `silent` is for writes that must not be announced as local edits: a value that came FROM the
 * account (it carries the account's timestamp — announcing it would push it straight back), and
 * clearing this browser (which must never reach out and empty the account as a side effect).
 */
function write(name: StoreName, value: unknown, opts: { at?: number; silent?: boolean } = {}): void {
  if (!fenceHolds()) return; // THE WRITE FENCE: the browser changed hands in another tab
  const clearing = value === null || value === undefined;
  if (!opts.silent) {
    const current = window.localStorage.getItem(KEYS[name]);
    if (current === null && (clearing || (Array.isArray(value) && value.length === 0))) return;
    if (current !== null && !clearing) {
      try {
        if (canonical(JSON.parse(current)) === canonical(value)) return;
      } catch {
        /* unreadable current value: this write replaces it */
      }
    }
  }
  // Never earlier than the value being replaced, whatever this device's clock says: an edit made
  // after a sync must beat what the sync brought, or the next sync undoes it (merge.ts, CLOCKS).
  const at = opts.at ?? nextStamp(Date.now(), loadStoreMeta()[name]);
  if (clearing) window.localStorage.removeItem(KEYS[name]);
  else writeKey(KEYS[name], value);
  stamp(name, at);
  if (!opts.silent) for (const fn of listeners) fn({ name, value: clearing ? null : value, at });
}

const read = <T>(name: StoreName) => readKey<T>(KEYS[name]);

/** Raw read of one store, for export and sync. Screens use the typed loaders below. */
export function readStore(name: StoreName): unknown {
  return read<unknown>(name);
}

/**
 * Raw write of one store, for import and sync. `null` clears it. Validation is the CALLER's job —
 * `src/lib/account/validate.ts` checks a file or an account row before anything reaches here.
 */
export function writeStore(name: StoreName, value: unknown, opts?: { at?: number; silent?: boolean }): void {
  write(name, value, opts);
}

/* ------------------------------------------------------------------------------------------------
 * The typed API every screen uses. Unchanged in shape since before accounts existed.
 * ---------------------------------------------------------------------------------------------- */

export const loadProfile = () => read<UserProfile>("profile");
export const saveProfile = (p: UserProfile) => write("profile", p);

export const loadPlan = () => read<WeekPlan>("plan");
export const savePlan = (p: WeekPlan) => write("plan", p);

// The batch-mode week, cached so toggling fresh<->batch is instant and doesn't lose the built week.
// Null until batch mode is first built. The active/displayed week stays under `plan`.
export const loadBatchPlan = () => read<WeekPlan>("batchPlan");
export const saveBatchPlan = (p: WeekPlan) => write("batchPlan", p);

export const loadChat = () => read<ChatMessage[]>("chat") ?? [];
export const saveChat = (m: ChatMessage[]) => write("chat", m);

// A history of recipes imported from a link, newest first, deduped by source URL. Lets someone
// re-add something they imported before without re-fetching it. Each entry is stamped with when it
// was imported, so two devices' histories can be merged by RECENCY rather than by which device's
// list happened to lead (src/lib/account/merge.ts).
export const loadImports = () => read<ImportedRecipe[]>("imports") ?? [];
export function rememberImport(r: ImportedRecipe): ImportedRecipe[] {
  const prev = loadImports();
  const rest = prev.filter((x) => x.sourceUrl !== r.sourceUrl);
  // Later than every import this device has seen, on any clock: on a device whose clock runs slow,
  // the recipe just imported would otherwise rank below older ones in the merged history, and fall
  // off the end of a full one.
  const newest = prev.reduce<number | undefined>((m, x) => {
    const t = (x as { importedAt?: unknown }).importedAt;
    return typeof t === "number" && (m === undefined || t > m) ? t : m;
  }, undefined);
  const next = [{ ...r, importedAt: nextStamp(Date.now(), newest) } as ImportedRecipe, ...rest].slice(0, IMPORTS_CAP);
  write("imports", next);
  return next;
}

// Saved / favorited recipes, by name (works for both library and imported recipes).
export const loadSaved = () => read<string[]>("saved") ?? [];
export function toggleSaved(name: string): string[] {
  const cur = loadSaved();
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [name, ...cur];
  write("saved", next);
  return next;
}

// Which grocery items are ticked off, by their lowercased name key, so a mid-shop reload keeps them.
export const loadGroceriesChecked = () => read<string[]>("groceriesChecked") ?? [];
export const saveGroceriesChecked = (keys: string[]) => write("groceriesChecked", keys);

// Days the app was opened (ISO "YYYY-MM-DD"), for the daily-use streak. Recording today is
// idempotent, and the list is capped and kept sorted-newest-first.
export const loadVisits = () => read<string[]>("visits") ?? [];
export function recordVisit(todayIso: string): string[] {
  const cur = loadVisits();
  if (cur.includes(todayIso)) return cur;
  const next = [todayIso, ...cur].sort((a, b) => (a < b ? 1 : -1)).slice(0, VISITS_CAP);
  write("visits", next);
  return next;
}

/* ------------------------------------------------------------------------------------------------
 * The safety net: the last few backups, and deleting everything.
 * ---------------------------------------------------------------------------------------------- */

export interface LocalBackup {
  /** Unique within this browser; what `restoreBackup` / `discardBackup` are given. */
  id: number;
  /** Why it was taken, in words the account page can show ("before importing a file"). */
  reason: string;
  takenAt: number;
  data: Partial<Record<StoreName, unknown>>;
}

/**
 * How many backups are kept. More than one ON PURPOSE: a single slot let a later backup overwrite an
 * earlier one that still held the only copy of something. With `synced` (above), a sync only backs up
 * data the account has never seen, so backups are rare and three is plenty.
 */
const BACKUPS_KEPT = 3;

/** Every kept backup, newest first. Reads the older single-backup shape too. */
export function loadBackups(): LocalBackup[] {
  const raw = readKey<unknown>(INTERNAL.backup);
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return list
    .filter((b): b is LocalBackup => !!b && typeof b === "object" && typeof (b as LocalBackup).takenAt === "number")
    .map((b) => ({ ...b, id: typeof b.id === "number" ? b.id : b.takenAt }));
}

/** The newest backup, or null. */
export const loadBackup = (): LocalBackup | null => loadBackups()[0] ?? null;

/**
 * Write the backup list, dropping the OLDEST copies if the browser's storage is full. Throws only
 * when even this one backup will not fit — and callers treat that as "do not replace anything",
 * because replacing data without a copy is exactly what backups exist to prevent.
 */
function writeBackups(list: LocalBackup[]): void {
  // `list` is in order of what to keep FIRST; it is stored newest first.
  for (let keep = list.length; keep >= 1; keep--) {
    try {
      writeKey(INTERNAL.backup, list.slice(0, keep).sort((a, b) => b.id - a.id));
      return;
    } catch {
      /* QuotaExceededError — try again with one fewer old copy */
    }
  }
  throw new Error("There isn't room in this browser to keep a safety copy of your data, so nothing was replaced.");
}

/**
 * Snapshot every user-data store before something replaces them. Keeps the last few.
 *
 * `data` keeps those values instead of this browser's stores: the ACCOUNT's copies a sync is about to
 * replace (merge.ts rule 6). Putting such a copy back writes them here and sends them up again.
 */
export function takeBackup(reason: string, opts: { data?: Partial<Record<StoreName, unknown>> } = {}): LocalBackup {
  // Thrown, not skipped: every caller already treats "no safety copy" as "change nothing", which is
  // exactly right for a tab the browser changed hands under (THE WRITE FENCE).
  if (!fenceHolds()) throw new Error(CHANGED_HANDS);
  const data: Partial<Record<StoreName, unknown>> = {};
  for (const n of STORE_NAMES) {
    const v = opts.data ? opts.data[n] ?? null : read<unknown>(n);
    if (v !== null) data[n] = v;
  }
  const existing = loadBackups();
  const now = Date.now();
  const id = Math.max(now, ...existing.map((b) => b.id + 1));
  const backup: LocalBackup = { id, reason, takenAt: now, data };
  writeBackups([backup, ...existing].slice(0, BACKUPS_KEPT));
  return backup;
}

/**
 * "Put it back", the way the account page does it. What is here now is kept as a copy first; then
 * the chosen copy is put back. Returns false, changing nothing, when that copy no longer exists.
 * Throws when no safety copy can be taken (no room, or the browser changed hands in another tab), and
 * then nothing is replaced: not even the safety copy, which could otherwise push another copy out.
 *
 * The chosen copy is read BEFORE the safety copy is taken, and put back from that reading. With three
 * copies kept, taking the safety copy pushes out the oldest, which is often the very one being put
 * back. Looking it up again afterwards found nothing, so the button destroyed the copy and restored
 * nothing, silently (review 2, found twice). Read first, it cannot be lost that way, and no OTHER copy
 * has to make room for it: being put back uses it up anyway.
 */
export function putBackCopy(id: number, reason: string): boolean {
  const target = loadBackups().find((b) => b.id === id);
  if (!target) return false;
  takeBackup(reason);
  try {
    return restoreBackup(target);
  } catch (e) {
    // The restore failed part-way (storage full). Keep the copy listed, so it can be tried again.
    try {
      writeBackups([target, ...loadBackups().filter((b) => b.id !== target.id)]);
    } catch {
      /* nothing more can be done here */
    }
    throw e;
  }
}

/** Forget one backup (by id), or all of them. */
export function discardBackup(id?: number): void {
  if (id === undefined) {
    window.localStorage.removeItem(INTERNAL.backup);
    return;
  }
  const rest = loadBackups().filter((b) => b.id !== id);
  if (rest.length) writeKey(INTERNAL.backup, rest);
  else window.localStorage.removeItem(INTERNAL.backup);
}

/**
 * Put a backup back (the newest, unless an id is given).
 *
 * Every store the copy HOLDS is written back as a fresh local edit, so it syncs and wins — restoring
 * while signed in makes that data the account's data, which the page says.
 *
 * A store the copy does NOT hold is never written as "cleared": that would be a deletion, and sync
 * would carry it to the account and every other device, destroying data that simply wasn't on this
 * device when the copy was taken (the adversarial review reproduced exactly that). Instead such a store
 * is forgotten here, silently — value, write time and sync marker — so this device goes back to having
 * "never had it", and the next sync brings the account's copy down again.
 */
export function restoreBackup(which?: number | LocalBackup): boolean {
  const all = loadBackups();
  const b = typeof which === "object" ? which : which === undefined ? all[0] : all.find((x) => x.id === which);
  if (!b || !fenceHolds()) return false;
  for (const n of STORE_NAMES) {
    if (n in b.data && b.data[n] !== null && b.data[n] !== undefined) {
      // Announced, freshly stamped, and FORCED even when equal: putting a copy back is a decision.
      // Stamped later than the value it replaces, on any clock: on a device whose clock runs slow, a
      // restore stamped earlier than the copy it replaces would be pulled straight back over by the
      // next sync, with no backup left, since this one is discarded below (merge.ts, CLOCKS).
      const value = b.data[n];
      const at = nextStamp(Date.now(), loadStoreMeta()[n]);
      writeKey(KEYS[n], value);
      stamp(n, at);
      for (const fn of listeners) fn({ name: n, value, at });
    } else {
      forgetStore(n);
    }
  }
  discardBackup(b.id);
  return true;
}

/** Which account this browser's data last synced with, or null if it never has. */
export function loadSyncOwner(): string | null {
  const v = readKey<unknown>(INTERNAL.owner);
  return typeof v === "string" && v ? v : null;
}
export function saveSyncOwner(id: string | null): void {
  if (!fenceHolds()) return; // a stale tab's late sync must not make the previous account the owner
  if (!id) window.localStorage.removeItem(INTERNAL.owner);
  else writeKey(INTERNAL.owner, id);
}

/**
 * Empty every user-data store AND forget their write times and sync markers, without announcing
 * anything — for when a different account signs in on this browser and the local data must not be
 * mistaken for theirs. The caller takes a backup first. The session, the backups and the owner stay.
 * The browser has changed hands, so a new generation starts (THE WRITE FENCE): other tabs still
 * holding the previous account's data can no longer write it here, and reload.
 */
export function resetStoresSilently(): void {
  for (const n of STORE_NAMES) window.localStorage.removeItem(KEYS[n]);
  window.localStorage.removeItem(INTERNAL.meta);
  window.localStorage.removeItem(INTERNAL.synced);
  newEpoch();
}

/** What this tab's sync had just said, kept for after the reload it is about to do. */
export function saveCarriedNote(text: string): void {
  try {
    window.sessionStorage.setItem(TAB.carriedNote, text);
  } catch {
    /* no sessionStorage: the sentence is simply not carried */
  }
}
/** The sentence carried across this tab's reload, if any; reading it forgets it. */
export function takeCarriedNote(): string | null {
  try {
    const v = window.sessionStorage.getItem(TAB.carriedNote);
    if (v !== null) window.sessionStorage.removeItem(TAB.carriedNote);
    return v;
  } catch {
    return null;
  }
}

/**
 * Be told when ANOTHER TAB moves this browser to a new generation of data (THE WRITE FENCE): someone
 * else's sign-in reset the stores, or the browser was cleared. This tab's screens then hold data
 * that is no longer this browser's, and must reload. A sign-out or a refreshed token does not count.
 */
export function onBrowserChangedHandsElsewhere(fn: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const handler = (e: StorageEvent) => {
    if (e.key === INTERNAL.epoch || e.key === null) fn();
  };
  window.addEventListener("storage", handler as EventListener);
  return () => window.removeEventListener("storage", handler as EventListener);
}

/** A pending sign-in this browser started: the PKCE verifier, for whom, and when. */
export interface PendingSignIn {
  verifier: string;
  email: string;
  at: number;
}
export function loadPendingSignIn(): PendingSignIn | null {
  const v = readKey<PendingSignIn>(INTERNAL.pkce);
  return v && typeof v.verifier === "string" && typeof v.at === "number" ? v : null;
}
export function savePendingSignIn(p: PendingSignIn | null): void {
  if (!p) window.localStorage.removeItem(INTERNAL.pkce);
  else writeKey(INTERNAL.pkce, p);
}
/**
 * Forget the pending sign-in only if it is still the one that was used. A link exchange in flight
 * must not delete the verifier of a NEWER request made meanwhile, which would leave that request's
 * link failing as "opened in a different browser" (review 2).
 */
export function clearPendingSignIn(verifier: string): void {
  if (loadPendingSignIn()?.verifier === verifier) window.localStorage.removeItem(INTERNAL.pkce);
}

/** The one-time code of a sign-in whose exchange failed for a transient reason, kept for "Try again". */
export function loadSignInCode(): string | null {
  try {
    return window.sessionStorage.getItem(TAB.signInCode);
  } catch {
    return null;
  }
}
export function saveSignInCode(code: string | null): void {
  try {
    if (code) window.sessionStorage.setItem(TAB.signInCode, code);
    else window.sessionStorage.removeItem(TAB.signInCode);
  } catch {
    /* no sessionStorage: "Try again" is simply not offered */
  }
}

/**
 * Be told when ANOTHER TAB writes a user-data store, or clears this browser's storage. As with
 * `onSignInChangedElsewhere`, the browser fires `storage` only in the other tabs. Returns an
 * unsubscribe function.
 */
export function onStoresChangedElsewhere(fn: (names: StoreName[]) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const byKey = new Map<string, StoreName>(STORE_NAMES.map((n) => [KEYS[n], n]));
  const handler = (e: StorageEvent) => {
    if (e.key === null) fn([...STORE_NAMES]);
    else {
      const name = byKey.get(e.key);
      if (name) fn([name]);
    }
  };
  window.addEventListener("storage", handler as EventListener);
  return () => window.removeEventListener("storage", handler as EventListener);
}

/**
 * Be told when ANOTHER TAB changes who is signed in on this browser (signs in, signs out, or a
 * different account takes over). The browser's `storage` event only fires in the other tabs, which
 * is exactly the case: the tab that made the change already knows. Returns an unsubscribe function.
 */
export function onSignInChangedElsewhere(fn: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const handler = (e: StorageEvent) => {
    if (e.key === INTERNAL.session || e.key === INTERNAL.owner || e.key === null) fn();
  };
  window.addEventListener("storage", handler as EventListener);
  return () => window.removeEventListener("storage", handler as EventListener);
}

/**
 * A once-per-moment guard for reloading a tab after sync brought new data down (see
 * `src/app/sage/account/AccountSync.tsx`). Kept in sessionStorage so it belongs to this tab only.
 * Returns true when the caller may reload now (and records that it did); false within `windowMs` of
 * the last such reload, so a reload can never loop.
 */
export function claimSyncReload(windowMs = 30_000): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(TAB.syncReload) ?? 0);
    if (Date.now() - last < windowMs) return false;
    window.sessionStorage.setItem(TAB.syncReload, String(Date.now()));
    return true;
  } catch {
    return false; // no sessionStorage (private mode, tests): never reload rather than risk a loop
  }
}

/**
 * The original layout's violet/sage theme choice — a per-device display preference, so it is neither
 * synced nor exported. Owned here so storage.ts stays the only module that touches localStorage
 * (check:boundaries rule 3; this was ThemeSwitch's known debt). The key keeps its original spelling and
 * its value stays a plain string, so every browser that already chose a theme keeps it.
 *
 * `THEME_STORAGE_KEY` is exported for one reason: the pre-hydration boot script has to read the choice
 * before any module loads, so it is a string of JavaScript and needs the key's name spelled into it.
 */
export const THEME_STORAGE_KEY = "nutriflow-theme";
export function loadTheme(): "sage" | "violet" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === "sage" || v === "violet" ? v : null;
  } catch {
    return null;
  }
}
export function saveTheme(theme: "sage" | "violet"): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode): the choice simply isn't remembered */
  }
}

/** The signed-in session, kept here so this stays the only module that names a storage key. */
export const loadSessionRaw = () => readKey<unknown>(INTERNAL.session);
export function saveSessionRaw(s: unknown): void {
  if (s === null || s === undefined) window.localStorage.removeItem(INTERNAL.session);
  else writeKey(INTERNAL.session, s);
}

/**
 * Delete everything this app keeps IN THIS BROWSER: every store, the backups, the sync bookkeeping
 * and the session. Silent on purpose — clearing a device must never empty the account as a side
 * effect. Deleting the account's copy is its own explicit action on the account page, and a running
 * sync is stopped first by the caller (`client.forgetThisBrowser`).
 *
 * Removed directly rather than through `write`: clearing always works, whatever the write fence says.
 * Then a new generation starts, so a tab still holding the old data can neither write it back into
 * the emptied browser (the next account to sign in would have uploaded it) nor go on showing it.
 */
export function clearAll(): void {
  for (const n of STORE_NAMES) window.localStorage.removeItem(KEYS[n]);
  Object.values(INTERNAL).forEach((k) => window.localStorage.removeItem(k));
  newEpoch();
}
