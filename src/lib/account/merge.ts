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
 *     (and it differs), the plan says `needsBackup`, and the engine snapshots local data first — so
 *     "the week on this device before you signed in" can always be put back from the account page.
 *
 * Clock skew between devices can mis-order two edits made within seconds of each other on different
 * machines. For one person's meal plan that is an acceptable trade for a model this simple; the
 * backup in rule 5 is the net under it.
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = (v: unknown) => v === null || v === undefined;

export function planSync(local: Side, remote: Side, now: number): SyncPlan {
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
      // If the union is just one side, it is a plain push or pull — no need to write both.
      if (same(merged, r.value)) actions.push({ name, kind: "pull", value: r.value, at: r.at });
      else if (same(merged, l.value)) actions.push({ name, kind: "push", value: l.value, at: l.at });
      else actions.push({ name, kind: "merge", value: merged, at: now });
      continue;
    }

    if (l.at > r.at) {
      actions.push({ name, kind: "push", value: l.value, at: l.at });
    } else {
      // Rule 2 (remote newer) and rule 4 (a tie).
      if (!isEmpty(l.value)) needsBackup = true;
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
    // Newest first, deduped by link, capped at 24 — the same shape `storage.rememberImport` keeps.
    // The local copy leads, so the import made most recently on THIS device stays at the top.
    const out: { sourceUrl?: unknown }[] = [];
    const seen = new Set<unknown>();
    for (const r of [...asArray<{ sourceUrl?: unknown }>(a), ...asArray<{ sourceUrl?: unknown }>(b)]) {
      if (!r || seen.has(r.sourceUrl)) continue;
      seen.add(r.sourceUrl);
      out.push(r);
    }
    return out.slice(0, 24);
  }
  return a;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
