import { demoWeek, DEMO, SLOTS } from "../demo";

/** The week as a seven-column board — all 21 meals visible at once, the view desktop earns. */
export default function SagePlanPage() {
  const { days, avgKcal, avgProtein, avgFibre, lowest } = demoWeek();
  const unique = new Set(days.flatMap((d) => d.meals.map((m) => m.name))).size;
  const total = days.length * DEMO.mealsPerDay;

  const stats = [
    ["Avg calories", avgKcal.toLocaleString(), `/ ${DEMO.targetCalories.toLocaleString()}`, avgKcal / DEMO.targetCalories, "On target every day"],
    ["Avg protein", avgProtein, `/ ${DEMO.proteinGrams} g`, avgProtein / DEMO.proteinGrams, `${lowest.day} is lowest at ${lowest.protein} g`],
    ["Avg fibre", avgFibre, "/ 30 g", avgFibre / 30, "Computed from the ingredients"],
    ["Variety", unique, `/ ${total} unique`, unique / total, unique === total ? "No dish repeats this week" : `${total - unique} repeat`],
  ] as const;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
            {days.length} days · {total} meals
          </span>
          <h1 className="mt-2 text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-[-0.04em]">
            Your week, balanced.
          </h1>
        </div>
        <div className="flex gap-2.5">
          <button className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
            Regenerate
          </button>
          <button className="rounded-full bg-vio px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-vio-deep">
            Ask the assistant
          </button>
        </div>
      </div>

      <div className="mb-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value, of, pct, foot]) => (
          <div key={label} className="card-shadow rounded-3xl bg-white p-5">
            <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-mut">{label}</span>
            <p className="mt-2 flex items-baseline gap-1.5 text-[31px] font-bold leading-none tracking-[-0.045em] tabular-nums">
              {value}
              <em className="text-[13px] font-medium not-italic tracking-normal text-mut">{of}</em>
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className={`h-full rounded-full ${pct < 0.85 ? "bg-mint" : "bg-vio"}`}
                style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }}
              />
            </div>
            <p className="mt-2.5 text-[11.5px] text-mut">{foot}</p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-3xl">
        <div className="grid min-w-[1120px] gap-px rounded-3xl bg-line" style={{ gridTemplateColumns: "92px repeat(7, minmax(140px, 1fr))" }}>
          <div className="bg-lav p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Slot</span>
          </div>
          {days.map((d) => (
            <div key={d.day} className="bg-lav p-3.5">
              <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-mut">{d.short}</span>
              <span className="text-[17px] font-bold tracking-[-0.035em]">{d.day.slice(0, 3)}</span>
            </div>
          ))}

          {Array.from({ length: DEMO.mealsPerDay }).map((_, row) => (
            <Row key={row} row={row} days={days} />
          ))}

          <div className="flex items-center bg-lav p-3.5 text-[9.5px] font-bold uppercase tracking-[0.15em] text-mut">
            Total
          </div>
          {days.map((d) => (
            <div key={d.day} className="flex flex-col justify-between gap-2 bg-lav p-3.5">
              <div>
                <p className="text-[17px] font-bold tracking-[-0.035em] tabular-nums">{d.kcal.toLocaleString()}</p>
                <p className="text-[11px] text-mut tabular-nums">{d.protein} g protein</p>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-line">
                <div
                  className={`h-full rounded-full ${d.protein < DEMO.proteinGrams * 0.8 ? "bg-mint" : "bg-vio"}`}
                  style={{ width: `${Math.min(100, Math.round((d.protein / DEMO.proteinGrams) * 100))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-5 flex items-start gap-2.5 text-[13px] text-mut">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" className="mt-0.5 shrink-0">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.01" />
        </svg>
        <span>
          <b className="text-plum">
            {lowest.day} is {DEMO.proteinGrams - lowest.protein} g short on protein.
          </b>{" "}
          The assistant can lift it without moving your calories.
        </span>
      </p>
    </>
  );
}

function Row({ row, days }: { row: number; days: ReturnType<typeof demoWeek>["days"] }) {
  return (
    <>
      <div className="flex items-center bg-lav p-3.5 text-[9.5px] font-bold uppercase tracking-[0.15em] text-mut">
        {SLOTS[row]}
      </div>
      {days.map((d) => {
        const m = d.meals[row];
        return (
          <div key={d.day} className="flex min-h-[86px] flex-col justify-between gap-2 bg-white p-3.5">
            <p className="text-[12.8px] font-medium leading-snug tracking-[-0.015em]">{m?.name ?? "—"}</p>
            {m && (
              <p className="flex gap-2.5 text-[11px] text-mut tabular-nums">
                <span>
                  <b className="font-bold text-plum">{m.calories}</b> kcal
                </span>
                <span>
                  <b className="font-bold text-plum">{m.proteinGrams}</b> g
                </span>
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
