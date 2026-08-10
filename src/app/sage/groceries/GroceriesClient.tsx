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
    <div className="grid gap-4 lg:grid-cols-[1fr_300px] lg:items-start">
      <div className="card-shadow overflow-hidden rounded-3xl bg-white">
        {groups.map(({ aisle, items }) => {
          const left = items.filter((i) => !ticked.has(i.name)).length;
          return (
            <section key={aisle} className="border-b border-line px-6 py-5 last:border-b-0">
              <h2 className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-mut">
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
                          "grid h-5 w-5 shrink-0 place-items-center rounded-md border-[1.6px] transition " +
                          (on ? "border-vio bg-vio" : "border-line bg-white hover:border-vio")
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
                        <span className="rounded-full bg-lav px-2 py-0.5 text-[10.5px] font-bold text-vio tabular-nums">
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

      <aside className="card-shadow rounded-3xl bg-white p-5 lg:sticky lg:top-5">
        <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-mut">Progress</span>
        <p className="mt-2 flex items-baseline gap-1.5 text-[31px] font-bold leading-none tracking-[-0.045em] tabular-nums">
          {done}
          <em className="text-[13px] font-medium not-italic tracking-normal text-mut">of {all.length}</em>
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-vio transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-4 space-y-2.5 border-t border-line pt-3.5">
          {groups.map(({ aisle, items }) => {
            const n = items.filter((i) => ticked.has(i.name)).length;
            return (
              <div key={aisle} className="flex items-baseline justify-between text-[12.5px]">
                <span className={n === items.length ? "text-mut line-through" : "text-mut"}>{aisle}</span>
                <span className="font-semibold tabular-nums">
                  {n}/{items.length}
                </span>
              </div>
            );
          })}
        </div>

        {done > 0 && (
          <button
            onClick={() => setTicked(new Set())}
            className="mt-4 w-full rounded-full border border-line py-2.5 text-[13px] font-semibold transition hover:border-vio"
          >
            Untick all
          </button>
        )}

        <p className="mt-4 border-t border-line pt-3.5 text-[12.5px] leading-relaxed text-mut">
          Ticks are remembered on this device. A ×N badge means the ingredient appears in that many
          meals this week.
        </p>
      </aside>
    </div>
  );
}
