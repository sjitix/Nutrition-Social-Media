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
 * Today — a straight reproduction of `designs/references/boards/sage-04`.
 *
 * The board's composition, which is what this file is:
 *
 *   a near-black forest PAGE, and on it
 *   ├─ ONE large cream card, filling the left ~62%:
 *   │    · its own small nav row — mark, two links, then a label and three small circles
 *   │    · LEFT of the card: a serif headline of two lines, a short paragraph, and beneath them a
 *   │      HUGE ROUND PLATE cropped by the card's own bottom edge
 *   │    · RIGHT of the card: a caption, THREE THICK RINGS with a number in each, two hairline
 *   │      spec rows, then three outlined rows each led by a dot
 *   └─ a stack of smaller cream cards down the right:
 *        · a segmented DONUT beside bar rows, with a dark pill at its top right
 *        · bar rows carrying a TARGET TICK, and a filled green circle at the bottom right
 *        · a photograph beside a green panel
 *   and under all of it, small figures set straight on the dark ground beside an outlined box.
 *
 * A first pass at this screen invented its own arrangement of the same ingredients and was
 * rejected — "this is definitely not what I showed you". The parts were right and the composition
 * was not, which is the same failure as WORKPLAN lesson 15, one screen later.
 *
 * WHAT EACH PART HOLDS was Ana's brief: the plate is the dish coming up NEXT, the three rings are
 * the macros already HIT, and the day's remaining meals are the rows below them.
 *
 * The clock is read in the BROWSER — see the effect below — and every figure is the engine's.
 */

/**
 * The hour each slot is assumed to be eaten at.
 *
 * The honest weak point of the screen, stated on the page rather than hidden: nothing writes a
 * meal log yet, so a meal counts as eaten when its slot time has passed. When `log_meal` is wired
 * up this table is replaced by the log and nothing else here changes. Keyed by slot, not by
 * position, so a four-meal day still sorts chronologically.
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
const clock = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;

export function TodayClient({ week, targets }: { week: DayFeed[]; targets: Targets }) {
  // Server render and first client render agree: the start of Monday, nothing eaten. The effect
  // then moves it to the reader's real day and hour. Reading the clock during the first pass would
  // be a hydration mismatch, and on the static export it would bake in the build machine's clock.
  const [now, setNow] = useState<{ dayIndex: number; hour: number; forced: boolean } | null>(null);
  useEffect(() => {
    const d = new Date();
    // `?at=13` pins the hour. A screen whose whole state is "what time is it" can otherwise only be
    // reviewed at whatever o'clock you open it — at 21:30 every meal is behind you and half the
    // design is invisible. It announces itself on the page, so it cannot pass for the real thing.
    const at = Number(new URLSearchParams(window.location.search).get("at"));
    const forced = Number.isFinite(at) && at >= 0 && at < 24;
    setNow({
      dayIndex: (d.getDay() + 6) % 7, // getDay() is Sunday-first; the engine's week is Monday-first
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

  // If the day is done the next dish is genuinely tomorrow's first — say so, rather than leaving
  // the plate empty or re-featuring something already eaten.
  const tomorrow = week[(dayIndex + 1) % week.length];
  const tomorrowFirst = tomorrow.meals.slice().sort((a, b) => SLOT_HOUR[a.type] - SLOT_HOUR[b.type])[0];
  const next = ahead[0] ?? tomorrowFirst;
  const after = ahead[1] ?? null;
  const nextIsTomorrow = ahead.length === 0;

  const sum = (list: DayMeal[], pick: (m: DayMeal) => number) => list.reduce((s, m) => s + pick(m), 0);
  const hit = {
    calories: sum(eaten, (m) => m.calories),
    protein: sum(eaten, (m) => m.protein),
    carbs: sum(eaten, (m) => m.carbs),
    fat: sum(eaten, (m) => m.fat),
    fibre: sum(eaten, (m) => m.fibre),
  };
  const planned = {
    calories: sum(ordered, (m) => m.calories),
    protein: sum(ordered, (m) => m.protein),
    carbs: sum(ordered, (m) => m.carbs),
    fat: sum(ordered, (m) => m.fat),
    fibre: sum(ordered, (m) => m.fibre),
  };

  // Atwater: 4 kcal per gram of protein and carbohydrate, 9 per gram of fat. The split is computed,
  // not apportioned — it is what the day's own ingredients add up to.
  const kc = { carbs: planned.carbs * 4, protein: planned.protein * 4, fat: planned.fat * 9 };
  const kcTotal = kc.carbs + kc.protein + kc.fat || 1;
  const eatenShare = planned.calories ? Math.round((hit.calories / planned.calories) * 100) : 0;

  return (
    <div className="min-h-screen bg-plum-deep px-4 pb-10 pt-5 text-white sm:px-6 sm:pb-14 sm:pt-7 xl:px-9">
      <div className="grid gap-3 xl:grid-cols-[1.62fr_1fr]">
        {/* ══════════════ THE BIG CREAM CARD ══════════════ */}
        <article className="relative overflow-hidden rounded-[20px] bg-cream px-7 pt-7 text-plum sm:px-9 sm:pt-8">
          {/* the card's own nav row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <span className="flex items-center gap-2.5">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-vio">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fbf9f2" strokeWidth="2.3" strokeLinecap="round" aria-hidden>
                    <path d="M4 15.5c3.5 0 4.5-7 8-7s4.5 7 8 7" />
                  </svg>
                </span>
                <b className="text-[12.5px] font-bold tracking-[-0.01em]">NutriFlow</b>
              </span>
              <Link href="/sage/plan" className="text-[11.5px] text-mut hover:text-plum">
                The week
              </Link>
              <Link href="/sage/groceries" className="text-[11.5px] text-mut hover:text-plum">
                Groceries
              </Link>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="text-[10.5px] tabular-nums text-mut">
                {today.day}
                {now ? ` · ${clock(Math.floor(hour) + (hour % 1 >= 0.5 ? 0.5 : 0))}` : ""}
              </span>
              <span className="grid h-6 w-6 place-items-center rounded-full bg-tint">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3d5233" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M12 21c0-7 4-11 9-11-1 7-4 11-9 11zM12 21c0-5-3-8-7-8 1 5 3 8 7 8z" />
                </svg>
              </span>
              <span className="grid h-6 w-6 place-items-center rounded-full bg-vio text-[9.5px] font-bold text-white">
                A
              </span>
              <span className="h-6 w-6 rounded-full bg-panel" />
            </div>
          </div>

          {/* the two columns */}
          <div className="mt-9 grid gap-8 lg:grid-cols-[1.06fr_1fr]">
            {/* ─── left: headline, paragraph, and the plate cropped by the card ─── */}
            <div className="flex flex-col">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                {nextIsTomorrow ? "Tomorrow" : "Up next"} · {SLOT_LABEL[next.type]} ·{" "}
                {clock(SLOT_HOUR[next.type])}
              </span>
              <h1 className="font-serif-display mt-3 max-w-[14ch] text-balance text-[clamp(28px,2.9vw,42px)] font-semibold leading-[1.02] tracking-[-0.03em]">
                {next.name}
              </h1>
              <p className="mt-4 max-w-[42ch] text-[12.5px] leading-[1.7] text-plum-mid">
                {next.description} {nextIsTomorrow ? "First thing tomorrow" : SLOT_LABEL[next.type]}{" "}
                at {clock(SLOT_HOUR[next.type])}, {next.minutes} minutes to cook.
              </p>

              {/* SLOT: the plate. Round, oversized, and cropped by the bottom of the card — the
                  board runs it off the card edge rather than insetting it in a panel. It grows
                  LEFTWARDS (negative margin, not extra width) so it stays clear of the column of
                  rows beside it; growing rightwards put the rows on top of the food. */}
              <div className="relative mt-8 aspect-square w-full max-w-none self-start lg:-mb-[15%] lg:-ml-[12%] lg:w-[112%]">
                {next.cutout ? (
                  <Image
                    src={next.cutout}
                    alt={next.name}
                    width={904}
                    height={904}
                    priority
                    sizes="(max-width: 1024px) 100vw, 34vw"
                    className="h-full w-full object-contain drop-shadow-[0_30px_50px_rgba(28,36,25,0.24)]"
                  />
                ) : next.image ? (
                  <div className="h-full w-full overflow-hidden rounded-full shadow-[0_30px_50px_rgba(28,36,25,0.24)]">
                    <Image
                      src={next.image}
                      alt={next.name}
                      width={904}
                      height={904}
                      priority
                      sizes="(max-width: 1024px) 100vw, 34vw"
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : (
                  /* No photograph of THIS dish, and it never borrows another's. The plate keeps
                     its shape and carries what the dish is made of.
                     Fixed sage, NOT `gradientForMeal` — the card tiles hash a name onto fourteen
                     hues, which is right for a wall of cards and wrong here: it made the plate
                     dusty pink on a cream card. A plate is a plate; its colour should not be a
                     hash of the dish name. */
                  <div className="grid h-full w-full place-items-center rounded-full bg-tint p-[15%] text-center shadow-[0_30px_50px_rgba(28,36,25,0.16)]">
                    <div className="w-full">
                      <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-mut">
                        What goes in it
                      </span>
                      <ul className="mt-3">
                        {next.ingredients.slice(0, 5).map((ing) => (
                          <li
                            key={ing.name}
                            className="flex items-baseline justify-between gap-4 border-t border-plum/15 py-1.5 text-[11.5px]"
                          >
                            <span className="truncate">{ing.name}</span>
                            <span className="shrink-0 tabular-nums text-mut">{ing.quantity}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ─── right: caption, rings, spec rows, the outlined rows ─── */}
            <div className="pb-8">
              <p className="text-[11.5px]">
                <b className="font-semibold">Already hit today</b>{" "}
                <span className="text-mut">
                  {eaten.length
                    ? `from ${eaten.length} ${eaten.length === 1 ? "meal" : "meals"} behind you`
                    : "nothing yet — the day is still ahead"}
                </span>
              </p>

              <div className="mt-5 grid grid-cols-3 gap-2">
                <Ring label="Calories" value={hit.calories} target={targets.calories} unit="kcal" />
                <Ring label="Protein" value={hit.protein} target={targets.protein} unit="g" />
                <Ring label="Fibre" value={hit.fibre} target={targets.fibre} unit="g" />
              </div>

              {/* the board's two hairline spec rows, the second with a leader rule */}
              <div className="mt-7">
                <p className="text-[11.5px]">
                  <b className="font-semibold">Target</b>{" "}
                  <span className="text-mut">
                    {targets.calories.toLocaleString()} kcal · {targets.protein} g protein ·{" "}
                    {targets.fibre} g fibre
                  </span>
                </p>
                <p className="mt-2 flex items-baseline gap-3 text-[11.5px] text-mut">
                  <span className="shrink-0">Cooking left today</span>
                  <span className="h-px flex-1 bg-line" />
                  <span className="shrink-0 tabular-nums text-plum">
                    {sum(ahead, (m) => m.minutes)} min across {ahead.length}
                  </span>
                </p>
              </div>

              <div className="mt-5 flex flex-col gap-2.5">
                {ahead.map((m) => (
                  <div
                    key={m.name}
                    className="rounded-[14px] border border-line px-4 py-3.5"
                  >
                    <div className="flex items-baseline gap-2.5">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-vio" />
                      <b className="min-w-0 flex-1 text-[13px] font-semibold leading-snug tracking-[-0.01em]">
                        {m.name}
                      </b>
                      <span className="shrink-0 text-[12px] font-bold tabular-nums">
                        {m.calories}
                        <span className="ml-1 text-[9.5px] font-medium text-mut">kcal</span>
                      </span>
                    </div>
                    <p className="mt-1.5 pl-4 text-[10.5px] tabular-nums text-mut">
                      {SLOT_LABEL[m.type]} · {clock(SLOT_HOUR[m.type])} · {m.minutes} min ·{" "}
                      {m.protein} g protein · {m.fibre} g fibre
                    </p>
                  </div>
                ))}
                {ahead.length === 0 && (
                  <div className="rounded-[14px] border border-line px-4 py-3.5 text-[12px] text-plum-mid">
                    Every meal is behind you. Tomorrow opens with {tomorrowFirst.name}.
                  </div>
                )}
              </div>
            </div>
          </div>
        </article>

        {/* ══════════════ THE RIGHT STACK ══════════════ */}
        <div className="grid content-start gap-3">
          {/* card A — the segmented donut beside bar rows, dark pill top right */}
          <section className="rounded-[20px] bg-cream p-6 text-plum">
            <div className="flex items-center justify-between">
              <h2 className="text-[11.5px] font-semibold">Where today&rsquo;s calories sit</h2>
              <div className="flex items-center gap-2.5">
                <span className="text-[10.5px] tabular-nums text-mut">
                  {planned.calories.toLocaleString()} kcal
                </span>
                <Link
                  href="/sage/plan"
                  className="rounded-full bg-panel px-3.5 py-1.5 text-[10.5px] font-semibold text-white"
                >
                  The week
                </Link>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-6">
              <Donut
                segments={[
                  { value: kc.carbs / kcTotal, opacity: 0.92 },
                  { value: kc.protein / kcTotal, opacity: 0.66 },
                  { value: kc.fat / kcTotal, opacity: 0.42 },
                ]}
              />
              <div className="min-w-0 flex-1">
                {(
                  [
                    ["Carbohydrate", planned.carbs, targets.carbs, 0.92],
                    ["Protein", planned.protein, targets.protein, 0.66],
                    ["Fat", planned.fat, targets.fat, 0.42],
                  ] as const
                ).map(([label, grams, target, op]) => (
                  <div key={label} className="border-t border-line py-2.5 first:border-0 first:pt-0">
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-mut">{label}</span>
                      <span className="tabular-nums">
                        <b className="text-[12.5px] font-bold">{grams}</b>
                        <span className="text-mut"> g of {target}</span>
                      </span>
                    </div>
                    {/* The bar reads against the TARGET, matching the "x g of y" beside it. It
                        used to read against the calorie split, so a bar and its own label
                        disagreed about what fraction they were showing. */}
                    <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-tint">
                      <div
                        className="h-full rounded-full bg-vio"
                        style={{
                          width: `${Math.min(100, Math.round((grams / target) * 100))}%`,
                          opacity: op,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <p className="mt-4 border-t border-line pt-3 text-[10.5px] leading-relaxed text-mut">
              The split is what the day&rsquo;s own ingredients add up to at 4 / 4 / 9 kcal per
              gram — not a share apportioned to fit.
            </p>
          </section>

          {/* card B — bars with a target tick, and the filled circle bottom right */}
          <section className="rounded-[20px] bg-cream p-6 text-plum">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[11.5px] font-semibold">Where the plan lands</h2>
              <span className="text-[10.5px] tabular-nums text-mut">
                {planned.calories.toLocaleString()} of {targets.calories.toLocaleString()}
              </span>
            </div>

            <div className="mt-4">
              {(
                [
                  ["Calories", planned.calories, targets.calories],
                  ["Protein", planned.protein, targets.protein],
                  ["Fibre", planned.fibre, targets.fibre],
                ] as const
              ).map(([label, value, target]) => (
                <div key={label} className="flex items-center gap-3 py-2">
                  <span className="w-[54px] shrink-0 text-[10.5px] text-mut">{label}</span>
                  <span className="relative h-[7px] flex-1 overflow-visible rounded-full bg-tint">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-vio"
                      style={{ width: `${Math.min(100, Math.round((value / (target * 1.25)) * 100))}%` }}
                    />
                    {/* the target tick: where this bar is supposed to reach */}
                    <span
                      className="absolute -top-1 h-[15px] w-px bg-plum/45"
                      style={{ left: `${100 / 1.25}%` }}
                    />
                  </span>
                  <span className="w-[52px] shrink-0 text-right text-[11px] font-bold tabular-nums">
                    {value.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-4 border-t border-line pt-4">
              <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full bg-vio text-[14px] font-bold tabular-nums text-white">
                {eatenShare}%
              </span>
              <p className="text-[10.5px] leading-relaxed text-mut">
                of today&rsquo;s planned calories are behind you.{" "}
                {ahead.length
                  ? `${ahead.length} ${ahead.length === 1 ? "meal carries" : "meals carry"} the rest.`
                  : "The day is done."}
              </p>
            </div>
          </section>

          {/* card C — a photograph beside a green panel */}
          <section className="overflow-hidden rounded-[20px] bg-cream text-plum">
            <div className="grid grid-cols-[0.85fr_1fr]">
              <div className="relative min-h-[124px]">
                {after?.image ? (
                  <Image src={after.image} alt={after.name} fill sizes="180px" className="object-cover" />
                ) : (
                  <span
                    className="absolute inset-0"
                    style={{ background: gradientForMeal((after ?? tomorrowFirst).name) }}
                  />
                )}
              </div>
              <div className="bg-tint p-5">
                <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-mut">
                  {after ? "And after that" : "Opens tomorrow"}
                </span>
                <b className="mt-1.5 block text-[13px] font-semibold leading-snug">
                  {(after ?? tomorrowFirst).name}
                </b>
                <div className="mt-3 flex gap-4 border-t border-plum/12 pt-2.5 text-[9px] font-bold uppercase tracking-[0.12em] text-mut">
                  {(
                    [
                      [(after ?? tomorrowFirst).calories, "kcal"],
                      [`${(after ?? tomorrowFirst).protein}g`, "protein"],
                      [`${(after ?? tomorrowFirst).minutes}`, "min"],
                    ] as const
                  ).map(([v, l]) => (
                    <span key={l}>
                      <b className="block text-[13px] font-bold tracking-[-0.02em] tabular-nums text-plum">
                        {v}
                      </b>
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* ══════════════ the figures set straight on the dark ground ══════════════ */}
      <div className="mt-7 grid items-start gap-8 lg:grid-cols-[1fr_auto_1fr]">
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          {(
            [
              ["Day total, planned", `${planned.calories.toLocaleString()}`, `of ${targets.calories.toLocaleString()} kcal`],
              ["Protein, planned", `${planned.protein} g`, `of ${targets.protein} g`],
              ["Behind you", `${hit.calories.toLocaleString()}`, `kcal from ${eaten.length} ${eaten.length === 1 ? "meal" : "meals"}`],
            ] as const
          ).map(([term, value, note]) => (
            <div key={term}>
              <dt className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/60">
                {term}
              </dt>
              <dd className="mt-2 text-[19px] font-bold tracking-[-0.03em] tabular-nums">{value}</dd>
              <dd className="mt-0.5 text-[10.5px] text-white/60">{note}</dd>
            </div>
          ))}
        </dl>

        {/* the outlined box the board sets in the middle of that strip */}
        <div className="grid h-[74px] w-[118px] place-items-center rounded-[12px] border border-white/25">
          <svg width="34" height="18" viewBox="0 0 24 24" fill="none" stroke="#dfe6da" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <path d="M4 15.5c3.5 0 4.5-7 8-7s4.5 7 8 7" />
          </svg>
        </div>

        <div className="lg:justify-self-end">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/60">
            How these numbers exist
          </p>
          <ul className="mt-2.5 max-w-[34ch] text-[10.5px] leading-relaxed text-white/60">
            <li>Macros derived from ingredients against USDA, never written on the card.</li>
            <li className="mt-1">
              &ldquo;Already hit&rdquo; means the meals whose time has passed — nothing logs what
              you actually ate yet.
            </li>
            {now?.forced && (
              <li className="mt-1 text-white/75">
                Previewing at {clock(hour)}. Drop <code>?at=</code> for the real time.
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * One thick ring. Plain SVG: a stroked circle with a dash offset. A chart library for this would
 * be more code than the code.
 *
 * The ring caps at 100% so an over-target day cannot draw a second lap, but the NUMBER never caps
 * — the figure is what it is, and hiding an overshoot is the quiet dishonesty the engine exists to
 * prevent.
 */
function Ring({
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
  const R = 32;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex flex-col items-center">
      <div className="relative aspect-square w-full max-w-[104px]">
        <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
          <circle cx="40" cy="40" r={R} fill="none" stroke="var(--color-tint)" strokeWidth="9" />
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            stroke="var(--color-vio)"
            strokeOpacity="0.72"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center">
          <b
            className={
              "font-bold leading-none tracking-[-0.04em] tabular-nums text-vio " +
              (value >= 1000 ? "text-[18px]" : "text-[24px]")
            }
          >
            {value.toLocaleString()}
          </b>
        </span>
      </div>
      <span className="mt-2 text-[9px] font-bold uppercase tracking-[0.14em] text-mut">{label}</span>
      <span className="text-[10px] tabular-nums text-mut">
        {unit} of {target.toLocaleString()}
      </span>
    </div>
  );
}

/** The segmented donut. Same trick as the ring, one arc per segment with a small gap between. */
function Donut({ segments }: { segments: { value: number; opacity: number }[] }) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const GAP = 0.012; // a sliver of track between segments, as the board has
  let cursor = 0;
  return (
    <svg viewBox="0 0 80 80" className="h-[104px] w-[104px] shrink-0 -rotate-90">
      <circle cx="40" cy="40" r={R} fill="none" stroke="var(--color-tint)" strokeWidth="13" />
      {segments.map((s, i) => {
        const len = Math.max(0, s.value - GAP);
        const el = (
          <circle
            key={i}
            cx="40"
            cy="40"
            r={R}
            fill="none"
            stroke="var(--color-vio)"
            strokeOpacity={s.opacity}
            strokeWidth="13"
            strokeDasharray={`${C * len} ${C * (1 - len)}`}
            strokeDashoffset={-C * cursor}
          />
        );
        cursor += s.value;
        return el;
      })}
    </svg>
  );
}
