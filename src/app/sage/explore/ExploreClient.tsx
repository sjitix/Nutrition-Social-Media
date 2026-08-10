"use client";

import { useMemo, useState } from "react";
import {
  FEED_RECIPES,
  filterFeed,
  sortFeed,
  HIGH_PROTEIN_G,
  type FeedFilter,
  type FeedMealType,
  type FeedDiet,
  type FeedSort,
} from "@/lib/feed";

/**
 * The live library.
 *
 * Filtering and sorting come from `filterFeed` and `sortFeed` in lib/feed.ts — the same pure,
 * unit-tested functions the existing planner uses. Writing new filter logic here would have meant
 * two implementations that could disagree about what "vegan" or "high protein" means, and only
 * one of them covered by tests.
 *
 * Everything runs in the browser, so this works on static hosting as well as a server.
 */
const PAGE = 24;

const MEAL_TYPES: [FeedMealType, string][] = [
  ["all", "All"],
  ["breakfast", "Breakfast"],
  ["lunch", "Lunch"],
  ["dinner", "Dinner"],
  ["snack", "Snack"],
];

const DIETS: [FeedDiet, string][] = [
  ["all", "Any diet"],
  ["vegetarian", "Vegetarian"],
  ["vegan", "Vegan"],
  ["keto", "Keto"],
  ["gluten_free", "Gluten free"],
  ["mediterranean", "Mediterranean"],
];

const SORTS: [FeedSort, string][] = [
  ["default", "Library order"],
  ["protein", "Most protein"],
  ["calories-low", "Fewest calories"],
  ["time", "Quickest"],
];

export function ExploreClient() {
  const [mealType, setMealType] = useState<FeedMealType>("all");
  const [diet, setDiet] = useState<FeedDiet>("all");
  const [highProtein, setHighProtein] = useState(false);
  const [quick, setQuick] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FeedSort>("default");
  const [shown, setShown] = useState(PAGE);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const filter: FeedFilter = { mealType, diet, highProtein, maxTime: quick ? 20 : null, query };

  const results = useMemo(
    () => sortFeed(filterFeed(FEED_RECIPES, filter), sort),
    // The filter object is rebuilt each render; depend on its fields, not its identity.
    [mealType, diet, highProtein, quick, query, sort],
  );

  const visible = results.slice(0, shown);
  // Any facet change should return you to the top of the results, not leave you 96 cards deep
  // in a list that no longer has 96 cards.
  function change<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setShown(PAGE);
    };
  }

  const chip = (on: boolean) =>
    "rounded-full px-4 py-2 text-[12.5px] transition " +
    (on
      ? "bg-vio font-semibold text-white"
      : "border border-line bg-white font-medium text-plum-mid hover:border-vio hover:text-plum");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex min-w-[220px] flex-1 items-center gap-2.5 rounded-full border border-line bg-white px-4 py-2.5 focus-within:border-vio">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-mut">
            <circle cx="10.8" cy="10.8" r="6.9" />
            <path d="m16.2 16.2 4.3 4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => change(setQuery)(e.target.value)}
            placeholder={`Search ${FEED_RECIPES.length} recipes by name or ingredient…`}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-mut"
            aria-label="Search recipes"
          />
          {query && (
            <button onClick={() => change(setQuery)("")} aria-label="Clear search" className="text-mut hover:text-plum">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </label>

        <select
          value={sort}
          onChange={(e) => change(setSort)(e.target.value as FeedSort)}
          aria-label="Sort recipes"
          className="rounded-full border border-line bg-white px-4 py-2.5 text-[12.5px] font-medium text-plum-mid outline-none focus:border-vio"
        >
          {SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {MEAL_TYPES.map(([v, l]) => (
          <button key={v} onClick={() => change(setMealType)(v)} className={chip(mealType === v)}>
            {l}
          </button>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {DIETS.map(([v, l]) => (
          <button key={v} onClick={() => change(setDiet)(v)} className={chip(diet === v)}>
            {l}
          </button>
        ))}
        <button onClick={() => change(setHighProtein)(!highProtein)} className={chip(highProtein)}>
          ≥{HIGH_PROTEIN_G}g protein
        </button>
        <button onClick={() => change(setQuick)(!quick)} className={chip(quick)}>
          ≤20 min
        </button>
      </div>

      <p className="mb-4 text-[13px] text-mut tabular-nums">
        {results.length === FEED_RECIPES.length
          ? `${results.length} recipes`
          : `${results.length} of ${FEED_RECIPES.length} recipes`}
        {results.length > visible.length && ` · showing ${visible.length}`}
      </p>

      {results.length === 0 ? (
        <div className="card-shadow rounded-3xl bg-white p-10 text-center">
          <p className="text-[17px] font-semibold">Nothing matches all of those.</p>
          <p className="mx-auto mt-2 max-w-[46ch] text-[13.5px] text-mut">
            Every filter is applied together, not separately — so a combination can genuinely have
            no answer. Drop one and the results come back.
          </p>
          <button
            onClick={() => {
              setMealType("all");
              setDiet("all");
              setHighProtein(false);
              setQuick(false);
              setQuery("");
              setShown(PAGE);
            }}
            className="mt-5 rounded-full bg-vio px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-vio-deep"
          >
            Clear all filters
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((it) => {
              const m = it.meal;
              const isAdded = added.has(m.name);
              return (
                <article key={m.name} className="card-shadow flex flex-col overflow-hidden rounded-3xl bg-white">
                  {/* SLOT: card image. Typographic until real photography exists. */}
                  <div className="relative flex aspect-[16/10] flex-col justify-end bg-lav p-4">
                    <span className="absolute left-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-[10.5px] font-bold text-vio tabular-nums">
                      {m.timeMinutes} min
                    </span>
                    <p className="text-balance text-[19px] font-bold leading-tight tracking-[-0.03em]">{m.name}</p>
                  </div>
                  <div className="flex flex-1 flex-col p-4">
                    <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-mut">
                      {m.type}
                      {it.dietTags.length > 0 && ` · ${it.dietTags[0].replace("_", " ")}`}
                    </span>
                    <div className="mt-3 flex gap-2 border-t border-line pt-3">
                      {(
                        [
                          [m.calories, "kcal"],
                          [`${m.proteinGrams}g`, "protein"],
                          [`${m.fiberGrams ?? 0}g`, "fibre"],
                        ] as const
                      ).map(([v, l]) => (
                        <div key={l} className="flex-1">
                          <b className="block text-[16px] font-bold tracking-[-0.03em] tabular-nums">{v}</b>
                          <span className="text-[9px] font-bold uppercase tracking-[0.13em] text-mut">{l}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() =>
                        setAdded((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.name)) next.delete(m.name);
                          else next.add(m.name);
                          return next;
                        })
                      }
                      aria-pressed={isAdded}
                      className={
                        "mt-3 w-full rounded-full py-2.5 text-[13px] font-semibold transition " +
                        (isAdded
                          ? "bg-mint-soft text-mint"
                          : "border border-line hover:border-vio")
                      }
                    >
                      {isAdded ? "Saved — tap to remove" : "Save for later"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {results.length > visible.length && (
            <div className="mt-8 flex justify-center">
              <button
                onClick={() => setShown((s) => s + PAGE)}
                className="rounded-full border border-line bg-white px-6 py-3 text-[13px] font-semibold transition hover:border-vio"
              >
                Show {Math.min(PAGE, results.length - visible.length)} more
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
