import Link from "next/link";
import { SageTabs } from "./SageTabs";

/**
 * Shell for the sage candidate: one nav across Home, Plan, Explore, Groceries and
 * Assistant, so the design can be judged as a product rather than as a landing page.
 *
 * `theme-sage` is pinned on this subtree rather than left to the global switcher, so
 * /sage is always sage no matter what the rest of the app is set to. The existing
 * routes are untouched.
 */
export default function SageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-sage min-h-screen bg-bgsoft text-plum">
      <div className="mx-auto max-w-[1400px] px-6 pb-24 sm:px-8">
        <nav className="flex flex-wrap items-center gap-4 py-6">
          <Link href="/sage" className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-vio">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dfe6da" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15.5c3.5 0 4.5-7 8-7s4.5 7 8 7" />
              </svg>
            </span>
            NutriFlow
          </Link>

          <SageTabs />

          <span className="ml-auto flex items-center gap-3">
            <Link href="/classic" className="text-[13px] font-medium text-mut hover:text-plum">
              Current design
            </Link>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-vio text-[12px] font-bold text-white">
              A
            </span>
          </span>
        </nav>

        {children}

        <footer className="mt-16 flex flex-wrap justify-between gap-4 border-t border-line pt-6 text-[12.5px] text-mut">
          <span>NutriFlow — meal planning that keeps you on track</span>
          <span>Macros computed from USDA FoodData Central</span>
        </footer>
      </div>
    </div>
  );
}
