"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { gradientForMeal, imageForMeal } from "@/lib/recipes";
import { RefreshIcon } from "@/components/icons";
import { SLOTS } from "../demo";
import { loadMyWeek, generateMyWeek, PLAN_CHANGED_EVENT } from "../myPlan";
import type { WeekStats } from "../weekStats";
import { MealSheet } from "../MealSheet";
import { ReconcileSheet } from "../ReconcileSheet";
import { fixMyWeek, movePair, undoLast, canUndo, lastChangeLabel, ActionError } from "../actions";
import { CommandPalette } from "../CommandPalette";
import type { DayPlan, Meal, Operation, UserProfile, WeekPlan } from "@/lib/types";

interface Targets {
  targetCalories: number;
  proteinGrams: number;
  mealsPerDay: number;
}
interface BatchInfo {
  sessions: number;
  batches: number;
  cadence: string;
  notes: string[];
}
interface View {
  stats: WeekStats;
  targets: Targets;
  personalized: boolean;
  profile: UserProfile | null;
  batch: BatchInfo | null;
}

function batchInfo(week: WeekPlan, profile: UserProfile): BatchInfo | null {
  if (week.planMode !== "batch") return null;
  return {
    sessions: week.sessions?.length ?? 0,
    batches: week.batches?.length ?? 0,
    cadence: profile.batchCadence === "weekly" ? "weekly" : "every 3 days",
    notes: week.notes ?? [],
  };
}

/**
 * The Week board. Renders the shared engine-built DEMO week on the server for a first visit, then —
 * on the client — swaps in THIS person's saved week if they have one (myPlan.loadMyWeek). Regenerate
 * rebuilds their week through the real engine (/api/plan); it is only offered once a plan is theirs,
 * because regenerating a sample is meaningless. Every figure still comes from summariseWeek, the one
 * copy of that arithmetic the whole app shares.
 */
export default function WeekBoard({ demo }: { demo: { stats: WeekStats; targets: Targets } }) {
  const [view, setView] = useState<View>({ ...demo, personalized: false, profile: null, batch: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Which plate the sheet is open on. A single piece of state, because only one can be open.
  const [open, setOpen] = useState<{ day: DayPlan["day"]; meal: Meal } | null>(null);
  // A pending day-level change, held until the preview has been read and accepted.
  const [pending, setPending] = useState<{ title: string; op: Operation | Operation[]; day?: DayPlan["day"] } | null>(null);
  /** The plate being dragged, or the one picked up by keyboard. One at a time. */
  const [held, setHeld] = useState<{ day: DayPlan["day"]; mealType: Meal["type"]; dish: string } | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  /** The undo offer. Direct manipulation without undo is a dare, not a feature. */
  const [undoable, setUndoable] = useState<string | null>(null);

  useEffect(() => {
    // Load this device's week on mount, and re-read in place whenever the mode/cadence toggle fires
    // PLAN_CHANGED_EVENT — no page reload.
    const refresh = () => {
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
          batch: batchInfo(mine.week, mine.profile),
        });
      }
    };
    refresh();
    window.addEventListener(PLAN_CHANGED_EVENT, refresh);

    // After any change, offer to reverse it — reading the engine's own undo state rather than
    // assuming a change happened.
    const offerUndo = () => setUndoable(canUndo() ? lastChangeLabel() : null);
    window.addEventListener(PLAN_CHANGED_EVENT, offerUndo);

    function onKey(e: KeyboardEvent) {
      // Never hijack a key the user is typing into a field, or a browser shortcut.
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === "u") {
        // Only when there is something to undo; a key that silently does nothing teaches nothing.
        if (canUndo()) void undoLast().then(() => setUndoable(null));
      }
    }
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener(PLAN_CHANGED_EVENT, refresh);
      window.removeEventListener(PLAN_CHANGED_EVENT, offerUndo);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /** Put the held plate into this slot. Two swaps, one undo, previewed before anything commits. */
  function dropOnto(target: { day: DayPlan["day"]; mealType: Meal["type"]; dish: string }) {
    if (!held) return;
    const same = held.day === target.day && held.mealType === target.mealType;
    setHeld(null);
    if (same) return;
    setPending({
      title: `Move ${held.dish} to ${target.day} ${target.mealType}`,
      op: movePair(held, target),
      // Both days are affected, so no single day is the obvious one to offer a rebalance for; the
      // preview shows each day's new totals and the day controls can balance either.
      day: undefined,
    });
  }

  /** One press, every off-target day rebalanced. Reports what it actually did. */
  async function fixWeek() {
    setFixing(true);
    setFixNote(null);
    setErr(null);
    try {
      const r = await fixMyWeek(targets.proteinGrams);
      if (r.alreadyFine === 7) setFixNote("Every day is already on target — nothing to fix.");
      else if (r.fixed.length === 0) setFixNote("Those days are as close as the engine can get them.");
      else
        setFixNote(
          `Rebalanced ${r.fixed.join(", ")}.` +
            (r.fixed.length > 1 ? " Undo reverses the last day only — the engine keeps one step." : ""),
        );
    } catch (e) {
      setErr(e instanceof ActionError ? e.message : "Couldn't rebalance just now.");
    } finally {
      setFixing(false);
    }
  }

  async function regenerate() {
    if (!view.profile) return;
    setBusy(true);
    setErr(null);
    try {
      const mine = await generateMyWeek(view.profile);
      setView((v) => ({ ...v, stats: mine.stats, batch: batchInfo(mine.week, mine.profile) }));
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
          {view.batch ? `${view.batch.batches} dishes over ${view.batch.sessions} cook session${view.batch.sessions > 1 ? "s" : ""}` : `${uniqueDishes} distinct dishes`}
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
          {personalized && (
            <button
              type="button"
              onClick={() => setPalette(true)}
              title="Type a change (Ctrl K)"
              className="rounded-full border border-line bg-cream px-4 py-2.5 text-[12.5px] font-semibold transition hover:border-vio"
            >
              Type a change
              <kbd className="ml-2 rounded border border-line bg-bgsoft px-1.5 py-0.5 text-[9.5px] font-sans text-mut">
                Ctrl K
              </kbd>
            </button>
          )}
          {personalized && (
            <button
              type="button"
              onClick={fixWeek}
              disabled={fixing}
              title="Rebalance every day that is short of your targets"
              className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line disabled:opacity-60"
            >
              {fixing ? "Fixing…" : "Fix my week"}
            </button>
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
      {held && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-vio px-4 py-3 text-[12.5px] text-white">
          <span>
            Holding <b className="font-semibold">{held.dish}</b> — pick the slot to swap it with.
          </span>
          <button
            type="button"
            onClick={() => setHeld(null)}
            className="rounded-full bg-white/15 px-3 py-1 text-[11.5px] font-semibold transition hover:bg-white/25"
          >
            Put it back
          </button>
        </p>
      )}
      {fixNote && (
        <p className="mt-3 rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">{fixNote}</p>
      )}

      {view.batch && (
        <div className="mt-4 rounded-[10px] bg-panel p-4 text-white">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="rounded-full bg-white/12 px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.16em]">Meal-prep</span>
            <span className="text-[12.5px] leading-snug text-white/85">
              Cook <b className="font-semibold text-white">{view.batch.batches} dishes</b> over{" "}
              <b className="font-semibold text-white">{view.batch.sessions} session{view.batch.sessions > 1 ? "s" : ""}</b> ({view.batch.cadence}), then rotate the servings across the week.
            </span>
          </div>
          {view.batch.notes.length > 0 && (
            <ul className="mt-2.5 space-y-1 border-t border-white/15 pt-2.5 text-[11px] leading-relaxed text-white/65">
              {view.batch.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
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
                {personalized && (
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setPending({
                          title: `Rebalance ${d.day}`,
                          op: { tool: "rebalance_day", day: d.day as DayPlan["day"] },
                          day: d.day as DayPlan["day"],
                        })
                      }
                      title="Rescale this day's portions to hit your targets"
                      className="rounded-full border border-line bg-cream px-2.5 py-1 text-[10px] font-semibold transition hover:border-vio"
                    >
                      Balance
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPending({
                          title: `Regenerate ${d.day}`,
                          op: { tool: "regenerate_day", day: d.day as DayPlan["day"] },
                          day: d.day as DayPlan["day"],
                        })
                      }
                      title="Pick new dishes for this day"
                      className="rounded-full border border-line bg-cream px-2.5 py-1 text-[10px] font-semibold transition hover:border-vio"
                    >
                      New day
                    </button>
                  </div>
                )}
              </div>

              {d.meals.map((m, i) => {
                const pinned = (view.profile?.lockedMeals ?? []).some(
                  (l) => l.day === d.day && l.mealType === m.type,
                );
                return (
                  <button
                    key={i}
                    type="button"
                    draggable={personalized}
                    onDragStart={() =>
                      setHeld({ day: d.day as DayPlan["day"], mealType: m.type, dish: m.name })
                    }
                    onDragEnd={() => setHeld(null)}
                    onDragOver={(e) => {
                      // Without preventDefault the browser refuses the drop entirely.
                      if (held) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropOnto({ day: d.day as DayPlan["day"], mealType: m.type, dish: m.name });
                    }}
                    onClick={() => {
                      // Keyboard and touch path: first press picks a plate up, second puts it down.
                      // Everything drag does is reachable without a mouse.
                      if (held) dropOnto({ day: d.day as DayPlan["day"], mealType: m.type, dish: m.name });
                      else setOpen({ day: d.day as DayPlan["day"], meal: m });
                    }}
                    onKeyDown={(e) => {
                      if (e.key.toLowerCase() !== "m") return;
                      e.preventDefault();
                      setHeld(
                        held && held.day === d.day && held.mealType === m.type
                          ? null
                          : { day: d.day as DayPlan["day"], mealType: m.type, dish: m.name },
                      );
                    }}
                    aria-label={
                      held
                        ? `Put ${held.dish} here, in ${d.day} ${SLOTS[i]}`
                        : `${d.day} ${SLOTS[i]}: ${m.name} — change it, or press M to move it`
                    }
                    className={`group rounded-[10px] p-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vio ${
                      held && held.day === d.day && held.mealType === m.type
                        ? "bg-vio text-white"
                        : held
                          ? "bg-tint ring-2 ring-dashed ring-vio/40 hover:bg-line"
                          : "bg-tint hover:bg-line"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[8.5px] font-bold uppercase tracking-[0.16em] text-mut">
                        {SLOTS[i]}
                      </span>
                      {pinned && (
                        <span className="text-[8.5px] font-bold uppercase tracking-[0.14em] text-vio" title="Pinned — every rebuild keeps it">
                          Pinned
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 block text-[13px] font-semibold leading-[1.25] tracking-[-0.01em]">
                      {m.name}
                    </span>
                    <span className="mt-2.5 block border-t border-plum/12 pt-2 text-[10.5px] tabular-nums text-mut">
                      <b className="font-bold text-plum">{m.calories}</b> kcal ·{" "}
                      <b className="font-bold text-plum">{m.proteinGrams}</b> g · {m.timeMinutes} min
                    </span>
                  </button>
                );
              })}

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

      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onPick={(cmd) => {
            setPalette(false);
            // A reading that moves the plan gets previewed; one that doesn't (pin, undo) just runs.
            if (cmd.preview) setPending({ title: cmd.label, op: cmd.operation, day: cmd.day });
            else void import("../actions").then((m) => m.runOperation(cmd.operation, cmd.label));
          }}
        />
      )}

      {undoable && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-panel px-4 py-2.5 text-white shadow-2xl">
          <span className="text-[12.5px]">{undoable}</span>
          <button
            type="button"
            onClick={() => void undoLast().then(() => setUndoable(null))}
            className="rounded-full bg-white/15 px-3 py-1 text-[11.5px] font-semibold transition hover:bg-white/25"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setUndoable(null)}
            aria-label="Dismiss"
            className="text-white/60 transition hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {pending && (
        <ReconcileSheet
          title={pending.title}
          operation={pending.op}
          day={pending.day}
          onClose={() => setPending(null)}
          /* actions.ts persisted and fired PLAN_CHANGED_EVENT, so `refresh` has already re-read the
             week. Nothing further to do here. */
          onApplied={() => setPending(null)}
        />
      )}

      {open && (
        <MealSheet
          day={open.day}
          meal={open.meal}
          profile={view.profile}
          personalized={personalized}
          /* One modal at a time: the meal sheet closes and the preview opens in its place. */
          onReconcile={(title, op) => {
            setOpen(null);
            setPending({ title, op, day: open.day });
          }}
          onClose={() => setOpen(null)}
          /* actions.ts already saved and fired PLAN_CHANGED_EVENT, so `refresh` has re-read the
             week from storage. Keep the sheet open on the meal's new state rather than closing it:
             a user resizing a portion usually wants to resize it again. */
          onApplied={(r) => {
            const d = r.week.days.find((x) => x.day === open.day);
            const next = d?.meals.find((m) => m.type === open.meal.type);
            if (next) setOpen({ day: open.day, meal: next });
          }}
        />
      )}
    </div>
  );
}
