import Link from "next/link";
import { RECIPES } from "@/lib/recipeDb";
import { demoWeek, DEMO, SLOTS } from "./demo";

/**
 * The sage design connected to the engine.
 *
 * Not a mockup with typed-in numbers: the week comes from `selectWeekFromDb` at request
 * time and the cards from `RECIPES`, so every dish name and figure is the engine's own
 * output. Change the library and this page changes with it.
 *
 * Nav and footer live in layout.tsx, shared with the other sage tabs.
 */
export default function SagePage() {
  const { days, avgKcal, avgProtein, lowest } = demoWeek();
  const tonight = days[2].meals[days[2].meals.length - 1];

  // Spread across the library so the row is not four variations of the same protein.
  const featured = RECIPES.filter((r) => !r.treatOnly)
    .filter((_, i) => i % Math.floor(RECIPES.length / 4) === 0)
    .slice(0, 4);

  return (
    <>
      <section className="grid items-center gap-9 lg:grid-cols-[0.92fr_1.08fr] lg:gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
            Meal planning, solved
          </span>
          <h1 className="mt-4 text-balance text-[clamp(44px,6.6vw,80px)] font-bold leading-[0.94] tracking-[-0.045em]">
            Share a reel.
            <br />
            Eat the <span className="text-vio">week</span>.
          </h1>
          <p className="mt-5 max-w-[44ch] text-[16px] leading-relaxed text-plum-mid">
            Paste a recipe video and it becomes a meal in your plan — macros computed from real food
            data, never guessed. Ask for pancakes and the rest of the day rebalances so your targets
            still hold.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/sage/plan"
              className="inline-flex items-center gap-2 rounded-full bg-vio px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-vio-deep"
            >
              Plan my week
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h13M12 5.5 18.5 12 12 18.5" />
              </svg>
            </Link>
            <Link
              href="/sage/explore"
              className="inline-flex items-center rounded-full border border-line px-6 py-3 text-[13.5px] font-semibold text-plum transition hover:border-vio"
            >
              Browse the library
            </Link>
          </div>
          <p className="mt-6 flex items-center gap-2.5 text-[12.5px] text-mut">
            <span className="h-1.5 w-1.5 rounded-full bg-vio" />
            {RECIPES.length} recipes · every macro from USDA data · no account needed
          </p>
        </div>

        {/* SLOT: hero. Typographic until real photography exists. */}
        <div className="card-shadow relative aspect-[5/4] overflow-hidden rounded-3xl bg-lav lg:-mr-8 lg:rounded-r-none">
          <div className="flex h-full flex-col justify-center p-[8%]">
            <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
              Tonight · {days[2].day}
            </span>
            <p className="mt-3.5 text-balance text-[clamp(30px,4.4vw,52px)] font-bold leading-[0.99] tracking-[-0.042em]">
              {tonight.name}
            </p>
            <div className="mt-7 flex flex-wrap gap-7">
              {(
                [
                  [tonight.calories, "Calories"],
                  [`${tonight.proteinGrams}g`, "Protein"],
                  [tonight.timeMinutes, "Minutes"],
                ] as const
              ).map(([v, l]) => (
                <div key={l}>
                  <b className="block text-[26px] font-bold leading-none tracking-[-0.035em] tabular-nums">{v}</b>
                  <span className="text-[9.5px] font-bold uppercase tracking-[0.15em] text-mut">{l}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="mt-20 flex flex-wrap items-end justify-between gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">From the library</span>
          <h2 className="mt-2 text-[clamp(26px,3.4vw,38px)] font-bold leading-tight tracking-[-0.035em]">
            {RECIPES.length} recipes,
            <br />
            none of them invented.
          </h2>
        </div>
        <Link href="/sage/explore" className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
          Browse all
        </Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {featured.map((r) => (
          <article key={r.id} className="card-shadow flex flex-col overflow-hidden rounded-3xl bg-white">
            {/* SLOT: card image. */}
            <div className="relative flex aspect-[16/10] flex-col justify-end bg-lav p-4">
              <span className="absolute left-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-[10.5px] font-bold text-vio tabular-nums">
                {r.timeMinutes} min
              </span>
              <p className="text-balance text-[19px] font-bold leading-tight tracking-[-0.03em]">{r.name}</p>
            </div>
            <div className="p-4">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-mut">
                {r.cuisine.replace("_", " ")} · {r.type}
              </span>
              <div className="mt-3 flex gap-2 border-t border-line pt-3">
                {(
                  [
                    [r.calories, "kcal"],
                    [`${r.proteinGrams}g`, "protein"],
                    [`${r.fiberGrams ?? 0}g`, "fibre"],
                  ] as const
                ).map(([v, l]) => (
                  <div key={l} className="flex-1">
                    <b className="block text-[16px] font-bold tracking-[-0.03em] tabular-nums">{v}</b>
                    <span className="text-[9px] font-bold uppercase tracking-[0.13em] text-mut">{l}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-20">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">Your week</span>
        <h2 className="mt-2 text-[clamp(26px,3.4vw,38px)] font-bold leading-tight tracking-[-0.035em]">
          Balanced before you cook a thing.
        </h2>
      </div>

      <section className="card-shadow mt-6 rounded-3xl bg-white p-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
              {days.length} days · {days.length * DEMO.mealsPerDay} meals
            </span>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.03em] tabular-nums">
              {avgKcal.toLocaleString()} kcal average · {avgProtein} g protein
            </p>
          </div>
          <Link href="/sage/plan" className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
            Open the planner
          </Link>
        </div>

        <div className="grid gap-px overflow-hidden rounded-2xl bg-line sm:grid-cols-4 lg:grid-cols-7">
          {days.map((d) => (
            <div key={d.day} className="bg-white p-4">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">{d.short}</span>
              <p className="mt-1.5 text-[22px] font-bold leading-none tracking-[-0.04em] tabular-nums">
                {d.kcal.toLocaleString()}
              </p>
              <p className="mt-1 text-[11.5px] text-mut tabular-nums">{d.protein} g protein</p>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-line">
                <div
                  className={`h-full rounded-full ${d.protein < DEMO.proteinGrams * 0.8 ? "bg-mint" : "bg-vio"}`}
                  style={{ width: `${Math.min(100, Math.round((d.protein / DEMO.proteinGrams) * 100))}%` }}
                />
              </div>
              <ul className="mt-3 space-y-1.5">
                {d.meals.map((m, i) => (
                  <li key={i} className="text-[11.5px] leading-snug text-plum-mid">
                    <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-mut">{SLOTS[i]}</span>
                    <br />
                    {m.name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-5 flex items-start gap-2.5 text-[13px] text-mut">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" className="mt-0.5 shrink-0">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16.5v.01" />
          </svg>
          <span>
            <b className="text-plum">
              {lowest.day} is {DEMO.proteinGrams - lowest.protein} g short on protein.
            </b>{" "}
            The assistant can lift it without moving your calories.
          </span>
        </p>
      </section>
    </>
  );
}
