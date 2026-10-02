"use client";

import { useState } from "react";
import { Sheet } from "./Sheet";
import { actions, ActionError, type ActionResult } from "./actions";
import type { DayPlan, Meal, UserProfile } from "@/lib/types";

/**
 * Tap a meal, change it. Everything you can do to one plate, in one panel.
 *
 * The design decision behind this file (docs/v1/05-direct-manipulation.md, E4): ONE surface rather
 * than a scatter of controls on every card. You select a thing and see what can be done to it —
 * which is the interaction Notion is built on, and why it feels operable rather than cluttered.
 *
 * Every button here maps to a tested engine operation through `actions.ts`, with no model in the
 * loop: a tap already states its intent. Three honesty rules are load-bearing and visible in the
 * code below:
 *
 *  - The engine's note is ALWAYS shown after an action, because that is where it says what it
 *    actually did — including when it clamped a portion, relaxed a limit, or refused outright.
 *  - Nothing here computes a macro. The figures come from the plan the engine returned.
 *  - A read-only action (why is this here? / what can I substitute?) must never look like a change,
 *    so its answer lands in the same note area and `planChanged` stays false.
 */

const SLOT_LABEL: Record<Meal["type"], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  snack: "Snack",
  dinner: "Dinner",
};

export function MealSheet({
  day,
  meal,
  profile,
  personalized,
  onClose,
  onApplied,
}: {
  day: DayPlan["day"];
  meal: Meal;
  /** Null on the shared sample week — there is no saved profile to read pins or ratings from. */
  profile: UserProfile | null;
  /**
   * False while this is the shared sample week. Every action writes to THIS DEVICE's saved plan, so
   * on the sample there is nothing to write to — the controls are disabled with a reason rather than
   * left live to fail on each press. An error you could have predicted is a design mistake, not an
   * error message.
   */
  personalized: boolean;
  onClose: () => void;
  /** Hands the committed result up so the screen re-reads the engine's numbers, not ours. */
  onApplied: (result: ActionResult) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecipe, setShowRecipe] = useState(false);

  const locked = (profile?.lockedMeals ?? []).some(
    (l) => l.day === day && l.mealType === meal.type,
  );
  const rating = (profile?.mealRatings ?? []).find(
    (r) => r.name.toLowerCase() === meal.name.toLowerCase(),
  )?.rating;

  /** One wrapper for every action: busy state, the engine's note, and honest error text. */
  async function run(key: string, fn: () => Promise<ActionResult>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const result = await fn();
      // The engine's own words. If it had nothing to say, say that rather than implying success.
      setNote(result.notes.join(" ") || "Nothing changed.");
      onApplied(result);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || !personalized;

  return (
    <Sheet title={meal.name} labelledBy="meal-sheet-title" onClose={onClose}>
      {/* ---- what this plate is, from the engine ---- */}
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-mut">
        {day} · {SLOT_LABEL[meal.type]}
      </p>
      <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-[10px] border border-line bg-line">
        {[
          [meal.calories.toLocaleString(), "kcal"],
          [`${meal.proteinGrams} g`, "protein"],
          [`${meal.carbsGrams} g`, "carbs"],
          [`${meal.fatGrams} g`, "fat"],
        ].map(([v, l]) => (
          <div key={l} className="bg-cream px-2 py-2.5 text-center">
            <b className="block text-[14px] font-bold tabular-nums leading-none">{v}</b>
            <span className="mt-1 block text-[9.5px] uppercase tracking-[0.1em] text-mut">{l}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-mut">
        {meal.timeMinutes} min{meal.servings && meal.servings > 1 ? ` · makes ${meal.servings} servings` : ""}
      </p>

      {!personalized && (
        <p className="mt-4 rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">
          This is the shared sample week, so there is nothing of yours to change yet.{" "}
          <a href="/onboarding" className="font-semibold text-vio hover:text-vio-deep">
            Set up your plan
          </a>{" "}
          and every control here works on it.
        </p>
      )}

      {/* ---- the engine's answer to whatever was just pressed ---- */}
      {note && (
        <p className="mt-4 rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">{note}</p>
      )}
      {error && (
        <p className="mt-4 rounded-[10px] bg-red-50 px-4 py-3 text-[12.5px] leading-relaxed text-red-700">
          {error}
        </p>
      )}

      {/* ---- portion ---- */}
      <section className="mt-5">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Portion</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {([
            ["much_smaller", "Much smaller"],
            ["smaller", "Smaller"],
            ["bigger", "Bigger"],
            ["much_bigger", "Much bigger"],
          ] as const).map(([change, label]) => (
            <button
              key={change}
              type="button"
              disabled={disabled}
              onClick={() => run(change, () => actions.resize(day, meal.type, change))}
              className="rounded-full border border-line bg-cream px-3.5 py-2 text-[12px] font-semibold transition hover:border-vio disabled:opacity-50"
            >
              {busy === change ? "…" : label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10.5px] text-mut">
          The engine keeps portions realistic (0.6–1.8×) and says so when it clamps one.
        </p>
      </section>

      {/* ---- keep / taste ---- */}
      <section className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Keep it</h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              run("lock", () =>
                locked ? actions.unlock(day, meal.type) : actions.lock(day, meal.type),
              )
            }
            className={`mt-2 w-full rounded-full px-4 py-2.5 text-[12px] font-semibold transition disabled:opacity-50 ${
              locked ? "bg-vio text-white hover:bg-vio-deep" : "border border-line bg-cream hover:border-vio"
            }`}
          >
            {busy === "lock" ? "…" : locked ? "Pinned — every rebuild keeps it" : "Pin this meal"}
          </button>
        </div>
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">
            Taste {rating ? `· you said ${rating}/5` : ""}
          </h3>
          <div className="mt-2 flex gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                disabled={disabled}
                aria-label={`Rate ${n} out of 5`}
                onClick={() => run(`rate${n}`, () => actions.rate(day, meal.type, n))}
                className={`h-9 flex-1 rounded-[8px] border text-[12px] font-bold tabular-nums transition disabled:opacity-50 ${
                  rating && n <= rating
                    ? "border-vio bg-vio text-white"
                    : "border-line bg-cream hover:border-vio"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] text-mut">1 means never serve it again. It steers future weeks.</p>
        </div>
      </section>

      {/* ---- questions that change nothing ---- */}
      <section className="mt-5">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Ask about it</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => run("why", () => actions.explain(day, meal.type))}
            className="rounded-full border border-line bg-cream px-3.5 py-2 text-[12px] font-semibold transition hover:border-vio disabled:opacity-50"
          >
            {busy === "why" ? "…" : "Why is this here?"}
          </button>
          <button
            type="button"
            onClick={() => setShowRecipe((v) => !v)}
            className="rounded-full border border-line bg-cream px-3.5 py-2 text-[12px] font-semibold transition hover:border-vio"
          >
            {showRecipe ? "Hide the recipe" : "Show the recipe"}
          </button>
        </div>
      </section>

      {/* ---- out of an ingredient ---- */}
      {meal.ingredients.length > 0 && (
        <section className="mt-5">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">
            Out of something?
          </h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {meal.ingredients.slice(0, 8).map((ing) => (
              <button
                key={ing.name}
                type="button"
                disabled={disabled}
                onClick={() => run(`sub-${ing.name}`, () => actions.substitute(ing.name, day, meal.type))}
                className="rounded-full border border-line bg-cream px-3 py-1.5 text-[11.5px] transition hover:border-vio disabled:opacity-50"
              >
                {busy === `sub-${ing.name}` ? "…" : `No ${ing.name.toLowerCase()}`}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] text-mut">
            Suggests safe swaps and the macro cost. Changes nothing until you choose.
          </p>
        </section>
      )}

      {/* ---- the recipe itself ---- */}
      {showRecipe && (
        <section className="mt-5 rounded-[10px] border border-line bg-cream p-4">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Ingredients</h3>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {meal.ingredients.map((ing) => (
              <li key={ing.name} className="flex justify-between gap-4 border-b border-line/60 pb-1 last:border-0">
                <span>{ing.name}</span>
                <span className="shrink-0 tabular-nums text-mut">{ing.quantity}</span>
              </li>
            ))}
          </ul>
          {meal.steps.length > 0 && (
            <>
              <h3 className="mt-4 text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Method</h3>
              <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12.5px] leading-relaxed">
                {meal.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </Sheet>
  );
}
