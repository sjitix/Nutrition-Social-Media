import type { ChatMessage, UserProfile, WeekPlan } from "./types";
import type { ImportedRecipe } from "./import";

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
 * - `meta`    — when each store was last written on this device (ms since epoch). Sync compares it
 *               with the account's copy to decide which side is newer.
 * - `backup`  — one snapshot of every store, taken immediately before something replaces local data
 *               wholesale (importing a file, or the first sync on a device). It is what makes those
 *               two actions undoable, so neither can cost someone the week they already had.
 * - `session` — the signed-in account's tokens. A credential: never exported, never synced.
 */
const INTERNAL = {
  meta: "nutriflow.meta",
  backup: "nutriflow.backup",
  session: "nutriflow.session",
} as const;

/** The names of the user-data stores. This list IS the contract with the export file and the server. */
export type StoreName = keyof typeof KEYS;
export const STORE_NAMES = Object.keys(KEYS) as StoreName[];

const IMPORTS_CAP = 24;
const VISITS_CAP = 400; // ~13 months of daily-use history is plenty for a streak

function readKey<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
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

/**
 * The one write path for user data. Every save below goes through here, so the timestamp and the
 * change event cannot be forgotten by a save function added later.
 *
 * `silent` is for writes that must not be announced as local edits: a value that came FROM the
 * account (it carries the account's timestamp — announcing it would push it straight back), and
 * clearing this browser (which must never reach out and empty the account as a side effect).
 */
function write(name: StoreName, value: unknown, opts: { at?: number; silent?: boolean } = {}): void {
  const at = opts.at ?? Date.now();
  if (value === null || value === undefined) window.localStorage.removeItem(KEYS[name]);
  else writeKey(KEYS[name], value);
  stamp(name, at);
  if (!opts.silent) for (const fn of listeners) fn({ name, value: value ?? null, at });
}

const read = <T>(name: StoreName) => readKey<T>(KEYS[name]);

/** Raw read of one store, for export and sync. Screens use the typed loaders below. */
export function readStore(name: StoreName): unknown {
  return read<unknown>(name);
}

/**
 * Raw write of one store, for import and sync. `null` clears it. Validation is the CALLER's job —
 * `src/lib/account/portable.ts` checks a file before anything from it reaches here.
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
// re-add something they imported before without re-fetching it.
export const loadImports = () => read<ImportedRecipe[]>("imports") ?? [];
export function rememberImport(r: ImportedRecipe): ImportedRecipe[] {
  const rest = loadImports().filter((x) => x.sourceUrl !== r.sourceUrl);
  const next = [r, ...rest].slice(0, IMPORTS_CAP);
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
 * The safety net: one backup snapshot, and deleting everything.
 * ---------------------------------------------------------------------------------------------- */

export interface LocalBackup {
  /** Why it was taken, in words the account page can show ("before importing a file"). */
  reason: string;
  takenAt: number;
  data: Partial<Record<StoreName, unknown>>;
}

/** Snapshot every user-data store before something replaces them. Overwrites the previous backup. */
export function takeBackup(reason: string): LocalBackup {
  const data: Partial<Record<StoreName, unknown>> = {};
  for (const n of STORE_NAMES) {
    const v = read<unknown>(n);
    if (v !== null) data[n] = v;
  }
  const backup: LocalBackup = { reason, takenAt: Date.now(), data };
  writeKey(INTERNAL.backup, backup);
  return backup;
}

export const loadBackup = () => readKey<LocalBackup>(INTERNAL.backup);

export function discardBackup(): void {
  window.localStorage.removeItem(INTERNAL.backup);
}

/**
 * Put the backup back: every store returns to exactly what it held, including stores that were
 * EMPTY then (they are cleared now). The restore is itself a local edit, so it syncs like one.
 */
export function restoreBackup(): boolean {
  const b = loadBackup();
  if (!b) return false;
  for (const n of STORE_NAMES) write(n, b.data[n] ?? null);
  discardBackup();
  return true;
}

/** The signed-in session, kept here so this stays the only module that names a storage key. */
export const loadSessionRaw = () => readKey<unknown>(INTERNAL.session);
export function saveSessionRaw(s: unknown): void {
  if (s === null || s === undefined) window.localStorage.removeItem(INTERNAL.session);
  else writeKey(INTERNAL.session, s);
}

/**
 * Delete everything this app keeps IN THIS BROWSER: every store, the backup, the sync bookkeeping
 * and the session. Silent on purpose — clearing a device must never empty the account as a side
 * effect. Deleting the account's copy is its own explicit action on the account page.
 */
export function clearAll(): void {
  for (const n of STORE_NAMES) write(n, null, { silent: true });
  Object.values(INTERNAL).forEach((k) => window.localStorage.removeItem(k));
}
