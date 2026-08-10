"use client";

import { useEffect, useState } from "react";
import type { Aisle } from "@/lib/grocery";

export interface Row {
  name: string;
  quantity: string;
  count: number;
}

const KEY = "nutriflow-sage-ticked";

/**
 * The shopping list with working check-offs.
 *
 * Ticks are stored so they survive a reload — a list that forgets what you already put in the
 * trolley is worse than no list. Storage is read in an effect rather than during render, because
 * the server has no localStorage and reading it inline would produce a hydration mismatch.
 *
 * The stored set is intersected with the current list on load, so an item that has left your week
 * does not linger as a phantom tick. The existing app shipped a bug of exactly this shape once —
 * an effect that persisted derived state before its source had loaded, wiping every tick — so the
 * write only happens after the first read has completed.
 */
export function GroceriesClient({ groups }: { groups: { aisle: Aisle; items: Row[] }[] }) {
  const all = groups.flatMap((g) => g.items);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const names = new Set<string>(JSON.parse(raw));
        // Drop anything no longer on the list rather than carrying it forever.
        setTicked(new Set(all.filter((i) => names.has(i.name)).map((i) => i.name)));
      }
    } catch {
      // Blocked storage costs the memory of the ticks, not the page.
    }
    setLoaded(true);
    // Runs once. `all` is derived from props that do not change within a page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return; // never write before the first read, or we persist an empty set over real data
    try {
      localStorage.setItem(KEY, JSON.stringify([...ticked]));
    } catch {
      /* see above */
    }
  }, [ticked, loaded]);

  function toggle(name: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const done = ticked.size;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_312px] lg:items-start">
      <div className="overflow-hidden rounded-[12px] bg-cream">
        {groups.map(({ aisle, items }) => {
          const left = items.filter((i) => !ticked.has(i.name)).length;
          return (
            <section key={aisle} className="border-b border-line px-6 py-5 last:border-b-0">
              <h2 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                {aisle}{" "}
                <span className="tabular-nums opacity-60">
                  {left ? `${left} left` : "done"}
                </span>
              </h2>
              <ul className="mt-1">
                {items.map((it) => {
                  const on = ticked.has(it.name);
                  return (
                    <li key={it.name} className="flex items-center gap-3.5 border-b border-line py-2.5 last:border-b-0">
                      <button
                        role="checkbox"
                        aria-checked={on}
                        aria-label={it.name}
                        onClick={() => toggle(it.name)}
                        className={
                          "grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border-[1.6px] transition " +
                          (on ? "border-vio bg-vio" : "border-plum/25 bg-transparent hover:border-vio")
                        }
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={on ? "opacity-100" : "opacity-0"}
                        >
                          <path d="M5 12.5 10 17.5 19 7" />
                        </svg>
                      </button>
                      <span className={"flex-1 text-[14px] transition " + (on ? "text-mut line-through" : "")}>
                        {it.name}
                      </span>
                      {it.count > 1 && (
                        <span className="rounded-full bg-tint px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-vio">
                          ×{it.count}
                        </span>
                      )}
                      <span className="text-[12.5px] text-mut tabular-nums">{it.quantity}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {/* The boards put one very large number on a deep panel and let everything else recede.
          Here that number is how much of the shop is done. */}
      <aside className="rounded-[12px] bg-panel p-6 text-white lg:sticky lg:top-5">
        <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/60">
          In the trolley
        </span>
        <p className="mt-6 text-[54px] font-bold leading-[0.85] tracking-[-0.05em] tabular-nums">
          {done}
          <span className="ml-1.5 align-baseline text-[13px] font-medium tracking-normal text-white/60">
            of {all.length}
          </span>
        </p>
        <div className="mt-5 h-[3px] overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full bg-white transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-5 border-t border-white/15 pt-4">
          {groups.map(({ aisle, items }) => {
            const n = items.filter((i) => ticked.has(i.name)).length;
            return (
              <div
                key={aisle}
                className="flex items-baseline justify-between border-b border-white/10 py-2 text-[12px] last:border-b-0"
              >
                <span className={n === items.length ? "text-white/55 line-through" : "text-white/60"}>
                  {aisle}
                </span>
                <span className="font-semibold tabular-nums text-white/85">
                  {n}/{items.length}
                </span>
              </div>
            );
          })}
        </div>

        {done > 0 && (
          <button
            onClick={() => setTicked(new Set())}
            className="mt-5 w-full rounded-full bg-white/10 py-2.5 text-[12.5px] font-semibold transition hover:bg-white/20"
          >
            Untick all
          </button>
        )}

        <p className="mt-5 border-t border-white/15 pt-4 text-[11.5px] leading-relaxed text-white/60">
          Ticks are remembered on this device. A ×N badge means the ingredient appears in that many
          meals this week.
        </p>
      </aside>
    </div>
  );
}
