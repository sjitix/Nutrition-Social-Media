"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MobileNav, SideNav } from "./SideNav";
import { loadProfile } from "@/lib/storage";
import { switchPlanMode, switchBatchCadence } from "./myPlan";

// Planning-mode icons (SVG only — no emoji). Fresh = a single plated dish; Prep = a pot.
const IconFresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="8.2" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const IconPrep = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 11h14l-1 6.6A2 2 0 0 1 16 19.5H8A2 2 0 0 1 6 17.6L5 11Z" /><path d="M8 11a4 4 0 0 1 8 0" /><path d="M9 5.4 8.2 7.6M15 5.4 15.8 7.6" />
  </svg>
);

/**
 * The sidebar, and the control that closes it.
 *
 * `sage-07`'s treatment: the same sage family as the page, separated by a hairline, rather than
 * the deep forest block of `sage-10`/`sage-12`. Both are in the reference set; this is the lighter
 * of the two.
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
  // CLOSED by default, at request. The rail still shows every section as an icon with its
  // name on hover, so nothing is unreachable — and it gives the page ~190px more width, which the
  // photography-led screens spend on the plate.
  const [open, setOpen] = useState(false);
  // Planning mode. Default "fresh" for the first (server-matching) render, then read the real choice
  // after mount so there's no hydration mismatch. A switch rebuilds the week and reloads so every
  // mounted screen re-reads it (a live cross-screen re-render is a later refinement).
  const [mode, setMode] = useState<"fresh" | "batch">("fresh");
  const [cadence, setCadence] = useState<"weekly" | "every3days">("every3days");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const p = loadProfile();
    if (p?.planMode === "batch") setMode("batch");
    if (p?.batchCadence === "weekly") setCadence("weekly");
  }, []);
  const choose = async (next: "fresh" | "batch") => {
    if (busy || next === mode) return;
    if (!loadProfile()) {
      window.location.href = "/onboarding"; // no plan yet — build one first
      return;
    }
    setBusy(true);
    try {
      await switchPlanMode(next); // fires PLAN_CHANGED_EVENT -> mounted /sage screens re-read in place
      setMode(next);
      setBusy(false);
    } catch {
      window.location.reload(); // fall back to a reload if the in-place switch failed
    }
  };
  const chooseCadence = async (c: "weekly" | "every3days") => {
    if (busy || c === cadence) return;
    setBusy(true);
    try {
      await switchBatchCadence(c);
      setCadence(c);
      setBusy(false);
    } catch {
      window.location.reload();
    }
  };

  return (
    /* The QUIET sidebar from `sage-07`: the same sage family as the page, told apart by a hairline
       rather than by being a block of deep forest. The two surfaces differ by 1.14:1, so the border
       is not decoration — it is the only thing separating them, and removing it merges the panel
       into the page. Contrast inside it is computed, not guessed: ink 12.5:1, muted 4.7:1, forest
       6.7:1, all on `--color-tint`. `--color-panel` is still the deep block elsewhere. */
    <header
      className={
        "bg-tint text-plum transition-[width] duration-200 lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-line " +
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
          {/* The mark inverts with the panel: a dark dot on the light rail, which is what sage-07
              has, rather than the light dot that read correctly on the forest one. */}
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-panel">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f5f2e7" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
        <div className="flex items-center gap-2 lg:hidden">
          <div className="flex items-center gap-0.5 rounded-full bg-tint p-0.5">
            <button
              type="button" onClick={() => choose("fresh")} aria-pressed={mode === "fresh"} disabled={busy} title="Fresh"
              className={"grid h-7 w-7 place-items-center rounded-full transition " + (mode === "fresh" ? "bg-panel text-cream" : "text-mut")}
            >
              <IconFresh />
              <span className="sr-only">Fresh planning</span>
            </button>
            <button
              type="button" onClick={() => choose("batch")} aria-pressed={mode === "batch"} disabled={busy} title="Meal-prep"
              className={"grid h-7 w-7 place-items-center rounded-full transition " + (mode === "batch" ? "bg-panel text-cream" : "text-mut")}
            >
              <IconPrep />
              <span className="sr-only">Meal-prep planning</span>
            </button>
          </div>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-panel text-[11.5px] font-bold text-cream">
            A
          </span>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="sage-sections"
          className="hidden h-8 w-8 shrink-0 place-items-center rounded-[9px] text-mut transition hover:bg-cream hover:text-plum lg:grid"
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

      <div className={"mt-auto hidden py-6 lg:block " + (open ? "px-6" : "px-0")}>
        {/* Planning mode: fresh vs meal-prep. Always reachable; collapses to one icon on the rail. */}
        {open ? (
          <div className="mb-5">
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mut">Planning</div>
            <div className="flex gap-1 rounded-[11px] border border-line bg-cream p-1" role="group" aria-label="Planning mode">
              <button
                type="button"
                onClick={() => choose("fresh")}
                aria-pressed={mode === "fresh"}
                disabled={busy}
                className={
                  "flex flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[12.5px] font-semibold transition disabled:opacity-60 " +
                  (mode === "fresh" ? "bg-panel text-cream" : "text-mut hover:text-plum")
                }
              >
                <IconFresh /> Fresh
              </button>
              <button
                type="button"
                onClick={() => choose("batch")}
                aria-pressed={mode === "batch"}
                disabled={busy}
                className={
                  "flex flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[12.5px] font-semibold transition disabled:opacity-60 " +
                  (mode === "batch" ? "bg-panel text-cream" : "text-mut hover:text-plum")
                }
              >
                <IconPrep /> Prep
              </button>
            </div>
            {mode === "batch" && (
              <div className="mt-3">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-mut">Cook cadence</div>
                <div className="flex gap-1 rounded-[10px] border border-line bg-cream p-1">
                  <button
                    type="button" onClick={() => chooseCadence("every3days")} aria-pressed={cadence === "every3days"} disabled={busy}
                    className={"flex-1 rounded-[7px] px-2 py-1.5 text-[11.5px] font-semibold transition disabled:opacity-60 " + (cadence === "every3days" ? "bg-panel text-cream" : "text-mut hover:text-plum")}
                  >
                    Every 3 days
                  </button>
                  <button
                    type="button" onClick={() => chooseCadence("weekly")} aria-pressed={cadence === "weekly"} disabled={busy}
                    className={"flex-1 rounded-[7px] px-2 py-1.5 text-[11.5px] font-semibold transition disabled:opacity-60 " + (cadence === "weekly" ? "bg-panel text-cream" : "text-mut hover:text-plum")}
                  >
                    Weekly
                  </button>
                </div>
                {cadence === "weekly" && <p className="mt-1.5 text-[10.5px] leading-snug text-mut">One cook — some portions get frozen.</p>}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => choose(mode === "fresh" ? "batch" : "fresh")}
            disabled={busy}
            title={mode === "fresh" ? "Switch to meal-prep" : "Switch to fresh"}
            className="mx-auto mb-4 grid h-9 w-9 place-items-center rounded-[10px] text-mut transition hover:bg-cream hover:text-plum disabled:opacity-60"
          >
            {mode === "fresh" ? <IconFresh /> : <IconPrep />}
            <span className="sr-only">Planning mode: {mode === "fresh" ? "fresh" : "meal-prep"} — switch</span>
          </button>
        )}

        <div className={"flex items-center gap-2.5 " + (open ? "" : "flex-col")}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-panel text-[11.5px] font-bold text-cream">
            A
          </span>
          <Link
            href="/classic"
            className={"text-[12px] text-mut hover:text-plum " + (open ? "" : "hidden")}
          >
            Switch to the original design
          </Link>
        </div>
      </div>
    </header>
  );
}
