"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import {
  FEED_RECIPES,
  filterFeed,
  sortFeed,
  HIGH_PROTEIN_G,
  type FeedFilter,
  type FeedItem,
  type FeedMealType,
  type FeedDiet,
  type FeedSort,
} from "@/lib/feed";

/**
 * The live library, in the boards' visual language.
 *
 * Filtering and sorting still come from `filterFeed` and `sortFeed` in lib/feed.ts — the same
 * pure, unit-tested functions the planner uses. Writing new filter logic here would have meant two
 * implementations that could disagree about what "vegan" or "high protein" means, and only one of
 * them covered by tests. Only the presentation changed.
 *
 * What changed, and why: the wall used to be a uniform four-up grid of equal cards, which is the
 * "evenly weighted" failure the brief names. The boards never grid like that — sage-02 and sage-09
 * lay out unequal blocks, so the first card of every page here spans two columns and two rows and
 * carries the photograph large. Radii are small; the body of each card is the cream surface, so a
 * card sits ABOVE the page rather than being cut out of it.
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
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const filter: FeedFilter = { mealType, diet, highProtein, maxTime: quick ? 20 : null, query };

  const results = useMemo(
    () => sortFeed(filterFeed(FEED_RECIPES, filter), sort),
    // The filter object is rebuilt each render; depend on its fields, not its identity.
    [mealType, diet, highProtein, quick, query, sort],
  );

  const visible = results.slice(0, shown);
  // Any facet change should return you to the top of the results, not leave you 96 cards deep in
  // a list that no longer has 96 cards.
  function change<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setShown(PAGE);
    };
  }

  const chip = (on: boolean) =>
    "rounded-full px-4 py-2 text-[12px] transition " +
    (on
      ? "bg-vio font-semibold text-white"
      : "bg-tint font-medium text-plum-mid hover:bg-line hover:text-plum");

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
        <label className="flex min-w-[220px] flex-1 items-center gap-2.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-mut" aria-hidden>
            <circle cx="10.8" cy="10.8" r="6.9" />
            <path d="m16.2 16.2 4.3 4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => change(setQuery)(e.target.value)}
            placeholder={`Search ${FEED_RECIPES.length} recipes by name or ingredient…`}
            className="w-full bg-transparent py-1.5 text-[13.5px] outline-none placeholder:text-mut"
            aria-label="Search recipes"
          />
          {query && (
            <button onClick={() => change(setQuery)("")} aria-label="Clear search" className="text-mut hover:text-plum">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </label>

        <select
          value={sort}
          onChange={(e) => change(setSort)(e.target.value as FeedSort)}
          aria-label="Sort recipes"
          className="rounded-full bg-tint px-4 py-2 text-[12px] font-medium text-plum-mid outline-none"
        >
          {SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {MEAL_TYPES.map(([v, l]) => (
          <button key={v} onClick={() => change(setMealType)(v)} className={chip(mealType === v)}>
            {l}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
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

      <p className="mt-5 text-[12px] tabular-nums text-mut">
        {results.length === FEED_RECIPES.length
          ? `${results.length} recipes`
          : `${results.length} of ${FEED_RECIPES.length} recipes`}
        {results.length > visible.length && ` · showing ${visible.length}`}
      </p>

      {results.length === 0 ? (
        <div className="mt-4 bg-tint p-10 text-center lg:rounded-[12px]">
          <p className="font-serif-display text-[24px] font-semibold tracking-[-0.02em]">
            Nothing matches all of those.
          </p>
          <p className="mx-auto mt-2.5 max-w-[46ch] text-[13px] leading-relaxed text-plum-mid">
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
            className="mt-6 rounded-full bg-vio px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-vio-deep"
          >
            Clear all filters
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((it, i) => (
              <Card
                key={it.meal.name}
                item={it}
                // One large card per page of results, top-left, so the wall is never a uniform
                // grid of equal tiles.
                lead={i % PAGE === 0}
                saved={saved.has(it.meal.name)}
                onToggle={() =>
                  setSaved((prev) => {
                    const next = new Set(prev);
                    if (next.has(it.meal.name)) next.delete(it.meal.name);
                    else next.add(it.meal.name);
                    return next;
                  })
                }
              />
            ))}
          </div>

          {results.length > visible.length && (
            <div className="mt-8 flex justify-center">
              <button
                onClick={() => setShown((s) => s + PAGE)}
                className="rounded-full bg-tint px-6 py-3 text-[13px] font-semibold transition hover:bg-line"
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

function Card({
  item,
  lead,
  saved,
  onToggle,
}: {
  item: FeedItem;
  lead: boolean;
  saved: boolean;
  onToggle: () => void;
}) {
  const m = item.meal;
  return (
    <article
      className={
        "flex flex-col overflow-hidden rounded-[12px] bg-cream " + (lead ? "sm:col-span-2" : "")
      }
    >
      {/* SLOT: card image. A photographed dish shows its own photograph; everything else falls
          back to a TYPOGRAPHIC tile carrying its own name. It never borrows another dish's
          picture — and a tile with nothing on it is a colour block encoding nothing, which is a
          rejected direction in its own right. */}
      <div className={"relative " + (lead ? "aspect-[16/10] sm:aspect-[21/9]" : "aspect-[16/10]")}>
        {item.image ? (
          <Image
            src={item.image}
            alt={m.name}
            fill
            sizes={lead ? "(max-width: 640px) 100vw, 50vw" : "(max-width: 640px) 100vw, 25vw"}
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0" style={{ background: item.gradient }}>
            {/* A scrim, not a text-shadow. The fourteen tiles run from pale sage to clay, and
                white type on the palest of them measures about 3:1 — below AA. Over
                `from-panel/80` the same type measures 10:1 whatever tile is underneath, so the
                fallback is legible by construction rather than by luck. */}
            <div className="absolute inset-0 flex items-end bg-gradient-to-t from-panel/80 via-panel/25 to-transparent p-4">
              <p
                className={
                  "font-serif-display text-balance font-semibold leading-[1.1] tracking-[-0.02em] text-white " +
                  (lead ? "text-[30px]" : "text-[19px]")
                }
              >
                {m.name}
              </p>
            </div>
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-full bg-cream px-2.5 py-1 text-[10px] font-bold tabular-nums">
          {m.timeMinutes} min
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-mut">
          {m.type}
          {item.dietTags.length > 0 && ` · ${item.dietTags[0].replace("_", " ")}`}
        </span>
        {/* The name is set ONCE per card: on the photograph's caption line, or on the tile above. */}
        {item.image && (
          <p
            className={
              "font-serif-display mt-1.5 text-balance font-semibold leading-[1.12] tracking-[-0.02em] " +
              (lead ? "text-[26px]" : "text-[17px]")
            }
          >
            {m.name}
          </p>
        )}
        {lead && (
          <p className="mt-2 max-w-[44ch] text-[12.5px] leading-relaxed text-plum-mid">
            {m.description}
          </p>
        )}

        <div className="mt-auto flex border-t border-line pt-3 text-[9px] font-bold uppercase tracking-[0.13em] text-mut">
          {(
            [
              [m.calories.toLocaleString(), "kcal"],
              [`${m.proteinGrams}g`, "protein"],
              [`${m.fiberGrams ?? 0}g`, "fibre"],
            ] as const
          ).map(([v, l], i) => (
            <p key={l} className={"flex-1 " + (i ? "border-l border-line pl-3" : "")}>
              <b className="block text-[15px] font-bold tracking-[-0.03em] tabular-nums text-plum">
                {v}
              </b>
              <span className="mt-1 block">{l}</span>
            </p>
          ))}
        </div>

        <button
          onClick={onToggle}
          aria-pressed={saved}
          className={
            "mt-3 flex items-center justify-center gap-2 rounded-full py-2.5 text-[12.5px] font-semibold transition " +
            (saved ? "bg-vio text-white" : "bg-tint text-plum hover:bg-line")
          }
        >
          {saved ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 12.5 9.5 18 20 6.5" />
            </svg>
          ) : null}
          {saved ? "Saved" : "Save for later"}
        </button>
      </div>
    </article>
  );
}
