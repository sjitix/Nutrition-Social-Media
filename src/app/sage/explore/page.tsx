import { RECIPES } from "@/lib/recipeDb";

/** The library. The cards are real recipes, and the counts on the filter chips are real too. */
export default function SageExplorePage() {
  const pool = RECIPES.filter((r) => !r.treatOnly);
  // Spread across the library rather than taking the first 24, which would be all breakfasts.
  const shown = pool.filter((_, i) => i % Math.floor(pool.length / 24) === 0).slice(0, 24);

  const filters: [string, number][] = [
    ["All", pool.length],
    ["Breakfast", pool.filter((r) => r.type === "breakfast").length],
    ["Lunch", pool.filter((r) => r.type === "lunch").length],
    ["Dinner", pool.filter((r) => r.type === "dinner").length],
    ["Snack", pool.filter((r) => r.type === "snack").length],
    ["High protein", pool.filter((r) => r.proteinGrams >= 25).length],
    ["≤20 min", pool.filter((r) => r.timeMinutes <= 20).length],
    ["Vegan", pool.filter((r) => r.dietTags.includes("vegan")).length],
  ];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
            {pool.length} recipes · macros from USDA data
          </span>
          <h1 className="mt-2 text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-[-0.04em]">
            Find something to cook.
          </h1>
        </div>
        <button className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
          Import from a link
        </button>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="flex min-w-[200px] flex-1 items-center gap-2.5 rounded-full border border-line bg-white px-4 py-2.5 text-[13px] text-mut">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="10.8" cy="10.8" r="6.9" />
            <path d="m16.2 16.2 4.3 4.3" />
          </svg>
          Search {pool.length} recipes…
        </span>
        {filters.map(([label, n], i) => (
          <button
            key={label}
            className={
              "rounded-full px-4 py-2 text-[12.5px] transition " +
              (i === 0
                ? "bg-vio font-semibold text-white"
                : "border border-line bg-white font-medium text-plum-mid hover:border-vio hover:text-plum")
            }
          >
            {label} <span className="tabular-nums opacity-60">{n}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((r) => (
          <article key={r.id} className="card-shadow flex flex-col overflow-hidden rounded-3xl bg-white">
            {/* SLOT: card image. Typographic until real photography exists. */}
            <div className="relative flex aspect-[16/10] flex-col justify-end bg-lav p-4">
              <span className="absolute left-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-[10.5px] font-bold text-vio tabular-nums">
                {r.timeMinutes} min
              </span>
              <p className="text-balance text-[19px] font-bold leading-tight tracking-[-0.03em]">{r.name}</p>
            </div>
            <div className="flex flex-1 flex-col p-4">
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
              <button className="mt-3 w-full rounded-full border border-line py-2.5 text-[13px] font-semibold transition hover:border-vio">
                Add to plan
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
