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
    <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-plum/25 pb-6">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
            {items.length} items · {groups.length} aisles · one week
          </span>
          <h1 className="font-serif-display mt-4 max-w-[12ch] text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
            Everything you need.
          </h1>
        </div>
        <button className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line">
          Copy list
        </button>
      </div>

      <div className="mt-5">
        <GroceriesClient groups={groups} />
      </div>
    </div>
  );
}
