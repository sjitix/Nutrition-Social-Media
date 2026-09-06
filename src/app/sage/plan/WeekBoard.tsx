"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { gradientForMeal, imageForMeal } from "@/lib/recipes";
import { RefreshIcon } from "@/components/icons";
import { SLOTS } from "../demo";
import { loadMyWeek, generateMyWeek } from "../myPlan";
import type { WeekStats } from "../weekStats";
import type { UserProfile } from "@/lib/types";

interface Targets {
  targetCalories: number;
  proteinGrams: number;
  mealsPerDay: number;
}
interface View {
  stats: WeekStats;
  targets: Targets;
  personalized: boolean;
  profile: UserProfile | null;
}

/**
 * The Week board. Renders the shared engine-built DEMO week on the server for a first visit, then —
 * on the client — swaps in THIS person's saved week if they have one (myPlan.loadMyWeek). Regenerate
 * rebuilds their week through the real engine (/api/plan); it is only offered once a plan is theirs,
 * because regenerating a sample is meaningless. Every figure still comes from summariseWeek, the one
 * copy of that arithmetic the whole app shares.
 */
export default function WeekBoard({ demo }: { demo: { stats: WeekStats; targets: Targets } }) {
  const [view, setView] = useState<View>({ ...demo, personalized: false, profile: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const mine = loadMyWeek();
    if (mine) {
      setView({
        stats: mine.stats,
        targets: {
          targetCalories: mine.profile.targetCalories,
          proteinGrams: mine.profile.proteinGrams,
          mealsPerDay: mine.profile.mealsPerDay,
        },
        personalized: true,
        profile: mine.profile,
      });
    }
  }, []);

  async function regenerate() {
    if (!view.profile) return;
    setBusy(true);
    setErr(null);
    try {
      const mine = await generateMyWeek(view.profile);
      setView((v) => ({ ...v, stats: mine.stats }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't regenerate just now.");
    } finally {
      setBusy(false);
    }
  }

  const { stats, targets, personalized } = view;
  const { days, avgKcal, avgProtein, avgFibre, lowest, uniqueDishes } = stats;
  const totalMeals = days.length * targets.mealsPerDay;

  const strip = days.map((d) => ({
    day: d.short,
    meal:
      d.meals.find((m) => imageForMeal(m.name)) ??
      d.meals.reduce((a, b) => (b.calories > a.calories ? b : a)),
  }));

  return (
    <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
          {personalized ? "Your plan" : "Sample week"} · {days.length} days · {totalMeals} meals ·{" "}
          {uniqueDishes} distinct dishes
        </span>
        <div className="flex flex-wrap gap-2">
          {personalized ? (
            <button
              onClick={regenerate}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line disabled:opacity-60"
            >
              {busy && <RefreshIcon className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Rebuilding…" : "Regenerate"}
            </button>
          ) : (
            <Link
              href="/onboarding"
              className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line"
            >
              Build my own plan
            </Link>
          )}
          <Link
            href="/sage/assistant"
            className="rounded-full bg-vio px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep"
          >
            Ask the assistant
          </Link>
        </div>
      </div>

      {!personalized && (
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] bg-tint px-4 py-3 text-[12.5px]">
          <span className="text-mut">
            This is a sample week built by the engine, the same for everyone.
          </span>
          <Link href="/onboarding" className="font-semibold text-vio hover:text-vio-deep">
            Set up your goals to make it yours →
          </Link>
        </div>
      )}
      {err && (
        <p className="mt-3 rounded-[10px] bg-red-50 px-4 py-3 text-[12.5px] text-red-700">{err}</p>
      )}

      {/* ---------- the photograph strip ---------- */}
      <ul className="mt-6 flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {strip.map(({ day, meal }) => {
          const img = imageForMeal(meal.name);
          return (
            <li key={day} className="w-[248px] shrink-0">
              <div className="relative h-[132px] overflow-hidden rounded-[10px]">
                {img ? (
                  <Image src={img} alt={meal.name} fill sizes="248px" className="object-cover" />
                ) : (
                  <span className="absolute inset-0" style={{ background: gradientForMeal(meal.name) }} />
                )}
                <span className="absolute left-3 top-3 rounded-full bg-cream px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.14em]">
                  {day}
                </span>
              </div>
              <p className="mt-2.5 truncate text-[12.5px] font-semibold tracking-[-0.01em]">
                {meal.name}
              </p>
              <p className="text-[10.5px] tabular-nums text-mut">
                {meal.calories} kcal · {meal.proteinGrams} g protein
              </p>
            </li>
          );
        })}
      </ul>

      {/* ---------- the heading, then the columns ---------- */}
      <div className="mt-12 flex flex-wrap items-end justify-between gap-5 border-b border-plum/25 pb-5">
        <h1 className="font-serif-display text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
          {personalized ? "Your weekly plan" : "Weekly plan"}
        </h1>
        <div className="flex gap-7 text-[11.5px]">
          {(
            [
              [avgKcal.toLocaleString(), `of ${targets.targetCalories.toLocaleString()} kcal`],
              [avgProtein, `of ${targets.proteinGrams} g protein`],
              [avgFibre, "g fibre"],
            ] as const
          ).map(([v, l]) => (
            <p key={l}>
              <b className="block text-[19px] font-bold leading-none tracking-[-0.03em] tabular-nums">
                {v}
              </b>
              <span className="mt-1 block text-mut">{l}</span>
            </p>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {days.map((d) => {
          const short = d.protein < targets.proteinGrams;
          return (
            <section key={d.day} className="flex flex-col gap-2" aria-label={d.day}>
              <div className="pb-1">
                <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-mut">{d.day}</h2>
                <p className="mt-1.5 text-[24px] font-bold leading-none tracking-[-0.04em] tabular-nums">
                  {d.kcal.toLocaleString()}
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-mut">{d.protein} g protein</p>
                <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-line">
                  <div
                    className={`h-full ${short ? "bg-mint" : "bg-vio"}`}
                    style={{
                      width: `${Math.min(100, Math.round((d.protein / targets.proteinGrams) * 100))}%`,
                    }}
                  />
                </div>
              </div>

              {d.meals.map((m, i) => (
                <article key={i} className="rounded-[10px] bg-tint p-4">
                  <span className="text-[8.5px] font-bold uppercase tracking-[0.16em] text-mut">
                    {SLOTS[i]}
                  </span>
                  <p className="mt-1.5 text-[13px] font-semibold leading-[1.25] tracking-[-0.01em]">
                    {m.name}
                  </p>
                  <p className="mt-2.5 border-t border-plum/12 pt-2 text-[10.5px] tabular-nums text-mut">
                    <b className="font-bold text-plum">{m.calories}</b> kcal ·{" "}
                    <b className="font-bold text-plum">{m.proteinGrams}</b> g · {m.timeMinutes} min
                  </p>
                </article>
              ))}

              {d.day === lowest.day && targets.proteinGrams - d.protein > 0 && (
                <div className="rounded-[10px] bg-panel p-4 text-white">
                  <p className="text-[8.5px] font-bold uppercase tracking-[0.16em] text-white/60">Short</p>
                  <p className="mt-1.5 text-[22px] font-bold leading-none tracking-[-0.04em] tabular-nums">
                    {targets.proteinGrams - d.protein} g
                  </p>
                  <p className="mt-2 text-[10.5px] leading-relaxed text-white/60">
                    under your protein target. The assistant can lift it without moving the calories.
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
