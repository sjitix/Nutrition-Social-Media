/**
 * The original layout's violet/sage theme choice: a per-device display preference, so it is neither
 * synced nor exported. The key keeps its original spelling and its value stays a plain string, so every
 * browser that already chose a theme keeps it.
 *
 * WHY THIS IS ITS OWN MODULE, NOT PART OF storage.ts: the root layout's ThemeSwitch needs only these
 * three names, and every page loads the root layout. While they lived in storage.ts, every page loaded
 * the whole of storage.ts (and account/merge with it) for them. Splitting it out took 3.16 kB gz off
 * "/", the first page every visitor loads, and off "/_not-found" and "/recipes" (2d9e024: both sides
 * built in one folder with one node_modules, every loaded file's gzip summed). storage.ts re-exports
 * this file, so `@/lib/persistence` still offers all three names, and with `"sideEffects": ["*.css"]`
 * the bundler links them straight here without loading storage.ts. Import nothing into this file:
 * whatever it imports, every page pays for.
 *
 * It is the second module allowed to name a storage key (check:boundaries rule 3). It owns this one key
 * and no other, and storage.ts must never spell it again.
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
