"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export interface DayMeal {
  name: string;
  type: "breakfast" | "lunch" | "dinner" | "snack";
  description: string;
  calories: number;
  protein: number;
  fibre: number;
  minutes: number;
  image: string | null;
  cutout: string | null;
}
interface Targets {
  calories: number;
  protein: number;
  fibre: number;
}

/**
 * The hour each slot is assumed to be eaten at.
 *
 * The honest weak point of the screen, and it is stated on the page rather than hidden: nothing
 * writes a meal log yet, so a meal counts as eaten once its slot time has passed. When `log_meal`
 * is wired up this table is replaced by the log and nothing else here changes. Keyed by slot, not
 * by position, so a four-meal day still sorts chronologically.
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

export function TodayClient({
  day,
  meals,
  targets,
}: {
  day: string;
  meals: DayMeal[];
  targets: Targets;
}) {
  // Server render and first client render agree: the start of the day, nothing eaten. An effect
  // then moves it to the reader's real hour. Reading the clock during the first pass would be a
  // hydration mismatch, and on the static export it would bake in the build machine's clock.
  const [hour, setHour] = useState(0);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const at = Number(new URLSearchParams(window.location.search).get("at"));
    const ok = Number.isFinite(at) && at >= 0 && at < 24;
    setPinned(ok);
    // `?at=13` pins the hour for review: a screen whose whole state is "what time is it" can
    // otherwise only be judged at whatever o'clock you open it.
    setHour(ok ? at : new Date().getHours() + new Date().getMinutes() / 60);
  }, []);

  const ordered = meals.slice().sort((a, b) => SLOT_HOUR[a.type] - SLOT_HOUR[b.type]);
  const eaten = ordered.filter((m) => hour >= SLOT_HOUR[m.type]);
  const ahead = ordered.filter((m) => hour < SLOT_HOUR[m.type]);

  /**
   * What goes on the plate.
   *
   * The next meal, which is the brief — except that with five of 501 recipes photographed, "the
   * next meal" is usually a dish with no picture, on a screen whose entire composition is a
   * photograph. So: the first UPCOMING meal that has one, else the next meal, and after the day's
   * photographed meal has been eaten, that one.
   *
   * Each case carries its own honest label. The plate never claims to be up next when it is not,
   * and it never borrows another dish's photograph — those are the two ways this could have gone
   * wrong, and both are closed by labelling rather than by choosing differently.
   */
  const shot = (m: DayMeal) => Boolean(m.cutout ?? m.image);
  const featured = ahead.find(shot) ?? ahead[0] ?? eaten.find(shot) ?? ordered[ordered.length - 1];
  const when =
    featured === ahead[0]
      ? "Up next"
      : ahead.includes(featured)
        ? "Later today"
        : "Earlier today";

  const hit = {
    calories: eaten.reduce((s, m) => s + m.calories, 0),
    protein: eaten.reduce((s, m) => s + m.protein, 0),
    fibre: eaten.reduce((s, m) => s + m.fibre, 0),
  };
  const plate = featured.cutout ?? featured.image;

  return (
    /* Exactly one screen at `lg`. The whole composition is meant to be taken in at a glance, and a
       plate that continues below the fold is a plate you scroll to see rather than one you see. */
    <div className="relative flex min-h-[calc(100vh-64px)] flex-col px-6 pb-6 pt-8 sm:px-10 lg:h-screen lg:min-h-0 lg:overflow-hidden xl:px-14">
      {/* the board's top-right cluster. Its top-LEFT links are the sidebar's job here. */}
      <div className="flex items-center justify-end gap-2.5">
        <span className="text-[10.5px] tabular-nums text-mut">
          {day} · {clock(Math.floor(hour) + (hour % 1 >= 0.5 ? 0.5 : 0))}
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-mut" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-tint">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3d5233" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
            <path d="M12 21c0-7 4-11 9-11-1 7-4 11-9 11zM12 21c0-5-3-8-7-8 1 5 3 8 7 8z" />
          </svg>
        </span>
        <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-vio text-[10px] font-bold text-white">
          A
        </span>
        <span className="h-[26px] w-[26px] rounded-full bg-panel" />
      </div>

      {/* NOT `relative`, deliberately: the plate inside is absolutely positioned and has to anchor
          to the PAGE — the outer element, which is the one with `overflow-hidden` and a full-height
          minimum — so that it is cut by the bottom of the frame the way the board's is. Anchored to
          this grid instead, it was only clipped when the right-hand column happened to be short
          enough, which is a coincidence rather than a composition. */}
      <div className="mt-8 grid gap-10 lg:mt-8 lg:min-h-0 lg:flex-1 lg:grid-cols-[1.14fr_0.86fr] lg:gap-14 xl:gap-20">
        {/* ── LEFT: headline, paragraph, and the plate running off the bottom of the frame ── */}
        <div className="flex min-w-0 flex-col">
          <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
            {when} · {SLOT_LABEL[featured.type]} · {clock(SLOT_HOUR[featured.type])}
          </span>
          <h1 className="font-serif-display mt-3 max-w-[14ch] text-balance text-[clamp(30px,3.3vw,48px)] font-semibold leading-[1.02] tracking-[-0.03em]">
            {featured.name}
          </h1>
          <p className="mt-4 max-w-[44ch] text-[12.5px] leading-[1.75] text-plum-mid">
            {featured.description} {featured.calories} kcal, {featured.protein} g protein,{" "}
            {featured.minutes} minutes to cook.
          </p>

          {/* SLOT: the plate. Round, oversized, laid on the page with no card and no caption.
              `min(48%, 62vh)` OF THE PAGE, since it is positioned against it:

              48%  is measured off the board. On `sage-04` the bowl is 46% of the cream card's
                   width, and the first build had it at 38% because the height cap below was
                   binding — which is what "the image should be bigger" was pointing at.
              62vh keeps the whole bowl on screen on a short window. Sized off the column alone it
                   was as tall as the column was wide, and the bottom fell below the fold.

              It goes through a custom property because Tailwind does not emit an arbitrary value
              containing a comma: `lg:w-[min(48%,62vh)]` was silently dropped, the mobile 88% stayed
              in force, and the plate ran off the screen. A class that does not exist fails
              silently — check the COMPUTED width, not the markup. */}
          <div
            className="relative mt-9 aspect-square w-[104%] max-w-none self-start sm:w-[88%] lg:absolute lg:bottom-1 lg:left-10 lg:mt-0 lg:w-[var(--plate)] lg:max-w-none xl:left-14"
            style={{ "--plate": "min(48%, 62vh)" } as React.CSSProperties}
          >
            {plate ? (
              <Image
                src={plate}
                alt={featured.name}
                width={1000}
                height={1000}
                priority
                sizes="(max-width: 1024px) 100vw, 42vw"
                className={
                  "h-full w-full object-contain " +
                  (featured.cutout
                    ? "drop-shadow-[0_34px_58px_rgba(28,36,25,0.26)]"
                    : "rounded-full shadow-[0_34px_58px_rgba(28,36,25,0.26)]")
                }
              />
            ) : (
              /* No photograph of THIS dish, and it never borrows another's. The plate keeps its
                 shape; a fixed sage, not `gradientForMeal`, which hashes a name onto fourteen hues
                 and would make the plate a different colour for every dish. */
              <div className="grid h-full w-full place-items-center rounded-full bg-tint text-center shadow-[0_34px_58px_rgba(28,36,25,0.14)]">
                <span className="px-[18%]">
                  <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                    Not photographed yet
                  </span>
                  <span className="font-serif-display mt-3 block text-balance text-[clamp(20px,2.1vw,30px)] font-semibold leading-[1.1] tracking-[-0.02em]">
                    {featured.name}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: caption, rings, spec rows, outlined rows ── */}
        <div className="min-w-0 pb-16">
          <p className="text-[11.5px]">
            <b className="font-semibold">Already hit today</b>{" "}
            <span className="text-mut">
              {eaten.length
                ? `from ${eaten.length} ${eaten.length === 1 ? "meal" : "meals"} behind you`
                : "nothing yet — the day is still ahead"}
            </span>
          </p>

          <div className="mt-6 grid grid-cols-3 gap-3">
            <Ring label="Calories" value={hit.calories} target={targets.calories} unit="kcal" />
            <Ring label="Protein" value={hit.protein} target={targets.protein} unit="g" />
            <Ring label="Fibre" value={hit.fibre} target={targets.fibre} unit="g" />
          </div>

          {/* the board's two hairline spec rows, the second with a leader rule */}
          <div className="mt-8">
            <p className="text-[11.5px]">
              <b className="font-semibold">Target</b>{" "}
              <span className="text-mut">
                {targets.calories.toLocaleString()} kcal · {targets.protein} g protein ·{" "}
                {targets.fibre} g fibre
              </span>
            </p>
            <p className="mt-2.5 flex items-baseline gap-3 text-[11.5px] text-mut">
              <span className="shrink-0">Counted from meals whose time has passed</span>
              <span className="h-px flex-1 bg-line" />
              <span className="shrink-0 tabular-nums text-plum">
                {eaten.length} of {ordered.length}
              </span>
            </p>
          </div>

          {/* the outlined rows: the meals still to come */}
          <div className="mt-6 flex flex-col gap-2.5">
            {ahead.map((m) => (
              <div key={m.name} className="rounded-[16px] border border-line px-5 py-4">
                <div className="flex items-baseline gap-3">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-vio" />
                  <b className="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug tracking-[-0.01em]">
                    {m.name}
                  </b>
                  <span className="shrink-0 text-[12.5px] font-bold tabular-nums">
                    {m.calories}
                    <span className="ml-1 text-[9.5px] font-medium text-mut">kcal</span>
                  </span>
                </div>
                <p className="mt-2 pl-[18px] text-[10.5px] tabular-nums text-mut">
                  {SLOT_LABEL[m.type]} · {clock(SLOT_HOUR[m.type])} · {m.minutes} min ·{" "}
                  {m.protein} g protein · {m.fibre} g fibre
                </p>
              </div>
            ))}
            {ahead.length === 0 && (
              <div className="rounded-[16px] border border-line px-5 py-4 text-[12.5px] leading-relaxed text-plum-mid">
                Every meal on {day} is behind you.
              </div>
            )}
          </div>

          {pinned && (
            <p className="mt-5 text-[10.5px] text-mut">
              Previewing at {clock(hour)}. Drop <code>?at=</code> for the real hour.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One thick ring. Plain SVG: a stroked circle with a dash offset. A chart library for this would be
 * more code than the code.
 *
 * The ring caps at 100% so an over-target day cannot draw a second lap, but the NUMBER never caps —
 * the figure is what it is, and hiding an overshoot is the quiet dishonesty the engine exists to
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
      <div className="relative aspect-square w-full max-w-[110px]">
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
              (value >= 1000 ? "text-[19px]" : "text-[25px]")
            }
          >
            {value.toLocaleString()}
          </b>
        </span>
      </div>
      <span className="mt-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-mut">
        {label}
      </span>
      <span className="text-[10px] tabular-nums text-mut">
        {unit} of {target.toLocaleString()}
      </span>
    </div>
  );
}
