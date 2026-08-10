"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { gradientForMeal } from "@/lib/recipes";

export interface DayMeal {
  name: string;
  type: "breakfast" | "lunch" | "dinner" | "snack";
  description: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fibre: number;
  minutes: number;
  ingredients: { name: string; quantity: string }[];
  image: string | null;
  cutout: string | null;
}
export interface DayFeed {
  day: string;
  meals: DayMeal[];
}
interface Targets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fibre: number;
}

/**
 * The hour each slot is assumed to be eaten at.
 *
 * This is the honest weak point of the screen and it is stated on the page rather than hidden: the
 * app does not yet know what you actually ate, so "already hit" means "the meals whose time has
 * passed". Once `log_meal` is wired in, this table is replaced by the log and nothing else about
 * the screen changes. Keyed by slot rather than by position, so a four-meal day still sorts into
 * chronological order instead of breakfast-lunch-dinner-snack.
 */
const SLOT_HOUR: Record<DayMeal["type"], number> = {
  breakfast: 8,
  lunch: 13,
  snack: 16.5,
  dinner: 19.5,
};
const SLOT_LABEL: Record<DayMeal["type"], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  snack: "Snack",
  dinner: "Dinner",
};
const clock = (h: number) =>
  `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;

export function TodayClient({ week, targets }: { week: DayFeed[]; targets: Targets }) {
  // Server render and first client render agree on this: the start of Monday, nothing eaten. The
  // effect then moves it to the reader's real day and hour. Rendering the clock during the first
  // pass instead would be a hydration mismatch, and on the static export it would bake in the
  // build machine's Tuesday afternoon forever.
  const [now, setNow] = useState<{ dayIndex: number; hour: number; forced: boolean } | null>(null);
  useEffect(() => {
    const d = new Date();
    // `?at=13` pins the hour. A screen whose whole state is "what time is it" can otherwise only be
    // reviewed at whatever o'clock you happen to open it — at 21:30 every meal is behind you and
    // the interesting half of the design is invisible. The override announces itself on the page,
    // so a preview can never be mistaken for the real thing.
    const at = Number(new URLSearchParams(window.location.search).get("at"));
    const forced = Number.isFinite(at) && at >= 0 && at < 24;
    setNow({
      // getDay() is Sunday-first; the engine's week is Monday-first.
      dayIndex: (d.getDay() + 6) % 7,
      hour: forced ? at : d.getHours() + d.getMinutes() / 60,
      forced,
    });
  }, []);

  const dayIndex = Math.min(now?.dayIndex ?? 0, week.length - 1);
  const hour = now?.hour ?? 0;
  const today = week[dayIndex];

  const ordered = today.meals.slice().sort((a, b) => SLOT_HOUR[a.type] - SLOT_HOUR[b.type]);
  const eaten = ordered.filter((m) => hour >= SLOT_HOUR[m.type]);
  const ahead = ordered.filter((m) => hour < SLOT_HOUR[m.type]);

  // If the day is done, the next dish is genuinely tomorrow's first — say so rather than showing
  // an empty slot or, worse, re-featuring something already eaten.
  const tomorrow = week[(dayIndex + 1) % week.length];
  const tomorrowFirst = tomorrow.meals
    .slice()
    .sort((a, b) => SLOT_HOUR[a.type] - SLOT_HOUR[b.type])[0];
  const next = ahead[0] ?? tomorrowFirst;
  const nextIsTomorrow = ahead.length === 0;

  const hit = {
    calories: eaten.reduce((s, m) => s + m.calories, 0),
    protein: eaten.reduce((s, m) => s + m.protein, 0),
    carbs: eaten.reduce((s, m) => s + m.carbs, 0),
    fat: eaten.reduce((s, m) => s + m.fat, 0),
    fibre: eaten.reduce((s, m) => s + m.fibre, 0),
  };

  const heroArt = next.cutout ?? next.image;

  return (
    <div className="min-h-screen bg-plum-deep px-5 pb-14 pt-7 text-white sm:px-8 xl:px-12">
      {/* ---------- the strip above the cards ---------- */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-white/60">
            {today.day}
            {now ? ` · ${clock(Math.floor(hour) + (hour % 1 >= 0.5 ? 0.5 : 0))}` : " · the day ahead"}
          </span>
          <h1 className="font-serif-display mt-3 text-[clamp(30px,3.8vw,50px)] font-semibold leading-[0.95] tracking-[-0.035em]">
            Today
          </h1>
          {now?.forced && (
            <p className="mt-2 text-[11px] text-white/60">
              Previewing this screen at {clock(hour)} — remove <code>?at=</code> for the real time.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link
            href="/sage/plan"
            className="rounded-full bg-white/10 px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-white/20"
          >
            The whole week
          </Link>
          <Link
            href="/sage/assistant"
            className="rounded-full bg-cream px-5 py-2.5 text-[12.5px] font-semibold text-panel transition hover:bg-white"
          >
            Change something
          </Link>
        </div>
      </div>

      <div className="grid gap-3.5 xl:grid-cols-[1.62fr_1fr]">
        {/* ================= THE MAIN CARD — sage-04's big cream panel ================= */}
        <article className="overflow-hidden rounded-[16px] bg-cream text-plum">
          <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
            {/* SLOT: the dish. sage-04 runs the plate to the card's own edge rather than insetting
                it, so the photograph is part of the card instead of sitting inside it. */}
            <div className="relative min-h-[260px] lg:min-h-[500px]">
              {heroArt ? (
                next.cutout ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-tint p-5">
                    <Image
                      src={next.cutout}
                      alt={next.name}
                      width={904}
                      height={904}
                      priority
                      sizes="(max-width: 1024px) 100vw, 34vw"
                      className="h-auto w-[118%] max-w-none drop-shadow-[0_26px_44px_rgba(28,36,25,0.28)]"
                    />
                  </div>
                ) : (
                  <Image
                    src={heroArt}
                    alt={next.name}
                    fill
                    priority
                    sizes="(max-width: 1024px) 100vw, 34vw"
                    className="object-cover"
                  />
                )
              ) : (
                /* No photograph of THIS dish — and it never borrows another's. Rather than set the
                   name a second time (it is already the heading beside this panel), the panel
                   carries what the dish is actually made of. */
                <div className="absolute inset-0 flex flex-col justify-center bg-tint p-6">
                  <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                    What goes in it
                  </span>
                  <ul className="mt-3">
                    {next.ingredients.map((ing) => (
                      <li
                        key={ing.name}
                        className="flex items-baseline justify-between gap-3 border-t border-plum/12 py-2 text-[12px]"
                      >
                        <span className="min-w-0 flex-1 truncate">{ing.name}</span>
                        <span className="shrink-0 tabular-nums text-mut">{ing.quantity}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <span className="absolute left-5 top-5 rounded-full bg-panel px-3 py-1.5 text-[9.5px] font-bold uppercase tracking-[0.16em] text-white">
                {nextIsTomorrow ? "Tomorrow" : "Up next"} · {SLOT_LABEL[next.type]}
              </span>
            </div>

            <div className="p-6 sm:p-8">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                {nextIsTomorrow
                  ? `First thing tomorrow · ${clock(SLOT_HOUR[next.type])}`
                  : `${SLOT_LABEL[next.type]} at ${clock(SLOT_HOUR[next.type])} · ${next.minutes} min to cook`}
              </span>
              <h2 className="font-serif-display mt-3 text-balance text-[clamp(26px,2.6vw,36px)] font-semibold leading-[1.04] tracking-[-0.03em]">
                {next.name}
              </h2>
              <p className="mt-2.5 max-w-[46ch] text-[13px] leading-relaxed text-plum-mid">
                {next.description}
              </p>

              {/* ---- the three circles: what the day has ALREADY hit ---- */}
              <div className="mt-7 flex flex-wrap gap-7 border-t border-line pt-6">
                <Gauge label="Calories" value={hit.calories} target={targets.calories} unit="kcal" />
                <Gauge label="Protein" value={hit.protein} target={targets.protein} unit="g" />
                <Gauge label="Fibre" value={hit.fibre} target={targets.fibre} unit="g" />
              </div>
              <p className="mt-4 text-[11.5px] leading-relaxed text-mut">
                {eaten.length === 0
                  ? "Nothing behind you yet — the whole day is still ahead."
                  : `Counted from ${eaten.length === 1 ? "the meal" : `the ${eaten.length} meals`} whose time has passed. The app does not know what you actually ate yet, and says so rather than guessing.`}
              </p>

              {/* ---- below the circles: the meals still to come ---- */}
              <div className="mt-7 border-t border-line pt-5">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                  {ahead.length ? `Still to come · ${ahead.length}` : "Nothing left today"}
                </span>
                <ul className="mt-3 flex flex-col gap-2">
                  {ahead.map((m) => (
                    <li
                      key={m.name}
                      className="flex items-center gap-4 rounded-[10px] bg-tint px-4 py-3"
                    >
                      <span className="w-[62px] shrink-0 text-[9.5px] font-bold uppercase tracking-[0.14em] text-mut">
                        {clock(SLOT_HOUR[m.type])}
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="line-clamp-2 block text-[13.5px] font-semibold leading-snug tracking-[-0.01em]">
                          {m.name}
                        </b>
                        <span className="text-[10.5px] tabular-nums text-mut">
                          {SLOT_LABEL[m.type]} · {m.minutes} min
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-[10.5px] tabular-nums text-mut">
                        <b className="block text-[14px] font-bold tracking-[-0.02em] text-plum">
                          {m.calories}
                        </b>
                        {m.protein} g protein
                      </span>
                    </li>
                  ))}
                  {ahead.length === 0 && (
                    <li className="rounded-[10px] bg-tint px-4 py-3 text-[12.5px] text-plum-mid">
                      Every meal is behind you. Tomorrow opens with {tomorrowFirst.name}.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        </article>

        {/* ================= THE RIGHT STACK — sage-04's column of smaller cards ============= */}
        <div className="grid content-start gap-3.5">
          <section className="rounded-[16px] bg-cream p-6 text-plum">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                Still to hit
              </h2>
              <span className="text-[10.5px] tabular-nums text-mut">
                {ahead.length} {ahead.length === 1 ? "meal" : "meals"} left to carry it
              </span>
            </div>
            <div className="mt-5">
              {(
                [
                  ["Calories", hit.calories, targets.calories, "kcal"],
                  ["Protein", hit.protein, targets.protein, "g"],
                  ["Carbohydrate", hit.carbs, targets.carbs, "g"],
                  ["Fat", hit.fat, targets.fat, "g"],
                  ["Fibre", hit.fibre, targets.fibre, "g"],
                ] as const
              ).map(([label, value, target, unit]) => (
                <div key={label} className="border-t border-line py-3 first:border-0 first:pt-0">
                  <div className="flex items-baseline justify-between text-[12px]">
                    <span className="text-mut">{label}</span>
                    <span className="tabular-nums">
                      <b className="text-[14px] font-bold tracking-[-0.02em]">
                        {Math.max(0, target - value).toLocaleString()}
                      </b>
                      <span className="ml-1 text-[10.5px] text-mut">{unit} to go</span>
                    </span>
                  </div>
                  <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-tint">
                    <div
                      className="h-full bg-vio"
                      style={{ width: `${Math.min(100, Math.round((value / target) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[16px] bg-cream p-6 text-plum">
            <h2 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
              Behind you
            </h2>
            {eaten.length === 0 ? (
              <p className="mt-3 text-[12.5px] leading-relaxed text-plum-mid">
                Nothing yet. The first thing today is {ordered[0].name} at{" "}
                {clock(SLOT_HOUR[ordered[0].type])}.
              </p>
            ) : (
              <ul className="mt-3">
                {eaten.map((m) => (
                  <li
                    key={m.name}
                    className="flex items-center gap-3 border-t border-line py-2.5 first:border-0 first:pt-0"
                  >
                    <span className="relative h-9 w-9 shrink-0 overflow-hidden rounded-[6px]">
                      {m.image ? (
                        <Image src={m.image} alt="" fill sizes="36px" className="object-cover" />
                      ) : (
                        <span
                          className="absolute inset-0"
                          style={{ background: gradientForMeal(m.name) }}
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{m.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-mut">
                      {m.calories} kcal
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* ---------- sage-04's footer of small figures, straight on the dark ground ---------- */}
      <dl className="mt-8 grid gap-6 border-t border-white/12 pt-6 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ["Day total, planned", `${ordered.reduce((s, m) => s + m.calories, 0).toLocaleString()} kcal`, `against ${targets.calories.toLocaleString()}`],
            ["Protein, planned", `${ordered.reduce((s, m) => s + m.protein, 0)} g`, `against ${targets.protein} g`],
            ["Cooking left today", `${ahead.reduce((s, m) => s + m.minutes, 0)} min`, `across ${ahead.length} ${ahead.length === 1 ? "meal" : "meals"}`],
            ["Where the numbers come from", "USDA", "derived from ingredients, never written on the card"],
          ] as const
        ).map(([term, value, note]) => (
          <div key={term}>
            <dt className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-white/60">
              {term}
            </dt>
            <dd className="mt-2 text-[19px] font-bold tracking-[-0.03em] tabular-nums">{value}</dd>
            <dd className="mt-1 max-w-[30ch] text-[11px] leading-relaxed text-white/60">{note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * One arc. Plain SVG rather than a chart library: it is a single stroked circle with a dash offset,
 * and a dependency for that would be more code than the code.
 *
 * The ring is capped at 100% so an over-target day cannot draw a second lap, but the NUMBER is
 * never capped — the figure is what it is, and hiding an overshoot would be the kind of quiet
 * dishonesty the engine exists to prevent.
 */
function Gauge({
  label,
  value,
  target,
  unit,
}: {
  label: string;
  value: number;
  target: number;
  unit: string;
}) {
  const pct = target > 0 ? Math.min(1, value / target) : 0;
  const R = 33;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[92px] w-[92px]">
        <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
          <circle cx="40" cy="40" r={R} fill="none" stroke="var(--color-tint)" strokeWidth="6" />
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            stroke="var(--color-vio)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center">
          <span className="text-center">
            <b
              className={
                "block font-bold leading-none tracking-[-0.04em] tabular-nums " +
                (value >= 1000 ? "text-[19px]" : "text-[23px]")
              }
            >
              {value.toLocaleString()}
            </b>
            <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-[0.12em] text-mut">
              {unit}
            </span>
          </span>
        </span>
      </div>
      <span className="mt-2.5 text-[9.5px] font-bold uppercase tracking-[0.16em] text-mut">
        {label}
      </span>
      <span className="mt-0.5 text-[10.5px] tabular-nums text-mut">
        of {target.toLocaleString()}
      </span>
    </div>
  );
}
