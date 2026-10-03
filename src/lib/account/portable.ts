/**
 * Your data, as a file you own: export everything this browser holds, and bring it back anywhere.
 *
 * This is milestone A1 of the accounts lane (docs/parallel/lane-accounts.md), and it is worth having
 * even after real accounts exist: it works with no keys, no server and no sign-in, so the static
 * GitHub Pages preview gets it too, and it is the honest answer to "can I take my plan with me?"
 *
 * PURE. Nothing here touches `window`: the caller hands in a reader and a writer. That is what lets
 * `scripts/test-account.mts` prove a round trip with no browser at all.
 *
 * Two rules it is built around:
 *
 *  1. **A file is untrusted input.** It may be from an older version of the app, hand-edited, or not
 *     ours at all. Every store is checked before anything is written, and one bad store rejects the
 *     WHOLE file — a half-imported week is worse than an import that politely refuses.
 *  2. **An import replaces only what the file contains.** A store the file does not mention is left
 *     alone. And the caller takes a backup first (`storage.takeBackup`), so an import is undoable.
 */
import type { StoreName } from "../storage";
import { checkStore } from "./validate";

export const EXPORT_FORMAT = "nutriflow-export";
export const EXPORT_VERSION = 1;
/** Far above any real export (a week plan is ~30 kB), far below "someone handed us a disk image". */
export const MAX_IMPORT_BYTES = 5_000_000;

/** Every store a file may carry. Mirrors `storage.STORE_NAMES`, written out so this file stays pure. */
export const PORTABLE_STORES: readonly StoreName[] = [
  "profile", "plan", "batchPlan", "chat", "imports", "saved", "groceriesChecked", "visits",
];

export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  data: Partial<Record<StoreName, unknown>>;
}

/** Collect every non-empty store into one bundle. */
export function buildExport(read: (name: StoreName) => unknown, now: Date = new Date()): ExportBundle {
  const data: Partial<Record<StoreName, unknown>> = {};
  for (const n of PORTABLE_STORES) {
    const v = read(n);
    if (v !== null && v !== undefined) data[n] = v;
  }
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), data };
}

/** `nutriflow-2026-10-03.json` — dated, so two exports on two days never overwrite each other. */
export function exportFilename(now: Date = new Date()): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return `nutriflow-${d}.json`;
}

/* ------------------------------------------------------------------------------------------------
 * Validation lives in validate.ts — ONE checker per store, shared with sync, so a value is held to the
 * same standard whether it arrives in a file or from the account.
 * ---------------------------------------------------------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const STORE_LABEL: Record<StoreName, string> = {
  profile: "your profile", plan: "your week plan", batchPlan: "your meal-prep week", chat: "your chat history",
  imports: "your imported recipes", saved: "your saved recipes", groceriesChecked: "your ticked groceries",
  visits: "your visit history",
};

export type ParseResult =
  | { ok: true; bundle: ExportBundle; stores: StoreName[]; warnings: string[] }
  | { ok: false; error: string };

/** Read a file's text and decide whether it can be imported. Writes nothing. */
export function parseExport(text: string): ParseResult {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: "That file is far too large to be a NutriFlow export." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a NutriFlow export — it isn't even readable as data." };
  }
  if (!isObj(raw) || raw.format !== EXPORT_FORMAT) {
    return { ok: false, error: "That file isn't a NutriFlow export." };
  }
  if (typeof raw.version !== "number" || raw.version > EXPORT_VERSION) {
    return { ok: false, error: "That export was made by a newer version of NutriFlow than this one. Update the app and try again." };
  }
  if (!isObj(raw.data)) return { ok: false, error: "That export has no data in it." };

  const warnings: string[] = [];
  const data: Partial<Record<StoreName, unknown>> = {};
  for (const [key, value] of Object.entries(raw.data)) {
    if (!(PORTABLE_STORES as readonly string[]).includes(key)) {
      // Not fatal: a future version may add a store. Say so rather than silently dropping it.
      warnings.push(`Skipped "${key}", which this version of the app doesn't know about.`);
      continue;
    }
    const name = key as StoreName;
    // A cleared store (null) is fine as an ACCOUNT row, where it is a deliberate clear. In a file it is
    // never genuine, since `buildExport` leaves cleared stores out, and importing it would delete that
    // store here and, when signed in, on every device, while the preview said nothing (review 2).
    if (value === null) return { ok: false, error: `Nothing was imported: the file would clear ${STORE_LABEL[name]}, which a real export never does.` };
    const problem = checkStore(name, value);
    if (problem) return { ok: false, error: `Nothing was imported: ${problem}.` };
    data[name] = value;
  }
  const stores = Object.keys(data) as StoreName[];
  if (stores.length === 0) return { ok: false, error: "That export is empty — there is nothing to bring in." };

  return {
    ok: true,
    bundle: {
      format: EXPORT_FORMAT,
      version: raw.version,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      data,
    },
    stores,
    warnings,
  };
}

/** Write a parsed bundle's stores. Stores the file does not carry are left exactly as they were. */
export function applyImport(bundle: ExportBundle, write: (name: StoreName, value: unknown) => void): StoreName[] {
  const written: StoreName[] = [];
  for (const n of PORTABLE_STORES) {
    if (n in bundle.data) {
      write(n, bundle.data[n]);
      written.push(n);
    }
  }
  return written;
}

/**
 * What a set of stores amounts to, in plain words — for "this file holds…" and "this browser
 * holds…". Counts are read off the data, never assumed.
 *
 * `incoming`: the data is a file about to be brought in. Then an EMPTY list it carries is named too,
 * with what it will do, because bringing it in clears that list here (and, when signed in, on every
 * device). Real exports carry empty lists (a reset chat, the last recipe unsaved), and a preview that
 * skipped them, as this one did, let an import wipe data it never mentioned (review 2).
 */
export function describeData(data: Partial<Record<StoreName, unknown>>, opts: { incoming?: boolean } = {}): string[] {
  const out: string[] = [];
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const days = (v: unknown) => (isObj(v) && Array.isArray(v.days) ? v.days.length : 0);
  if (isObj(data.profile)) {
    const p = data.profile;
    const name = typeof p.name === "string" && p.name.trim() ? `${p.name.trim()}'s profile` : "your profile";
    out.push(`${name} (${p.targetCalories} kcal a day)`);
  }
  if (data.plan) out.push(`a week plan (${days(data.plan)} days)`);
  if (data.batchPlan) out.push(`a meal-prep week (${days(data.batchPlan)} days)`);
  const list = (name: StoreName, noun: string, none: string, tail = "") => {
    const n = len(data[name]);
    if (n) out.push(plural(n, noun, tail));
    else if (opts.incoming && Array.isArray(data[name])) out.push(`${none} (bringing it in clears ${STORE_LABEL[name]} here)`);
  };
  list("saved", "saved recipe", "no saved recipes");
  list("imports", "imported recipe", "no imported recipes");
  list("chat", "chat message", "no chat messages");
  list("groceriesChecked", "ticked grocery item", "no ticked grocery items");
  list("visits", "day", "no visit history", "of visit history");
  return out;
}

function plural(n: number, noun: string, tail = ""): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}${tail ? ` ${tail}` : ""}`;
}
