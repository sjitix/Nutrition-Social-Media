"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

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
 * flash before hydration.
 */
const KEY = "nutriflow-theme";
const SAGE = "theme-sage";

export function ThemeSwitch() {
  const [sage, setSage] = useState(false);
  const path = usePathname();

  // Read the class the head script already applied, rather than localStorage, so
  // state matches what is on screen even if the two ever disagree.
  useEffect(() => {
    setSage(document.documentElement.classList.contains(SAGE));
  }, []);

  // Not on /sage. That subtree pins its own theme, so the toggle there was a floating pill
  // reading "Violet" that changed nothing visible — and it sat on top of the sidebar footer.
  // It is also visible in the screenshots committed for Midjourney's --sref.
  if (path?.startsWith("/sage")) return null;

  function toggle() {
    const next = !sage;
    setSage(next);
    document.documentElement.classList.toggle(SAGE, next);
    try {
      localStorage.setItem(KEY, next ? "sage" : "violet");
    } catch {
      // Private mode or blocked storage: the theme still applies for this page,
      // it just will not be remembered. Not worth failing the click over.
    }
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
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem('${KEY}')==='sage')document.documentElement.classList.add('${SAGE}')}catch(e){}`;
