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

/** What the account side must be able to do. */
export interface Remote {
  pull(): Promise<RemoteRow[]>;
  /** Upsert these rows. A row with value `null` is a cleared store and is stored as such. */
  push(rows: RemoteRow[]): Promise<void>;
  /** Delete every row this user has. */
  removeAll(): Promise<void>;
}

/** What this device must be able to do. In the browser this is a thin wrapper over `storage.ts`. */
export interface LocalAccess {
  names: readonly StoreName[];
  read(name: StoreName): unknown;
  /** Last-write times per store on this device. */
  meta(): Partial<Record<StoreName, number>>;
  /** Write without announcing it as a local edit (it came from the account). */
  writeSilently(name: StoreName, value: unknown, at: number): void;
  backup(reason: string): void;
}

export interface SyncReport {
  pushed: StoreName[];
  pulled: StoreName[];
  merged: StoreName[];
  /** A backup of this device's data was taken before the account's copy replaced some of it. */
  backedUp: boolean;
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

/**
 * One full sync: pull the account, compare, back up if anything local is about to be replaced, apply
 * pulls and merges locally, then push. Pushes go LAST, so a failed network write leaves this device
 * holding everything it had plus everything it pulled — never less.
 */
export async function syncNow(local: LocalAccess, remote: Remote, now: number = Date.now()): Promise<SyncReport> {
  const rows = await remote.pull();
  const plan = planSync(localSide(local), remoteSide(rows), now);

  if (plan.needsBackup) local.backup("before syncing with your account replaced data on this device");

  const toPush: RemoteRow[] = [];
  const report: SyncReport = { pushed: [], pulled: [], merged: [], backedUp: plan.needsBackup };
  for (const a of plan.actions) apply(a, local, toPush, report);
  if (toPush.length) await remote.push(toPush);
  return report;
}

function apply(a: SyncAction, local: LocalAccess, toPush: RemoteRow[], report: SyncReport): void {
  if (a.kind === "pull") {
    local.writeSilently(a.name, a.value, a.at);
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

export type MirrorStatus = "idle" | "pending" | "saving" | "saved" | "offline";

export interface Mirror {
  /** Record one local edit. Edits to the same store within the debounce window collapse to one. */
  enqueue(name: StoreName, value: unknown, at: number): void;
  /** Send everything waiting now (used on page hide, and by tests). */
  flush(): Promise<void>;
  status(): MirrorStatus;
  stop(): void;
}

export interface MirrorOptions {
  debounceMs?: number;
  onStatus?: (s: MirrorStatus) => void;
  /** Timer injection for tests. Defaults to the global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Debounced write-through. A failed push keeps its rows queued (status `offline`) and they go out
 * with the next edit or the next `flush` — an edit made on a train is not lost, it is late.
 */
export function createMirror(remote: Remote, opts: MirrorOptions = {}): Mirror {
  const debounceMs = opts.debounceMs ?? 1500;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const queue = new Map<StoreName, RemoteRow>();
  let timer: unknown = null;
  let status: MirrorStatus = "idle";
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const set = (s: MirrorStatus) => {
    status = s;
    opts.onStatus?.(s);
  };

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (inFlight) await inFlight; // one push at a time, so rows can't land out of order
    if (queue.size === 0 || stopped) return;
    const rows = [...queue.values()];
    queue.clear();
    set("saving");
    inFlight = remote
      .push(rows)
      .then(() => set(queue.size ? "pending" : "saved"))
      .catch(() => {
        // Put them back, unless a newer edit to the same store arrived meanwhile.
        for (const r of rows) if (!queue.has(r.name)) queue.set(r.name, r);
        set("offline");
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }

  return {
    enqueue(name, value, at) {
      if (stopped) return;
      queue.set(name, { name, value, at });
      set("pending");
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    flush,
    status: () => status,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
