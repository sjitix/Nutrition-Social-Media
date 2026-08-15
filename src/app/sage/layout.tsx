import { Fraunces } from "next/font/google";
import { SageFooter } from "./SageFooter";
import { SidePanel } from "./SidePanel";

/**
 * The editorial display face.
 *
 * `next/font` SELF-HOSTS this at build time — the browser makes no request to Google, which
 * matters because the static Pages export has no server and the app must not depend on a third
 * party to render its headlines. It adds no npm dependency (next/font ships with Next), but it
 * DOES mean the build needs network access once to fetch the file. If that is ever a problem,
 * delete this import and the `variable` below: `.font-serif-display` in globals.css already
 * falls back to a system serif stack, so nothing breaks, the letterforms just change.
 */
const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

/**
 * The shell, rebuilt from the reference boards rather than from what was here.
 *
 * What the boards actually show, and what this reproduces:
 *
 *  - **A deep forest sidebar running the full height of the window** (sage-10, sage-11, sage-12),
 *    not a centred page with a row of pill tabs. It is the single largest block of colour in the
 *    product, which is the first of the five things that make those boards work.
 *  - **A warm cream page**, edge to edge. No max-width wrapper, because the boards run photography
 *    off the frame and a centred container makes that impossible.
 *
 * The panel used to carry the week as well as the nav — sage-12's does — and it is gone at the owner's
 * request. Worth knowing what that bought beyond the tidier rail: the sidebar is part of EVERY
 * route's payload, so seven days of engine totals were being serialised into every navigation.
 * Home's RSC response was 118 kB and Week's 123 kB; both drop sharply without it. This layout no
 * longer touches the engine at all.
 *
 * Below `lg` the panel becomes a bar: a phone has no room for a 268px column, and every board is
 * a desktop composition.
 *
 * `theme-sage` is pinned on this subtree rather than left to the global switcher, so /sage is
 * always sage no matter what the rest of the app is set to. The other routes are untouched.
 */
export default function SageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${display.variable} theme-sage min-h-screen bg-bgsoft text-plum lg:flex`}>
      <SidePanel />

      {/* ---------- the page ---------- */}
      <div className="min-w-0 flex-1">
        <main>{children}</main>

        <SageFooter />
      </div>
    </div>
  );
}
