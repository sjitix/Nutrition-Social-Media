/**
 * The sync rules: given what this device holds and what the account holds, decide — per store —
 * which side wins. PURE: no network, no storage, no clock (the time is passed in). Every rule here
 * is a test in `scripts/test-account.mts`.
 *
 * The model is local-first, the account a mirror (VISION → Accounts). Each store carries a value and
 * the time it was last written (ms since epoch) on whichever device wrote it.
 *
 * THE RULES
 *
 *  1. **Only one side has it → the other side gets a copy.** A store this device never wrote is
 *     pulled; a store the account never received is pushed. On a device's first sync with an empty
 *     account, that means everything uploads — signing in never starts you from nothing.
 *  2. **Both have it → the newer write wins**, whichever side it is on. Clearing a store is a write
 *     too (value `null`), so deleting something on one device deletes it everywhere.
 *  3. **Except the append-only stores, which are UNIONED** — visit history and imported recipes.
 *     A day you opened the app on your phone and a day you opened it on your laptop are both true;
 *     picking one would erase the other.
 *  4. **A tie goes to the account.** Same timestamp, different value: the account copy is the one
 *     other devices already agree on.
 *  5. **Losing local data is never silent.** If a pull would overwrite something this device holds
 *     that the account has NEVER SEEN (an edit made here since the last time the two agreed — see
 *     `synced`), the plan says `needsBackup`, and the engine snapshots local data first — so "the week
 *     on this device before you signed in" can always be put back from the account page. A pull that
 *     only replaces a value the account already had loses nothing, and takes no backup: otherwise every
 *     routine change from another device would push the important backups out.
 *
 * CLOCKS. Write times come from each device's own clock, and clocks disagree: by hours after a dual
 * boot, and by anything on a phone whose time was set by hand. Compared raw, that LOST EDITS SILENTLY.
 * A phone two hours slow stamped an edit made after it synced as older than the copy it had just
 * pulled. The next sync pulled that copy back over the edit, with no backup, because the edit also
 * looked older than the last agreement. A device a day fast locked a store against every other device
 * for a day. Both were reproduced against this engine.
 * So no write is ever stamped earlier than the value it replaces (`nextStamp`, the logical-clock rule):
 * an edit made after a device synced beats what it synced, whatever any clock says. Raw clocks now
 * decide only true conflicts, where two devices edited before either saw the other's write, and there
 * rule 5's backup is the net.
 */
import type { StoreName } from "../storage";

export interface Versioned {
  /** The store's content; `null` means it was cleared. */
  value: unknown;
  /** When it was written, ms since epoch. */
  at: number;
}

export type Side = Partial<Record<StoreName, Versioned>>;

export type SyncAction =
  /** Send this device's copy to the account. */
  | { name: StoreName; kind: "push"; value: unknown; at: number }
  /** Replace this device's copy with the account's. */
  | { name: StoreName; kind: "pull"; value: unknown; at: number }
  /** A union of both (rule 3): written locally AND sent to the account. */
  | { name: StoreName; kind: "merge"; value: unknown; at: number };

export interface SyncPlan {
  actions: SyncAction[];
  /** True when at least one pull would overwrite differing local data (rule 5). */
  needsBackup: boolean;
}

/** Stores whose history only grows, merged by union rather than newest-wins (rule 3). */
export const UNION_STORES: ReadonlySet<StoreName> = new Set<StoreName>(["visits", "imports"]);

/**
 * JSON text with every object's keys in sorted order — so two values with the same content compare
 * equal however their keys happen to be ordered.
 *
 * This is not tidiness. The account column is Postgres `jsonb`, which does NOT preserve key order: a
 * value comes back from the server with its keys re-sorted (shorter keys first). Comparing plain
 * `JSON.stringify` output made every untouched store look changed on the next sync, which took the
 * tie branch, "pulled" the identical value, took a backup each time — pushing real backups out of
 * the list — and told the person their account had newer data when nothing had changed at all.
 * Array order IS meaningful (a week's days, a newest-first history) and is kept.
 */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const isEmpty = (v: unknown) => v === null || v === undefined;

/**
 * The write time for a new write that replaces a value written at `prev`: `now`, or just after `prev`
 * if `prev` is not earlier. Every write path stamps through this (storage.ts `write`, the imports
 * history, and the merges below), so a write is always LATER than what it replaces, on any device,
 * whatever its clock says. See CLOCKS above.
 */
export function nextStamp(now: number, prev: number | undefined): number {
  return prev !== undefined && prev >= now ? prev + 1 : now;
}

/**
 * @param synced For each store, the write time this device and the account last agreed on. A local
 *   value written after that (or never synced at all) is an edit the account has not seen.
 */
export function planSync(
  local: Side,
  remote: Side,
  now: number,
  synced: Partial<Record<StoreName, number>> = {},
): SyncPlan {
  const actions: SyncAction[] = [];
  let needsBackup = false;
  const names = new Set<StoreName>([...(Object.keys(local) as StoreName[]), ...(Object.keys(remote) as StoreName[])]);

  for (const name of names) {
    const l = local[name];
    const r = remote[name];

    if (!r) {
      // Rule 1: the account has never seen it. A store cleared locally that the account never had
      // is nothing to send.
      if (l && !isEmpty(l.value)) actions.push({ name, kind: "push", value: l.value, at: l.at });
      continue;
    }
    if (!l) {
      // Rule 1, the other way round. Pulling into an empty slot overwrites nothing, so no backup.
      if (!isEmpty(r.value)) actions.push({ name, kind: "pull", value: r.value, at: r.at });
      continue;
    }
    if (same(l.value, r.value)) continue;

    if (UNION_STORES.has(name) && !isEmpty(l.value) && !isEmpty(r.value)) {
      const merged = unionStore(name, l.value, r.value);
      // If the account already holds the union, it is a plain pull. If this device does AND its copy
      // is the newer write, a plain push. Anything else is written to BOTH sides, stamped later than
      // either. A push carrying an older stamp than the account's would be skipped by the server on
      // every sync, and this store would never settle (reproduced with a device whose clock ran fast).
      if (same(merged, r.value)) actions.push({ name, kind: "pull", value: r.value, at: r.at });
      else if (same(merged, l.value) && l.at > r.at) actions.push({ name, kind: "push", value: l.value, at: l.at });
      else actions.push({ name, kind: "merge", value: merged, at: nextStamp(now, Math.max(l.at, r.at)) });
      continue;
    }

    if (l.at > r.at) {
      actions.push({ name, kind: "push", value: l.value, at: l.at });
    } else {
      // Rule 2 (remote newer) and rule 4 (a tie).
      // Rule 5: only an edit the account has never seen is worth a backup.
      if (!isEmpty(l.value) && l.at > (synced[name] ?? -Infinity)) needsBackup = true;
      actions.push({ name, kind: "pull", value: r.value, at: r.at });
    }
  }

  // A stable order makes plans comparable in tests and logs.
  actions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { actions, needsBackup };
}

/** Rule 3: the union of two copies of an append-only store, in that store's own order and cap. */
export function unionStore(name: StoreName, a: unknown, b: unknown): unknown {
  if (name === "visits") {
    const days = new Set<string>([...asArray<string>(a), ...asArray<string>(b)].filter((d) => typeof d === "string"));
    // Newest first, capped — the same shape `storage.recordVisit` keeps.
    return [...days].sort((x, y) => (x < y ? 1 : -1)).slice(0, 400);
  }
  if (name === "imports") {
    // Newest first, deduped by link, capped at 24 — the same shape `storage.rememberImport` keeps —
    // ordered by WHEN each recipe was imported (`importedAt`), not by which device's list leads.
    // Ordering by side dropped the newest import made on another device whenever this device's history
    // was full, and two devices then overwrote each other on every sync. Entries from before
    // `importedAt` existed rank after every stamped one, this device's first, in their own order.
    type Imp = { sourceUrl?: unknown; importedAt?: unknown };
    const when = (r: Imp) => (typeof r.importedAt === "number" ? r.importedAt : -1);
    const tagged = [
      ...asArray<Imp>(a).map((r, i) => ({ r, i, side: 0 })),
      ...asArray<Imp>(b).map((r, i) => ({ r, i, side: 1 })),
    ].filter((t) => t.r && typeof t.r === "object");
    const best = new Map<unknown, (typeof tagged)[number]>();
    for (const t of tagged) {
      const cur = best.get(t.r.sourceUrl);
      if (!cur || when(t.r) > when(cur.r)) best.set(t.r.sourceUrl, t);
    }
    return [...best.values()]
      .sort((x, y) => when(y.r) - when(x.r) || x.side - y.side || x.i - y.i)
      .map((t) => t.r)
      .slice(0, 24);
  }
  return a;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
