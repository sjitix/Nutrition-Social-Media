"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Aisle } from "@/lib/grocery";
import { loadGroceriesChecked, saveGroceriesChecked } from "@/lib/storage";
import { loadMyWeek, groceriesFromWeek, PLAN_CHANGED_EVENT, type GroceryRow } from "../myPlan";
import { bulkGroceriesFromWeek, batchEfficiency, type SessionGroceries, type BatchEfficiency } from "@/lib/batchGrocery";

// A batch tick is keyed by session so the same staple in two cook sessions ticks independently.
const bkey = (sessionId: string, name: string) => `${sessionId}::${name}`;

export type Row = GroceryRow;
type Groups = { aisle: Aisle; items: Row[] }[];

/**
 * The shopping list, built from THIS person's week when they have one (myPlan.loadMyWeek), and from
 * the shared demo week otherwise. The list, the counts and the copy button all live here on the
 * client, so a personalised week and its list never disagree.
 *
 * Ticks survive a reload and are stored through storage.ts (KEYS.groceriesChecked) — one key, so
 * "clear my data" actually clears them, and no second hardcoded key drifts from the rest of the app.
 * The stored set is intersected with the current list on load so an item that left your week does
 * not linger as a phantom tick, and the write only happens after the first read (persisting an empty
 * set over real data was a bug this codebase shipped once).
 */
export function GroceriesClient({ demoGroups }: { demoGroups: Groups }) {
  const [groups, setGroups] = useState<Groups>(demoGroups);
  const [batch, setBatch] = useState<{ sessions: SessionGroceries[]; eff: BatchEfficiency } | null>(null);
  const [personalized, setPersonalized] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Load on mount, and re-read in place on a mode/cadence switch (PLAN_CHANGED_EVENT) — no reload.
    const refresh = () => {
      const mine = loadMyWeek();
      if (mine && mine.week.planMode === "batch") {
        // Meal-prep: a per-cooking-session BULK list, not a per-slot count.
        const sessions = bulkGroceriesFromWeek(mine.week);
        setBatch({ sessions, eff: batchEfficiency(mine.week) });
        setPersonalized(true);
        const names = new Set(sessions.flatMap((s) => s.aisles.flatMap((a) => a.items.map((it) => bkey(s.session.id, it.name)))));
        setTicked(new Set(loadGroceriesChecked().filter((n) => names.has(n))));
        setLoaded(true);
        return;
      }
      setBatch(null); // switching batch -> fresh: drop the batch view
      const g = mine ? groceriesFromWeek(mine.week) : demoGroups;
      if (mine) {
        setGroups(g);
        setPersonalized(true);
      }
      const names = new Set(g.flatMap((x) => x.items.map((i) => i.name)));
      setTicked(new Set(loadGroceriesChecked().filter((n) => names.has(n))));
      setLoaded(true);
    };
    refresh();
    window.addEventListener(PLAN_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, refresh);
    // Runs once; demoGroups is stable within a page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return; // never write before the first read, or we persist an empty set over real data
    saveGroceriesChecked([...ticked]);
  }, [ticked, loaded]);

  const all = groups.flatMap((g) => g.items);

  function toggle(name: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function copyList() {
    const text = groups
      .map(
        (g) =>
          `${g.aisle}\n` +
          g.items.map((i) => `  ${i.name}${i.count > 1 ? ` ×${i.count}` : ""} — ${i.quantity}`).join("\n"),
      )
      .join("\n\n");
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }

  const done = ticked.size;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  if (batch) {
    const rows = batch.sessions.flatMap((s) => s.aisles.flatMap((a) => a.items));
    const copyBatch = () => {
      const text = batch.sessions
        .map((s) =>
          `${s.session.label ?? `${s.session.cookDay} cook`} (covers ${s.session.coversDays.join(", ")})\n` +
          s.aisles.map((a) => `  ${a.aisle}\n` + a.items.map((it) => `    ${it.name} — ${it.quantity}`).join("\n")).join("\n"),
        )
        .join("\n\n");
      navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {});
    };
    const tiles = [
      { big: `${batch.eff.cookEvents}`, sub: `dishes to cook · fresh cooks ${batch.eff.freshCookEvents}×` },
      { big: `${batch.eff.sessions}`, sub: "shopping trips" },
      { big: `${batch.eff.distinctDishes}`, sub: "distinct dishes" },
      { big: `${batch.eff.sharedIngredients}`, sub: "shared staples" },
    ];
    return (
      <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
        <div className="flex flex-wrap items-end justify-between gap-5 border-b border-plum/25 pb-6">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
              Meal-prep list · {batch.eff.sessions} cook sessions · {rows.length} items
            </span>
            <h1 className="font-serif-display mt-4 max-w-[14ch] text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
              Shop once per cook.
            </h1>
          </div>
          <button onClick={copyBatch} className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line">
            {copied ? "Copied!" : "Copy list"}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.sub} className="rounded-[12px] bg-cream px-4 py-4">
              <p className="font-serif-display text-[30px] font-semibold leading-none tabular-nums">{t.big}</p>
              <p className="mt-2 text-[11px] leading-snug text-mut">{t.sub}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 space-y-5">
          {batch.sessions.map((s) => (
            <div key={s.session.id} className="overflow-hidden rounded-[12px] bg-cream">
              <div className="border-b border-line bg-tint px-6 py-4">
                <h2 className="font-serif-display text-[19px] font-semibold tracking-[-0.01em]">{s.session.label ?? `${s.session.cookDay} cook`}</h2>
                <p className="mt-0.5 text-[11.5px] text-mut">Covers {s.session.coversDays.join(", ")}{s.coverage < 1 ? " · some amounts to check" : ""}</p>
              </div>
              {s.aisles.map(({ aisle, items }) => (
                <section key={aisle} className="border-b border-line px-6 py-4 last:border-b-0">
                  <h3 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">{aisle}</h3>
                  <ul className="mt-1">
                    {items.map((it) => {
                      const k = bkey(s.session.id, it.name);
                      const on = ticked.has(k);
                      return (
                        <li key={it.name} className="flex items-center gap-3.5 border-b border-line py-2.5 last:border-b-0">
                          <button role="checkbox" aria-checked={on} aria-label={it.name} onClick={() => toggle(k)}
                            className={"grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border-[1.6px] transition " + (on ? "border-vio bg-vio" : "border-plum/25 bg-transparent hover:border-vio")}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={on ? "opacity-100" : "opacity-0"}>
                              <path d="M5 12.5 10 17.5 19 7" />
                            </svg>
                          </button>
                          <span className={"flex-1 text-[14px] transition " + (on ? "text-mut line-through" : "")}>{it.name}</span>
                          <span className="text-[12.5px] font-semibold text-plum tabular-nums">{it.quantity}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ))}
        </div>

        <p className="mt-6 text-[11.5px] leading-relaxed text-mut">
          Quantities are bulk totals for each cooking session — cook once, portion across the days. Shelf-life and pack sizes are a coarse guide.
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-plum/25 pb-6">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
            {personalized ? "Your list" : "Sample list"} · {all.length} items · {groups.length} aisles · one week
          </span>
          <h1 className="font-serif-display mt-4 max-w-[12ch] text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
            Everything you need.
          </h1>
          {!personalized && (
            <Link
              href="/onboarding"
              className="mt-3 inline-block text-[12.5px] font-semibold text-vio hover:text-vio-deep"
            >
              Build your own plan for your real shopping list →
            </Link>
          )}
        </div>
        <button
          onClick={copyList}
          className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line"
        >
          {copied ? "Copied!" : "Copy list"}
        </button>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_312px] lg:items-start">
        <div className="overflow-hidden rounded-[12px] bg-cream">
          {groups.map(({ aisle, items }) => {
            const left = items.filter((i) => !ticked.has(i.name)).length;
            return (
              <section key={aisle} className="border-b border-line px-6 py-5 last:border-b-0">
                <h2 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                  {aisle} <span className="tabular-nums opacity-60">{left ? `${left} left` : "done"}</span>
                </h2>
                <ul className="mt-1">
                  {items.map((it) => {
                    const on = ticked.has(it.name);
                    return (
                      <li
                        key={it.name}
                        className="flex items-center gap-3.5 border-b border-line py-2.5 last:border-b-0"
                      >
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

        <aside className="rounded-[12px] bg-panel p-6 text-white lg:sticky lg:top-5">
          <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/60">In the trolley</span>
          <p className="mt-6 text-[54px] font-bold leading-[0.85] tracking-[-0.05em] tabular-nums">
            {done}
            <span className="ml-1.5 align-baseline text-[13px] font-medium tracking-normal text-white/60">
              of {all.length}
            </span>
          </p>
          <div className="mt-5 h-[3px] overflow-hidden rounded-full bg-white/15">
            <div className="h-full bg-white transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>

          <div className="mt-5 border-t border-white/15 pt-4">
            {groups.map(({ aisle, items }) => {
              const n = items.filter((i) => ticked.has(i.name)).length;
              return (
                <div
                  key={aisle}
                  className="flex items-baseline justify-between border-b border-white/10 py-2 text-[12px] last:border-b-0"
                >
                  <span className={n === items.length ? "text-white/55 line-through" : "text-white/60"}>{aisle}</span>
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
            Ticks are remembered on this device. A ×N badge means the ingredient appears in that many meals this week.
          </p>
        </aside>
      </div>
    </div>
  );
}
