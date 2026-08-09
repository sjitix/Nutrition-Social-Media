import { groupByAisle } from "@/lib/grocery";
import { demoWeek } from "../demo";

/**
 * The shopping list, built from the same week the other tabs show.
 *
 * Ingredients are collected off every meal in the generated week and bucketed with
 * `groupByAisle` — the tested categoriser the real app uses — so the aisles here are
 * the ones the product would actually produce, not a plausible-looking list.
 */
export default function SageGroceriesPage() {
  const { days } = demoWeek();

  // Collapse duplicates across the week: seven days of cooking repeats a lot of staples,
  // and a list that says "olive oil" nine times is not a shopping list.
  const seen = new Map<string, { name: string; quantity: string; count: number }>();
  for (const d of days) {
    for (const m of d.meals) {
      for (const ing of m.ingredients) {
        const key = ing.name.trim().toLowerCase();
        const hit = seen.get(key);
        if (hit) hit.count += 1;
        else seen.set(key, { name: ing.name, quantity: ing.quantity, count: 1 });
      }
    }
  }
  const items = [...seen.values()];
  const grouped = groupByAisle(items);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
            {items.length} items · {grouped.length} aisles
          </span>
          <h1 className="mt-2 text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-[-0.04em]">
            Everything you need.
          </h1>
        </div>
        <button className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
          Copy list
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px] lg:items-start">
        <div className="card-shadow overflow-hidden rounded-3xl bg-white">
          {grouped.map(({ aisle, items: rows }) => (
            <section key={aisle} className="border-b border-line px-6 py-5 last:border-b-0">
              <h2 className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-mut">
                {aisle} <span className="tabular-nums opacity-60">{rows.length}</span>
              </h2>
              <ul className="mt-1">
                {rows.map((it) => (
                  <li key={it.name} className="flex items-center gap-3.5 border-b border-line py-2.5 last:border-b-0">
                    <span className="h-5 w-5 shrink-0 rounded-md border-[1.6px] border-line bg-white" />
                    <span className="flex-1 text-[14px]">{it.name}</span>
                    {it.count > 1 && (
                      <span className="rounded-full bg-lav px-2 py-0.5 text-[10.5px] font-bold text-vio tabular-nums">
                        ×{it.count}
                      </span>
                    )}
                    <span className="text-[12.5px] text-mut tabular-nums">{it.quantity}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <aside className="card-shadow rounded-3xl bg-white p-5 lg:sticky lg:top-5">
          <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-mut">This week</span>
          <p className="mt-2 text-[31px] font-bold leading-none tracking-[-0.045em] tabular-nums">
            {items.length}
            <em className="ml-1.5 text-[13px] font-medium not-italic tracking-normal text-mut">items</em>
          </p>
          <div className="mt-4 space-y-2.5">
            {grouped.map(({ aisle, items: rows }) => (
              <div key={aisle} className="flex items-baseline justify-between text-[12.5px]">
                <span className="text-mut">{aisle}</span>
                <span className="font-semibold tabular-nums">{rows.length}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 border-t border-line pt-3.5 text-[12.5px] leading-relaxed text-mut">
            Grouped by aisle so you walk the shop once. A ×N badge means the ingredient appears in
            that many meals this week — buy accordingly.
          </p>
        </aside>
      </div>
    </>
  );
}
