"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { saveTheme, THEME_STORAGE_KEY } from "@/lib/persistence";

/**
 * Switches between the original violet skin and the sage one.
 *
 * There is no second copy of the app. Both skins are the same components: every
 * colour goes through the eleven tokens in globals.css, and `theme-sage` on
 * <html> redefines them. So this toggles one class and ~291 utility usages
 * follow. The original is the default and is never modified.
 *
 * The choice is stored so it survives navigation, and `applyStoredTheme` runs
 * from a blocking script in <head> so a returning sage user never sees a violet
 * flash before hydration. persistence/storage.ts owns the key and the write, as it
 * owns every key (check:boundaries rule 3); the key keeps its original spelling, so
 * every browser that already chose a theme keeps its choice.
 */
const SAGE = "theme-sage";

export function ThemeSwitch() {
  const [sage, setSage] = useState(false);
  const path = usePathname();

  // Read the class the head script already applied, rather than localStorage, so
  // state matches what is on screen even if the two ever disagree.
  useEffect(() => {
    setSage(document.documentElement.classList.contains(SAGE));
  }, []);

  // Not on the sage routes. They pin their own theme, so the toggle there was a floating pill
  // reading "Violet" that changed nothing visible — and it sat on top of the layout. It is also
  // visible in the screenshots committed for Midjourney's --sref.
  if (path?.startsWith("/sage") || path?.startsWith("/today")) return null;

  function toggle() {
    const next = !sage;
    setSage(next);
    document.documentElement.classList.toggle(SAGE, next);
    // Private mode or blocked storage: saveTheme swallows the error, so the theme still
    // applies for this page and is simply not remembered. Not worth failing the click over.
    saveTheme(next ? "sage" : "violet");
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={sage}
      title={sage ? "Switch to the original violet theme" : "Switch to the sage theme"}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-line bg-white px-4 py-2.5 text-xs font-semibold text-plum card-shadow transition hover:border-vio focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vio"
    >
      <span
        aria-hidden
        className="h-3 w-3 rounded-full border border-line"
        style={{ background: sage ? "#3d5233" : "#675ce0" }}
      />
      {sage ? "Sage" : "Violet"}
    </button>
  );
}

/**
 * Inlined into <head> so it runs before first paint. Kept as a string because a
 * React component cannot execute early enough to prevent the flash.
 */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem('${THEME_STORAGE_KEY}')==='sage')document.documentElement.classList.add('${SAGE}')}catch(e){}`;
