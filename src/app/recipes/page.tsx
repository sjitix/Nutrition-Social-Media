import Link from "next/link";
import { RECIPES } from "@/lib/recipeDb";

// Read-only viewer for the recipe library (Phase A scaffolding). Lets you see
// what's in the database as it grows. Lives at /recipes.

function countBy<T extends string>(key: (r: (typeof RECIPES)[number]) => T) {
  const m = new Map<T, number>();
  for (const r of RECIPES) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const TYPE_ORDER = ["breakfast", "lunch", "dinner", "snack"] as const;

export default function RecipesPage() {
  const byType = countBy((r) => r.type);
  const byCuisine = countBy((r) => r.cuisine);
  const byProtein = countBy((r) => r.mainProtein);

  const rows = [...RECIPES].sort(
    (a, b) =>
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      a.name.localeCompare(b.name),
  );
  const shown = rows.slice(0, 300); // keep the page light

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Recipe library</h1>
          <p className="mt-1 text-sm text-mut">
            {RECIPES.length.toLocaleString()} recipes in the database · showing the first{" "}
            {shown.length}. Plans are assembled from all of them.
          </p>
        </div>
        <Link
          href="/plan"
          className="rounded-full bg-vio px-4 py-2 text-sm font-bold text-white transition hover:bg-vio-deep"
        >
          Back to app
        </Link>
      </div>

      {/* summary */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          { title: "By meal", data: byType },
          { title: "By cuisine", data: byCuisine },
          { title: "By protein", data: byProtein },
        ].map((g) => (
          <div key={g.title} className="rounded-2xl bg-white p-4 card-shadow">
            <p className="text-[10px] font-bold tracking-widest text-mut uppercase">{g.title}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {g.data.map(([label, n]) => (
                <span
                  key={label}
                  className="rounded-full bg-lav px-2.5 py-1 text-xs font-semibold text-vio-deep"
                >
                  {label.replace("_", " ")} · {n}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* table */}
      <div className="mt-6 overflow-x-auto rounded-2xl bg-white card-shadow">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] tracking-wide text-mut uppercase">
              <th className="px-4 py-3 font-semibold">Recipe</th>
              <th className="px-3 py-3 font-semibold">Meal</th>
              <th className="px-3 py-3 font-semibold">Cuisine</th>
              <th className="px-3 py-3 font-semibold">Protein</th>
              <th className="px-3 py-3 text-right font-semibold">kcal</th>
              <th className="px-3 py-3 text-right font-semibold">P/C/F</th>
              <th className="px-3 py-3 text-right font-semibold">Fiber</th>
              <th className="px-3 py-3 text-right font-semibold">Time</th>
              <th className="px-3 py-3 text-center font-semibold">Cost</th>
              <th className="px-3 py-3 font-semibold">Diet</th>
              <th className="px-3 py-3 text-right font-semibold">Ingr.</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-bgsoft">
                <td className="px-4 py-3 font-semibold">{r.name}</td>
                <td className="px-3 py-3 text-mut capitalize">{r.type}</td>
                <td className="px-3 py-3 text-mut capitalize">{r.cuisine.replace("_", " ")}</td>
                <td className="px-3 py-3 text-mut capitalize">{r.mainProtein}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums text-vio-deep">
                  {r.calories}
                </td>
                <td className="px-3 py-3 text-right text-mut tabular-nums">
                  <span className="font-bold text-plum">{r.proteinGrams}</span>/{r.carbsGrams}/
                  {r.fatGrams}
                </td>
                <td className="px-3 py-3 text-right font-semibold text-mint tabular-nums">
                  {r.fiberGrams ?? "—"}g
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{r.timeMinutes}m</td>
                <td className="px-3 py-3 text-center text-mint">{"$".repeat(r.approxCost)}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    {r.dietTags.length === 0 ? (
                      <span className="text-xs text-mut">—</span>
                    ) : (
                      r.dietTags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold text-mint"
                        >
                          {t.replace("_", " ")}
                        </span>
                      ))
                    )}
                  </div>
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-mut">
                  {r.ingredients.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
