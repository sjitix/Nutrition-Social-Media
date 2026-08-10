import Image from "next/image";
import { gradientForMeal, imageForMeal } from "@/lib/recipes";
import { demoWeek, DEMO, SLOTS } from "../demo";

/**
 * The week, built from `designs/references/boards/sage-10 … sage-12`.
 *
 * The board's week is NOT a table. It is seven independent columns of flat sage blocks standing
 * on a cream page, gapped, with ragged bottoms — sage-12 most clearly. The previous version was a
 * 1120px-wide bordered grid with a header row and a totals row, which is the shape the brief
 * names as the thing to avoid (a sidebar next to a table). A grid locks every cell to the height
 * of the tallest in its row; a column of blocks lets each meal be its own size, which is where the
 * texture in those boards comes from.
 *
 * The strip of photographs across the top is sage-12's as well. A dish with no photograph of its
 * own gets a typographic tile — it never borrows another dish's picture.
 *
 * Every figure is `selectWeekFromDb`'s own output, shared with every other screen through
 * `demo.ts` so no two tabs can describe different weeks.
 */
export default function SagePlanPage() {
  const { days, avgKcal, avgProtein, avgFibre, lowest, uniqueDishes } = demoWeek();
  const totalMeals = days.length * DEMO.mealsPerDay;

  // The strip: one dish per day, from THIS week. A day that contains a photographed dish shows
  // that one — otherwise the strip is a row of tiles while the week quietly contains a picture,
  // which is the wrong trade in a photography-led design. Failing that, the day's largest meal.
  const strip = days.map((d) => ({
    day: d.short,
    meal:
      d.meals.find((m) => imageForMeal(m.name)) ??
      d.meals.reduce((a, b) => (b.calories > a.calories ? b : a)),
  }));

  return (
    <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
          {days.length} days · {totalMeals} meals · {uniqueDishes} distinct dishes
        </span>
        <div className="flex gap-2">
          <button className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line">
            Regenerate
          </button>
          <button className="rounded-full bg-vio px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep">
            Ask the assistant
          </button>
        </div>
      </div>

      {/* ---------- the photograph strip, sage-12 ---------- */}
      <ul className="mt-6 flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {strip.map(({ day, meal }) => {
          const img = imageForMeal(meal.name);
          return (
            <li key={day} className="w-[248px] shrink-0">
              <div className="relative h-[132px] overflow-hidden rounded-[10px]">
                {img ? (
                  <Image src={img} alt={meal.name} fill sizes="248px" className="object-cover" />
                ) : (
                  <span
                    className="absolute inset-0"
                    style={{ background: gradientForMeal(meal.name) }}
                  />
                )}
                <span className="absolute left-3 top-3 rounded-full bg-cream px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.14em]">
                  {day}
                </span>
              </div>
              <p className="mt-2.5 truncate text-[12.5px] font-semibold tracking-[-0.01em]">
                {meal.name}
              </p>
              <p className="text-[10.5px] tabular-nums text-mut">
                {meal.calories} kcal · {meal.proteinGrams} g protein
              </p>
            </li>
          );
        })}
      </ul>

      {/* ---------- the heading, then the columns ---------- */}
      <div className="mt-12 flex flex-wrap items-end justify-between gap-5 border-b border-plum/25 pb-5">
        <h1 className="font-serif-display text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
          Weekly plan
        </h1>
        <div className="flex gap-7 text-[11.5px]">
          {(
            [
              [avgKcal.toLocaleString(), `of ${DEMO.targetCalories.toLocaleString()} kcal`],
              [avgProtein, `of ${DEMO.proteinGrams} g protein`],
              [avgFibre, "g fibre"],
            ] as const
          ).map(([v, l]) => (
            <p key={l}>
              <b className="block text-[19px] font-bold leading-none tracking-[-0.03em] tabular-nums">
                {v}
              </b>
              <span className="mt-1 block text-mut">{l}</span>
            </p>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {days.map((d) => {
          const short = d.protein < DEMO.proteinGrams;
          return (
            <section key={d.day} className="flex flex-col gap-2" aria-label={d.day}>
              <div className="pb-1">
                <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-mut">
                  {d.day}
                </h2>
                <p className="mt-1.5 text-[24px] font-bold leading-none tracking-[-0.04em] tabular-nums">
                  {d.kcal.toLocaleString()}
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-mut">{d.protein} g protein</p>
                <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-line">
                  <div
                    className={`h-full ${short ? "bg-mint" : "bg-vio"}`}
                    style={{
                      width: `${Math.min(100, Math.round((d.protein / DEMO.proteinGrams) * 100))}%`,
                    }}
                  />
                </div>
              </div>

              {d.meals.map((m, i) => (
                <article key={i} className="rounded-[10px] bg-tint p-4">
                  <span className="text-[8.5px] font-bold uppercase tracking-[0.16em] text-mut">
                    {SLOTS[i]}
                  </span>
                  <p className="mt-1.5 text-[13px] font-semibold leading-[1.25] tracking-[-0.01em]">
                    {m.name}
                  </p>
                  <p className="mt-2.5 border-t border-plum/12 pt-2 text-[10.5px] tabular-nums text-mut">
                    <b className="font-bold text-plum">{m.calories}</b> kcal ·{" "}
                    <b className="font-bold text-plum">{m.proteinGrams}</b> g ·{" "}
                    {m.timeMinutes} min
                  </p>
                </article>
              ))}

              {/* The column that is off target says so, in its own column — which is also what
                  makes the row of columns ragged rather than a locked grid. Only when there IS a
                  shortfall: the week is re-solved against the targets, so a block reading "0 g
                  under" would be worse than no block at all. */}
              {d.day === lowest.day && DEMO.proteinGrams - d.protein > 0 && (
                <div className="rounded-[10px] bg-panel p-4 text-white">
                  <p className="text-[8.5px] font-bold uppercase tracking-[0.16em] text-white/60">
                    Short
                  </p>
                  <p className="mt-1.5 text-[22px] font-bold leading-none tracking-[-0.04em] tabular-nums">
                    {DEMO.proteinGrams - d.protein} g
                  </p>
                  <p className="mt-2 text-[10.5px] leading-relaxed text-white/60">
                    under your protein target. The assistant can lift it without moving the
                    calories.
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
