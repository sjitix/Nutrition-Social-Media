import { groupByAisle } from "@/lib/grocery";
import { demoWeek } from "../demo";
import { GroceriesClient, type Row } from "./GroceriesClient";

/**
 * The shopping list, built from the same week the other tabs show.
 *
 * Ingredients are collected off every meal in the generated week and bucketed with
 * `groupByAisle` — the tested categoriser the real app uses — so the aisles are the ones the
 * product would actually produce. The list is computed on the server; the ticking is client-side.
 */
export default function SageGroceriesPage() {
  const { days } = demoWeek();

  // Collapse duplicates across the week: seven days of cooking repeats a lot of staples, and a
  // list that says "olive oil" nine times is not a shopping list.
  const seen = new Map<string, Row>();
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
  const groups = groupByAisle(items);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
            {items.length} items · {groups.length} aisles
          </span>
          <h1 className="mt-2 text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-[-0.04em]">
            Everything you need.
          </h1>
        </div>
        <button className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
          Copy list
        </button>
      </div>

      <GroceriesClient groups={groups} />
    </>
  );
}
