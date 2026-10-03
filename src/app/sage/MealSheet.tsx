"use client";

import { useState } from "react";
import { Sheet } from "./Sheet";
import { actions, ActionError, slotCandidates, type ActionResult, type CandidateList } from "./actions";
import type { DayPlan, Meal, Operation, UserProfile } from "@/lib/core";

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

/** A signed, coloured delta — "+8 g protein" is a consequence; "28 g protein" is just a number. */
function Delta({ value, unit }: { value: number; unit: string }) {
  if (value === 0) return <span className="text-mut">same {unit}</span>;
  const up = value > 0;
  return (
    <span className={up ? "font-semibold text-mint" : "font-semibold text-plum-mid"}>
      {up ? "+" : "−"}
      {Math.abs(value)} {unit}
    </span>
  );
}

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
  onReconcile,
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
  /**
   * Hand a change up to the reconcile panel instead of previewing it in here. Two dialogs stacked on
   * each other is a focus trap fighting another focus trap, so the sheet closes and the parent opens
   * the preview — one modal at a time, always.
   */
  onReconcile: (title: string, operation: Operation) => void;
  onClose: () => void;
  /** Hands the committed result up so the screen re-reads the engine's numbers, not ours. */
  onApplied: (result: ActionResult) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecipe, setShowRecipe] = useState(false);
  const [swaps, setSwaps] = useState<CandidateList | null>(null);
  // The protein floor the user typed, as a string so the field can be empty while being edited.
  const [proteinWant, setProteinWant] = useState("");
  // The deviation form: what you actually ate, and what it cost if you know.
  const [ateOpen, setAteOpen] = useState(false);
  const [ateWhat, setAteWhat] = useState("");
  const [ateKcal, setAteKcal] = useState("");

  /** Fetched on demand rather than on open: most sheet visits are a pin or a rating, and a slot's
   *  alternatives are a search over 501 recipes that nobody asked for yet. */
  async function loadSwaps(minProtein?: number) {
    setBusy("swaps");
    setError(null);
    try {
      setSwaps(await slotCandidates(day, meal.type, 6, minProtein));
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't find alternatives.");
    } finally {
      setBusy(null);
    }
  }

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
      // The list was computed against the dish that was here a moment ago. Drop it rather than
      // leaving deltas on screen that are measured from something no longer in the slot.
      if (result.planChanged) setSwaps(null);
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

      {/* ---- the macro dial: name a number, get both ways to reach it ---- */}
      <section className="mt-5">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">
          Want more protein here?
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center overflow-hidden rounded-full border border-line bg-cream">
            <button
              type="button"
              aria-label="5 grams less"
              disabled={disabled}
              onClick={() => setProteinWant((v) => String(Math.max(0, (Number(v) || meal.proteinGrams) - 5)))}
              className="px-3 py-2 text-[13px] font-bold text-mut transition hover:text-plum disabled:opacity-50"
            >
              &minus;
            </button>
            <input
              id="protein-want"
              type="number"
              inputMode="numeric"
              min={0}
              max={300}
              value={proteinWant}
              onChange={(e) => setProteinWant(e.target.value)}
              placeholder={String(meal.proteinGrams)}
              aria-label="Protein grams for this meal"
              className="w-[68px] border-x border-line bg-cream py-2 text-center text-[13px] font-bold tabular-nums outline-none"
            />
            <button
              type="button"
              aria-label="5 grams more"
              disabled={disabled}
              onClick={() => setProteinWant((v) => String(Math.min(300, (Number(v) || meal.proteinGrams) + 5)))}
              className="px-3 py-2 text-[13px] font-bold text-mut transition hover:text-plum disabled:opacity-50"
            >
              +
            </button>
          </div>
          <span className="text-[11px] text-mut">g, it has {meal.proteinGrams} now</span>
          <button
            type="button"
            disabled={disabled || !(Number(proteinWant) > 0)}
            onClick={() => loadSwaps(Number(proteinWant))}
            className="rounded-full bg-vio px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-vio-deep disabled:opacity-40"
          >
            {busy === "swaps" ? "Working…" : "Show me how"}
          </button>
        </div>

        {/* Two ways to reach a number, and the engine decides which is even possible. Resizing keeps
            the meal you were going to cook, so it is offered first when it can get there. */}
        {swaps?.resizeReaches && (
          <div className="mt-2.5 rounded-[10px] border border-line bg-cream px-3.5 py-3">
            {swaps.resizeReaches.possible ? (
              <>
                <p className="text-[12.5px] leading-relaxed">
                  <b>Keep this dish and make it bigger.</b> At {swaps.resizeReaches.atFactor}× it
                  reaches <b className="tabular-nums">{swaps.resizeReaches.protein} g</b> protein and{" "}
                  <b className="tabular-nums">{swaps.resizeReaches.calories}</b> kcal.
                </p>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => run("dial-resize", () => actions.resize(day, meal.type, "much_bigger"))}
                  className="mt-2 rounded-full border border-line bg-bgsoft px-3.5 py-2 text-[12px] font-semibold transition hover:border-vio disabled:opacity-50"
                >
                  {busy === "dial-resize" ? "Resizing…" : "Resize it"}
                </button>
              </>
            ) : (
              <p className="text-[12.5px] leading-relaxed">
                <b>Resizing can&apos;t get there.</b> Portions stay within 1.8× to stay realistic, which
                caps this dish at <b className="tabular-nums">{swaps.resizeReaches.protein} g</b>. The
                dishes below do reach it.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ---- swap: choose between consequences, not names ---- */}
      <section className="mt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Swap it</h3>
          {swaps && (
            <span className="text-[10.5px] tabular-nums text-mut">
              this slot aims at {swaps.slotTarget.calories} kcal · {swaps.slotTarget.protein} g
            </span>
          )}
        </div>

        {!swaps ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => loadSwaps()}
            className="mt-2 w-full rounded-full border border-line bg-cream px-4 py-2.5 text-[12px] font-semibold transition hover:border-vio disabled:opacity-50"
          >
            {busy === "swaps" ? "Looking…" : "Show me what else fits"}
          </button>
        ) : swaps.rows.length === 0 ? (
          <p className="mt-2 text-[12px] text-mut">
            {Number(proteinWant) > 0
              ? `Nothing in the library reaches ${Number(proteinWant)} g in this slot under your current rules.`
              : "Nothing else fits this slot under your current rules."}
          </p>
        ) : (
          <>
            {/*
              The engine already chose the best-fitting dish for this slot during generation, so in
              practice almost nothing scores closer to the slot's macro target than what is there —
              measured: 0 of 12 on a typical slot. A "better fit" badge would therefore be absent
              almost always, which reads as "all of these are worse" rather than "you are swapping
              for a reason of your own". So when nothing is a closer fit, say why, and say what the
              engine will do about the difference.
            */}
            {swaps.rows.every((c) => !c.closerToTarget) && (
              <p className="mt-2 text-[11px] leading-relaxed text-mut">
                What&apos;s there is already the closest macro fit for this slot, so these are
                alternatives by preference — not upgrades. Whichever you pick, the day gets
                rebalanced around it.
              </p>
            )}
            <ul className="mt-2 space-y-1.5">
            {swaps.rows.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => run(`swap-${c.name}`, () => actions.swapMeal(day, meal.type, c.name))}
                  className="w-full rounded-[10px] border border-line bg-cream px-3.5 py-2.5 text-left transition hover:border-vio disabled:opacity-50"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] font-semibold leading-tight">
                      {busy === `swap-${c.name}` ? "Swapping…" : c.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {c.closerToTarget && (
                        <span className="rounded-full bg-mint-soft px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em] text-mint">
                          better fit
                        </span>
                      )}
                      <span className="text-[10.5px] tabular-nums text-mut">{c.minutes} min</span>
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] tabular-nums">
                    <Delta value={c.deltaProtein} unit="g protein" />
                    <Delta value={c.deltaKcal} unit="kcal" />
                    {c.keepsDays >= 3 && <span className="text-mut">keeps {c.keepsDays} days</span>}
                    {c.freezesWell && <span className="text-mut">freezes</span>}
                    {c.elsewhereThisWeek && <span className="text-mut">already this week</span>}
                  </span>
                </button>
              </li>
            ))}
            </ul>
          </>
        )}
      </section>

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

      {/* ---- the deviation flow: life happened, and the plan should absorb it ---- */}
      <section className="mt-5">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">
          Ate something else?
        </h3>
        {!ateOpen ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setAteOpen(true)}
              className="rounded-full border border-line bg-cream px-3.5 py-2 text-[12px] font-semibold transition hover:border-vio disabled:opacity-50"
            >
              I ate something else
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onReconcile(`Eating out — ${day} ${SLOT_LABEL[meal.type].toLowerCase()}`, {
                  tool: "eating_out",
                  day,
                  mealType: meal.type,
                })
              }
              className="rounded-full border border-line bg-cream px-3.5 py-2 text-[12px] font-semibold transition hover:border-vio disabled:opacity-50"
            >
              I&apos;m eating out
            </button>
          </div>
        ) : (
          <div className="mt-2 rounded-[10px] border border-line bg-cream p-3.5">
            <label htmlFor="ate-what" className="block text-[11px] font-semibold">
              What did you eat?
            </label>
            <input
              id="ate-what"
              value={ateWhat}
              onChange={(e) => setAteWhat(e.target.value)}
              placeholder="a burger and chips"
              className="mt-1.5 w-full rounded-[8px] border border-line bg-bgsoft px-3 py-2 text-[12.5px] outline-none focus:border-vio"
            />
            <label htmlFor="ate-kcal" className="mt-3 block text-[11px] font-semibold">
              Calories, if you know them
            </label>
            <input
              id="ate-kcal"
              type="number"
              inputMode="numeric"
              min={0}
              value={ateKcal}
              onChange={(e) => setAteKcal(e.target.value)}
              placeholder="optional"
              className="mt-1.5 w-[140px] rounded-[8px] border border-line bg-bgsoft px-3 py-2 text-[12.5px] tabular-nums outline-none focus:border-vio"
            />
            <p className="mt-2 text-[10.5px] leading-relaxed text-mut">
              If it&apos;s one of our recipes the planner knows its macros. Otherwise give it a number —
              and if you can&apos;t, say you&apos;re eating out instead and it reserves a typical meal
              rather than guessing quietly.
            </p>
            <p className="mt-2 text-[11.5px] font-semibold leading-relaxed">
              Then it re-solves the rest of {day} around it.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                disabled={disabled || ateWhat.trim().length < 2}
                onClick={() =>
                  onReconcile(`Logged "${ateWhat.trim()}" for ${day} ${SLOT_LABEL[meal.type].toLowerCase()}`, {
                    tool: "log_meal",
                    day,
                    mealType: meal.type,
                    dish: ateWhat.trim(),
                    ...(Number(ateKcal) > 0 ? { loggedCalories: Number(ateKcal) } : {}),
                  })
                }
                className="rounded-full bg-vio px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-vio-deep disabled:opacity-40"
              >
                See what that does
              </button>
              <button
                type="button"
                onClick={() => setAteOpen(false)}
                className="rounded-full px-3 py-2 text-[12px] font-semibold text-mut transition hover:text-plum"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
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
