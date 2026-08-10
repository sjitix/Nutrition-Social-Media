import Link from "next/link";
import { Fraunces } from "next/font/google";
import { MobileNav, SideNav } from "./SideNav";
import { demoWeek, DEMO } from "./demo";

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
 *  - **The sidebar carries content, not just links** — sage-12's is a long list under the nav. Here
 *    that list is the real week: seven days with the engine's own calorie and protein totals. A
 *    sidebar of five links and nothing else would be a nav rail; the boards' is a panel.
 *  - **A warm cream page**, edge to edge. No max-width wrapper, because the boards run photography
 *    off the frame and a centred container makes that impossible.
 *
 * Below `lg` the panel becomes a bar: a phone has no room for a 268px column, and every board is
 * a desktop composition.
 *
 * `theme-sage` is pinned on this subtree rather than left to the global switcher, so /sage is
 * always sage no matter what the rest of the app is set to. The other routes are untouched.
 */
export default function SageLayout({ children }: { children: React.ReactNode }) {
  const { days, avgKcal, avgProtein } = demoWeek();

  return (
    <div className={`${display.variable} theme-sage min-h-screen bg-bgsoft text-plum lg:flex`}>
      {/* ---------- the panel ---------- */}
      <header className="bg-panel text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[268px] lg:shrink-0 lg:flex-col lg:overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-6 lg:py-7">
          <Link href="/sage" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-cream">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#26331f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 15.5c3.5 0 4.5-7 8-7s4.5 7 8 7" />
              </svg>
            </span>
            <span className="font-serif-display text-[19px] font-semibold tracking-[-0.02em]">
              NutriFlow
            </span>
          </Link>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-[11.5px] font-bold lg:hidden">
            A
          </span>
        </div>

        <div className="hidden px-4 lg:block">
          <SideNav />
        </div>
        <div className="lg:hidden">
          <MobileNav />
        </div>

        {/* The week, in the panel. Real engine totals — the same object every screen renders. */}
        <div className="mt-8 hidden px-6 lg:block">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/60">
            This week
          </p>
          <ul className="mt-3.5">
            {days.map((d) => (
              <li
                key={d.day}
                className="flex items-baseline justify-between border-t border-white/10 py-2 text-[12px] first:border-0"
              >
                <span className="text-white/70">{d.short}</span>
                <span className="tabular-nums text-white/60">
                  <b className="font-semibold text-white/85">{d.kcal.toLocaleString()}</b> kcal ·{" "}
                  {d.protein} g
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-white/10 pt-3 text-[11.5px] leading-relaxed text-white/60">
            Averaging{" "}
            <b className="font-semibold text-white/85 tabular-nums">
              {avgKcal.toLocaleString()} kcal
            </b>{" "}
            and{" "}
            <b className="font-semibold text-white/85 tabular-nums">{avgProtein} g protein</b>{" "}
            against a {DEMO.targetCalories.toLocaleString()} / {DEMO.proteinGrams} g target.
          </p>
        </div>

        <div className="mt-auto hidden items-center gap-2.5 px-6 py-6 lg:flex">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-[11.5px] font-bold">
            A
          </span>
          <Link href="/classic" className="text-[12px] text-white/60 hover:text-white">
            Switch to the original design
          </Link>
        </div>
      </header>

      {/* ---------- the page ---------- */}
      <div className="min-w-0 flex-1">
        <main>{children}</main>

        <footer className="mt-24 flex flex-wrap justify-between gap-4 border-t border-line px-6 py-7 text-[12px] text-mut sm:px-10 xl:px-14">
          <span>NutriFlow — meal planning that keeps you on track</span>
          <span>Every figure computed from USDA FoodData Central</span>
        </footer>
      </div>
    </div>
  );
}
