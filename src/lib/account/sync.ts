/**
 * The sync engine: carry out `planSync`'s decisions, and keep the account mirrored as you edit.
 *
 * Both ends are INJECTED — `LocalAccess` (in the browser, `storage.ts`) and `Remote` (in the browser,
 * the Supabase REST adapter in `supabase.ts`). Nothing here imports either directly, which is what lets
 * `scripts/test-account.mts` run a full sync between two fake devices and a fake server with no
 * browser and no network. Same reason `agentLoop.ts` takes its model as a `ModelFn`.
 */
import { planSync, type Side, type SyncAction } from "./merge";
import type { StoreName } from "../storage";

/** One stored row on the account side. */
export interface RemoteRow {
  name: StoreName;
  value: unknown;
  at: number;
}

/**
 * What a push reports back. `skipped` names rows the account did NOT take because it already held a
 * NEWER write for that store (the server compares `updated_at`, see supabase/migrations/0002). Those
 * are not failures and not refusals: this device was simply behind, and must pull before it pushes
 * that store again.
 */
export interface PushResult {
  skipped?: StoreName[];
}

/** What the account side must be able to do. */
export interface Remote {
  pull(): Promise<RemoteRow[]>;
  /** Write these rows, each only if it is newer than the account's copy. `null` is a cleared store. */
  push(rows: RemoteRow[]): Promise<void | PushResult>;
  /** Delete every row this user has. */
  removeAll(): Promise<void>;
}

/** What this device must be able to do. In the browser this is a thin wrapper over `storage.ts`. */
export interface LocalAccess {
  names: readonly StoreName[];
  read(name: StoreName): unknown;
  /** Last-write times per store on this device. */
  meta(): Partial<Record<StoreName, number>>;
  /** For each store, the write time this device and the account last agreed on (see storage.ts). */
  syncedAt(): Partial<Record<StoreName, number>>;
  /** Record that the account now holds this store as written at `at`. */
  markSynced(name: StoreName, at: number): void;
  /** Write without announcing it as a local edit (it came from the account). */
  writeSilently(name: StoreName, value: unknown, at: number): void;
  backup(reason: string): void;
  /**
   * May a value that came FROM THE ACCOUNT be written into this store? Optional; without it every
   * value is accepted. In the browser this is `validate.checkStore` — the account is outside this
   * browser, and one malformed row must not be able to break a screen on every device.
   */
  accepts?(name: StoreName, value: unknown): boolean;
}

export interface SyncReport {
  pushed: StoreName[];
  pulled: StoreName[];
  merged: StoreName[];
  /** A backup of this device's data was taken before the account's copy replaced some of it. */
  backedUp: boolean;
  /** Stores too large to keep in the account. They stay on this device; everything else synced. */
  tooLarge: StoreName[];
  /** Stores the account refused outright. They stay on this device; everything else synced. */
  refused: StoreName[];
  /** Stores whose ACCOUNT copy failed validation and was not written here; this device kept its own. */
  invalid: StoreName[];
  /** Stores the account already held a newer write for when this device pushed; pull before pushing again. */
  skipped: StoreName[];
  /** The sync was cancelled after the pull (this browser was cleared or signed out meanwhile); nothing was applied. */
  cancelled?: boolean;
}

/**
 * The most a single store may weigh when sent to the account, in UTF-8 bytes (`storeBytes`). The
 * database refuses a store whose jsonb is 1 MB or more (supabase/migrations: user_state_value_size);
 * this sits safely under it. A week plan is ~30 kB, so in practice only an enormous chat history,
 * which nothing caps, could reach it.
 *
 * WHY IT IS CHECKED HERE, BEFORE SENDING: an oversized store would otherwise be uploaded only to be
 * refused, and then uploaded again on every later edit, because an edit retries a held store. Once
 * `pushOrIsolate` existed it could no longer block the other stores, but it would still cost an upload
 * of up to a megabyte per chat message.
 *
 * WHY BYTES, NOT `.length`: `.length` counts UTF-16 units, and the server counts bytes. Measured in
 * real Postgres, a chat's stored jsonb is within 3% of its UTF-8 size in English, Arabic and Japanese
 * alike, but 1.8× its `.length` in Arabic and 2.9× in Japanese. So `.length` waved a non-Latin chat
 * through, and the server then refused it. Number-heavy JSON costs more as jsonb (a plan-shaped store
 * is 1.44× its text), but those stores are small. One that crossed the line anyway would still be
 * refused and held by `pushOrIsolate`.
 */
export const MAX_STORE_BYTES = 900_000;

/** A store's size as the server will count it, near enough: its JSON, in UTF-8 bytes. */
export function storeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** An error that says the server REFUSED this request (duck-typed: sync.ts imports no adapter). */
function isRefusal(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "rejected";
}

/**
 * Push rows, and if the server REFUSES the batch, find out which store it refused.
 *
 * PostgREST sends a batch as one statement, so one store the database won't accept (a value it
 * can't store) fails them all. Retried as-is, that batch would fail forever and silently block every
 * other store. So on a refusal each row is sent alone: the ones accepted are saved, and the names of
 * the ones refused come back for the caller to report. A network or server failure is NOT a
 * refusal — it is rethrown untouched, so the caller keeps the rows queued and tries again later.
 */
export async function pushOrIsolate(remote: Remote, rows: RemoteRow[]): Promise<{ refused: StoreName[]; skipped: StoreName[] }> {
  const skippedOf = (r: void | PushResult) => (r && Array.isArray(r.skipped) ? r.skipped : []);
  try {
    return { refused: [], skipped: skippedOf(await remote.push(rows)) };
  } catch (e) {
    if (!isRefusal(e)) throw e;
    if (rows.length === 1) return { refused: [rows[0].name], skipped: [] };
    const refused: StoreName[] = [];
    const skipped: StoreName[] = [];
    for (const r of rows) {
      try {
        skipped.push(...skippedOf(await remote.push([r])));
      } catch (e2) {
        if (isRefusal(e2)) refused.push(r.name);
        else throw e2;
      }
    }
    return { refused, skipped };
  }
}

/** Split rows into those safe to send and those too large for the account. */
export function partitionBySize(rows: RemoteRow[]): { ok: RemoteRow[]; tooLarge: StoreName[] } {
  const ok: RemoteRow[] = [];
  const tooLarge: StoreName[] = [];
  for (const r of rows) {
    if (r.value !== null && r.value !== undefined && storeBytes(r.value) > MAX_STORE_BYTES) tooLarge.push(r.name);
    else ok.push(r);
  }
  return { ok, tooLarge };
}

/** This device's side of the comparison: every store it has ever written. */
export function localSide(local: LocalAccess): Side {
  const meta = local.meta();
  const side: Side = {};
  for (const name of local.names) {
    const value = local.read(name);
    const at = meta[name];
    // A store with data but no timestamp predates sync bookkeeping (written by an older version of
    // the app). It is real data of unknown age: treat it as written at the dawn of time, so an
    // account copy wins — but rule 5 still backs it up before replacing it.
    if (value !== null && value !== undefined) side[name] = { value, at: at ?? 0 };
    else if (at !== undefined) side[name] = { value: null, at }; // cleared here, on purpose
  }
  return side;
}

export function remoteSide(rows: RemoteRow[]): Side {
  const side: Side = {};
  for (const r of rows) side[r.name] = { value: r.value, at: r.at };
  return side;
}

export interface SyncOptions {
  now?: number;
  /**
   * Checked right after the pull returns: if it says no (this browser was cleared, signed out or
   * switched account while the request was in flight), nothing is applied and nothing is pushed. A
   * pull landing after "delete everything in this browser" must not refill the browser.
   */
  stillCurrent?: () => boolean;
}

/**
 * One full sync: pull the account, compare, back up if anything local is about to be replaced, apply
 * pulls and merges locally, then push. Pushes go LAST, so a failed network write leaves this device
 * holding everything it had plus everything it pulled — never less.
 *
 * ORDERING THAT MATTERS: the local side is read AFTER `await remote.pull()`, and nothing between that
 * read and applying the pulls awaits. JavaScript runs that stretch without interruption, so a local
 * edit can never land between "decided to pull X" and "wrote X" and be silently overwritten. An edit
 * made while the final push is in flight is newer than everything here and goes out through the
 * mirror. A test pins this ("an edit made DURING the pull survives").
 */
export async function syncNow(local: LocalAccess, remote: Remote, opts: SyncOptions | number = {}): Promise<SyncReport> {
  const o: SyncOptions = typeof opts === "number" ? { now: opts } : opts;
  const report: SyncReport = { pushed: [], pulled: [], merged: [], backedUp: false, tooLarge: [], refused: [], invalid: [], skipped: [] };
  const rows = await remote.pull();
  if (o.stillCurrent && !o.stillCurrent()) return { ...report, cancelled: true };
  const plan = planSync(localSide(local), remoteSide(rows), o.now ?? Date.now(), local.syncedAt());

  if (plan.needsBackup) local.backup("before syncing with your account replaced data on this device");
  report.backedUp = plan.needsBackup;

  const toPush: RemoteRow[] = [];
  for (const a of plan.actions) apply(a, local, toPush, report);
  const { ok, tooLarge } = partitionBySize(toPush);
  report.tooLarge = tooLarge;
  if (ok.length) {
    const res = await pushOrIsolate(remote, ok);
    report.refused = res.refused;
    report.skipped = res.skipped;
  }
  const heldBack = new Set<StoreName>([...tooLarge, ...report.refused, ...report.skipped]);
  for (const r of ok) if (!heldBack.has(r.name)) local.markSynced(r.name, r.at);
  report.pushed = report.pushed.filter((n) => !heldBack.has(n));
  report.merged = report.merged.filter((n) => !heldBack.has(n));
  return report;
}

function apply(a: SyncAction, local: LocalAccess, toPush: RemoteRow[], report: SyncReport): void {
  // A value coming DOWN must pass validation before it is written. If it fails, this device keeps its
  // own copy, nothing is pushed in its place (the account copy may be from a newer app version this one
  // simply cannot read), and the report names the store.
  if ((a.kind === "pull" || a.kind === "merge") && local.accepts && !local.accepts(a.name, a.value)) {
    report.invalid.push(a.name);
    return;
  }
  if (a.kind === "pull") {
    local.writeSilently(a.name, a.value, a.at);
    local.markSynced(a.name, a.at); // what we now hold IS the account's copy
    report.pulled.push(a.name);
  } else if (a.kind === "push") {
    toPush.push({ name: a.name, value: a.value, at: a.at });
    report.pushed.push(a.name);
  } else {
    local.writeSilently(a.name, a.value, a.at);
    toPush.push({ name: a.name, value: a.value, at: a.at });
    report.merged.push(a.name);
  }
}

/* ------------------------------------------------------------------------------------------------
 * The live mirror: after the first sync, every local edit is sent up shortly after it happens.
 * ---------------------------------------------------------------------------------------------- */

export type MirrorStatus = "idle" | "pending" | "saving" | "saved" | "offline" | "error";

/** Why a store is being kept on this device only. */
export type HeldReason = "too-large" | "refused";

export interface Mirror {
  /** Record one local edit. Edits to the same store within the debounce window collapse to one. */
  enqueue(name: StoreName, value: unknown, at: number): void;
  /** Send everything waiting now (used on page hide, and by tests). Does nothing while paused. */
  flush(): Promise<void>;
  /** Start sending. Until then edits are only queued (see `startPaused`). */
  resume(): void;
  /** How many edits are waiting to be sent. */
  queued(): number;
  /** Forget queued edits the account already holds (written at or before its `synced` time). */
  dropSynced(synced: Partial<Record<StoreName, number>>): void;
  status(): MirrorStatus;
  /** Stores currently kept on this device only, and why. */
  held(): ReadonlyMap<StoreName, HeldReason>;
  /** Record what a full sync found (held back, or safely in the account). */
  hold(name: StoreName, why: HeldReason): void;
  release(name: StoreName): void;
  stop(): void;
}

export interface MirrorOptions {
  debounceMs?: number;
  /**
   * Queue edits but send nothing until `resume()`. The browser starts the mirror paused and resumes it
   * only after the first full sync succeeds: before that, this device has not seen the account's data,
   * and pushing a whole store built on a stale copy would overwrite newer edits from other devices
   * without the comparison, union or backup a full sync gives them.
   */
  startPaused?: boolean;
  onStatus?: (s: MirrorStatus) => void;
  /** Hears every failed push, so the caller can act on WHY (an expired sign-in is not "offline"). */
  onError?: (e: unknown) => void;
  /** Hears the held-back set every time it changes, so the caller can name what isn't syncing. */
  onHeld?: (held: ReadonlyMap<StoreName, HeldReason>) => void;
  /** Hears rows the account accepted, so the caller can mark them in sync. */
  onSaved?: (rows: RemoteRow[]) => void;
  /** Hears stores the account skipped because it held a newer write: the caller should run a full sync. */
  onStale?: (names: StoreName[]) => void;
  /** Timer injection for tests. Defaults to the global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** A thrown error that says retrying the same thing cannot help (duck-typed: sync.ts imports no adapter). */
function isPermanent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { retryable?: unknown }).retryable === false;
}

/**
 * Debounced write-through.
 *  - A push that fails for a TRANSIENT reason (offline, a busy server) keeps its rows queued and they go
 *    out with the next edit or flush — an edit made on a train is late, not lost. Status `offline`.
 *  - A store the account cannot take — too large, or REFUSED by the server — is held back so it can't
 *    block the others (`pushOrIsolate`), and stays named in `held()` until a later edit of it gets
 *    through. Status `error` while anything is held, because waiting will not fix it.
 *  - A row the account SKIPPED because it held a newer write is reported through `onStale`, so the
 *    caller can pull first; it is not re-sent blindly.
 */
export function createMirror(remote: Remote, opts: MirrorOptions = {}): Mirror {
  const debounceMs = opts.debounceMs ?? 1500;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const queue = new Map<StoreName, RemoteRow>();
  const heldBack = new Map<StoreName, HeldReason>();
  let timer: unknown = null;
  let status: MirrorStatus = "idle";
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let paused = opts.startPaused ?? false;

  const set = (s: MirrorStatus) => {
    status = s;
    opts.onStatus?.(s);
  };
  const heldChanged = () => opts.onHeld?.(new Map(heldBack));
  const hold = (name: StoreName, why: HeldReason) => {
    if (heldBack.get(name) === why) return;
    heldBack.set(name, why);
    heldChanged();
  };
  const release = (name: StoreName) => {
    if (heldBack.delete(name)) heldChanged();
  };
  /** After a flush: something waiting → pending; something held back → error; otherwise saved. */
  const settled = () => set(queue.size ? "pending" : heldBack.size ? "error" : "saved");

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (inFlight) await inFlight; // one push at a time, so rows can't land out of order
    if (queue.size === 0 || stopped || paused) return;
    const { ok, tooLarge } = partitionBySize([...queue.values()]);
    queue.clear();
    for (const n of tooLarge) hold(n, "too-large");
    if (!ok.length) {
      settled();
      return;
    }
    set("saving");
    inFlight = pushOrIsolate(remote, ok)
      .then(({ refused, skipped }) => {
        for (const n of refused) hold(n, "refused");
        const accepted = ok.filter((r) => !refused.includes(r.name) && !skipped.includes(r.name));
        for (const r of accepted) release(r.name);
        if (accepted.length) opts.onSaved?.(accepted);
        if (skipped.length) opts.onStale?.(skipped);
        settled();
      })
      .catch((e: unknown) => {
        // Transient: put them back, unless a newer edit to the same store arrived meanwhile.
        for (const r of ok) if (!queue.has(r.name)) queue.set(r.name, r);
        opts.onError?.(e);
        set(isPermanent(e) ? "error" : "offline");
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }

  return {
    held: () => heldBack,
    hold,
    release,
    enqueue(name, value, at) {
      if (stopped) return;
      queue.set(name, { name, value, at });
      if (paused) return; // queued; sent when the first full sync has succeeded
      set("pending");
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    flush,
    resume() {
      if (!paused || stopped) return;
      paused = false;
      if (queue.size) void flush();
    },
    queued: () => queue.size,
    dropSynced(synced) {
      for (const [name, row] of queue) {
        const s = synced[name];
        if (s !== undefined && row.at <= s) queue.delete(name);
      }
    },
    status: () => status,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
