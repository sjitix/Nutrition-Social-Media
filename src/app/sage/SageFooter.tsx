"use client";

import { usePathname } from "next/navigation";

/**
 * The shell's footer — except on Today, which is composed to fill exactly one screen.
 *
 * A hundred and forty pixels of footer under a full-height page is the difference between a screen
 * that fits and a screen that scrolls, and on Today the thing that goes below the fold is the
 * bottom of the plate. A layout cannot see which child route is rendering, so the decision has to
 * live in a client component that can read the path.
 */
export function SageFooter() {
  const path = usePathname();
  if (path?.startsWith("/sage/today")) return null;

  return (
    <footer className="mt-24 flex flex-wrap justify-between gap-4 border-t border-line px-6 py-7 text-[12px] text-mut sm:px-10 xl:px-14">
      <span>NutriFlow — meal planning that keeps you on track</span>
      <span>Every figure computed from USDA FoodData Central</span>
    </footer>
  );
}
