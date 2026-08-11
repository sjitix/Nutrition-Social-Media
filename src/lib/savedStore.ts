"use client";

import { useCallback, useEffect, useState } from "react";
import { loadSaved, toggleSaved } from "./storage";

/**
 * Where a saved recipe lives.
 *
 * This is the seam between "saving works" and "saving works in your account". The UI only ever
 * calls `list`, `add` and `remove`; it never learns which implementation answered. Swapping the
 * browser for a hosted database is then one file, not a rewrite of Explore.
 *
 * EVERY METHOD IS ASYNC, including the local one that has no reason to be. That is the whole point:
 * a synchronous interface would have to change shape the moment a network sits behind it, and every
 * call site would change with it. Paying for the promise now costs nothing and makes the account
 * swap invisible.
 *
 * A recipe is stored by NAME, matching `RECIPE_IMAGES` and `lockedMeals` — the library has no
 * stable public id, and a name is what the rest of the app already keys on.
 */
export interface SavedStore {
  /** Where these saves are being kept, so the interface can say so out loud. */
  readonly kind: "local" | "account";
  list(): Promise<string[]>;
  add(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * The browser implementation, and the one in use until Supabase keys exist.
 *
 * It is not a placeholder — it stays as the fallback forever, because the GitHub Pages preview is
 * a static export with no server and must keep working, and because someone who has not signed in
 * should still be able to save things.
 *
 * IT DELEGATES TO `storage.ts` RATHER THAN OWNING A KEY. The first version of this file wrote
 * `nutriflow:saved` while `storage.ts` already owned `nutriflow.saved`, which `/plan`'s meal drawer
 * reads — so a recipe saved on Explore was invisible to the rest of the app, and the two lists
 * would have drifted apart forever. One concept, one key, one place that knows its name.
 */
export const localSavedStore: SavedStore = {
  kind: "local",
  async list() {
    if (typeof window === "undefined") return [];
    // Anything could be in localStorage — an older version of this app, or a hand-edited value.
    const raw: unknown = loadSaved();
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  },
  async add(name) {
    if ((await this.list()).includes(name)) return;
    toggleSaved(name);
  },
  async remove(name) {
    if (!(await this.list()).includes(name)) return;
    toggleSaved(name);
  },
};

/**
 * The store the app should use. Today it is always the local one; when Supabase is configured this
 * returns the account-backed store for a signed-in reader and the local one otherwise.
 */
export function savedStore(): SavedStore {
  return localSavedStore;
}

/**
 * Saved names plus a toggle, for a client component.
 *
 * Two things it does deliberately:
 *
 * 1. **It reports `loaded`, and nothing writes before it is true.** WORKPLAN records this exact bug
 *    shipping once: the grocery list's persist effect ran against an empty array before the source
 *    had loaded and overwrote localStorage with `[]`, silently wiping every check-off on reload.
 *    An effect that persists derived state must not run before its source exists.
 * 2. **The toggle is optimistic and rolls back.** Against localStorage that is invisible, but
 *    against a network a save that only appears after a round trip feels broken — and one that
 *    appears and then silently fails is worse. The UI updates immediately and reverts if the write
 *    throws.
 */
export function useSaved() {
  const [names, setNames] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [store] = useState(savedStore);

  useEffect(() => {
    let alive = true;
    store.list().then((list) => {
      if (!alive) return;
      setNames(new Set(list));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [store]);

  const toggle = useCallback(
    async (name: string) => {
      if (!loaded) return; // never write a guess over real data
      const had = names.has(name);
      const next = new Set(names);
      if (had) next.delete(name);
      else next.add(name);
      setNames(next);
      try {
        if (had) await store.remove(name);
        else await store.add(name);
      } catch {
        setNames(names); // put it back; the write did not happen
      }
    },
    [loaded, names, store],
  );

  return { names, loaded, toggle, kind: store.kind };
}
