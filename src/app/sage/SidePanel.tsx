"use client";

import Link from "next/link";
import { useState } from "react";
import { MobileNav, SideNav } from "./SideNav";

/**
 * The forest panel, and the control that closes it.
 *
 * It collapses to a 76px icon rail rather than disappearing: the boards (sage-10, sage-12) put a
 * narrow icon rail beside the panel, so the collapsed state is a shape the design already has, and
 * a nav you cannot see is a nav you cannot get back to.
 *
 * The state is NOT persisted, on purpose. In the App Router a layout is preserved across
 * navigations within its segment, so the choice already survives every tab press — which is the
 * whole of what it needs to survive. Storing it would mean reading `localStorage` during the first
 * render (a hydration mismatch) or after it (a visible flash of the open panel on every load), and
 * neither is worth carrying for a preference that only resets on a hard refresh.
 */
export function SidePanel() {
  // CLOSED by default, at Ana's request. The rail still shows every section as an icon with its
  // name on hover, so nothing is unreachable — and it gives the page ~190px more width, which the
  // photography-led screens spend on the plate.
  const [open, setOpen] = useState(false);

  return (
    <header
      className={
        "bg-panel text-white transition-[width] duration-200 lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0 lg:flex-col lg:overflow-y-auto " +
        (open ? "lg:w-[268px]" : "lg:w-[76px]")
      }
    >
      {/* mark + the collapse control */}
      <div
        className={
          "flex items-center justify-between px-4 py-4 lg:py-7 " +
          (open ? "lg:px-6" : "lg:flex-col lg:gap-4 lg:px-0")
        }
      >
        <Link href="/sage" className="flex items-center gap-2.5" aria-label="NutriFlow home">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cream">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#26331f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 15.5c3.5 0 4.5-7 8-7s4.5 7 8 7" />
            </svg>
          </span>
          <span
            className={
              "font-serif-display text-[19px] font-semibold tracking-[-0.02em] " +
              (open ? "" : "lg:hidden")
            }
          >
            NutriFlow
          </span>
        </Link>

        {/* Mobile keeps the account dot where the toggle sits on desktop; the panel is a bar there
            and has nothing to collapse. */}
        <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-[11.5px] font-bold lg:hidden">
          A
        </span>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="sage-sections"
          className="hidden h-8 w-8 shrink-0 place-items-center rounded-[9px] text-white/60 transition hover:bg-white/10 hover:text-white lg:grid"
        >
          <span className="sr-only">{open ? "Collapse the sidebar" : "Expand the sidebar"}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M9.5 4v16" />
            {/* the chevron points the way the panel will move */}
            <path d={open ? "M6.7 10.2 5.2 12l1.5 1.8" : "M5.3 10.2 6.8 12l-1.5 1.8"} />
          </svg>
        </button>
      </div>

      <div id="sage-sections" className={"hidden lg:block " + (open ? "px-4" : "px-3")}>
        <SideNav collapsed={!open} />
      </div>
      <div className="lg:hidden">
        <MobileNav />
      </div>

      <div
        className={
          "mt-auto hidden items-center gap-2.5 py-6 lg:flex " +
          (open ? "px-6" : "flex-col px-0")
        }
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-[11.5px] font-bold">
          A
        </span>
        <Link
          href="/classic"
          className={"text-[12px] text-white/60 hover:text-white " + (open ? "" : "hidden")}
        >
          Switch to the original design
        </Link>
      </div>
    </header>
  );
}
