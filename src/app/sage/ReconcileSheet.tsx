"use client";

import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { ActionError, previewOperation, runOperation, type ActionResult, type PreviewResult } from "./actions";
import type { DayPlan, Operation } from "@/lib/core";

/**
 * "Here is what that would do to your day. Do you still want it?"
 *
 * The confirm-before-commit panel. It simulates the operation through the engine (`preview`, which
 * clones and commits nothing), shows the consequence, and only then offers to apply it — which is
 * the difference between a plan you edit and a plan that changes under you.
 *
 * Three things it is careful to get right:
 *
 *  - **A preview is a prediction, not a promise.** The engine picks at random among near-tied
 *    recipes, so the previewed figures are seeded and the committed ones may differ slightly. The
 *    panel says so, and after applying, the screen re-reads the engine's real numbers.
 *  - **The engine's notes are shown before you commit**, so a refusal or a relaxed limit is
 *    something you read in advance rather than discover afterwards.
 *  - **"Rebalance the day" is a second, separate operation**, not a hidden part of the first. If you
 *    want the day's other meals rescaled to absorb the change, you ask for it, and it is undoable on
 *    its own.
 */
export function ReconcileSheet({
  title,
  operation,
  day,
  onClose,
  onApplied,
}: {
  title: string;
  operation: Operation | Operation[];
  /** The day to offer a rebalance for, when the change is confined to one. */
  day?: DayPlan["day"];
  onClose: () => void;
  onApplied: (result: ActionResult) => void;
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBusy("preview");
    previewOperation(operation)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(e instanceof ActionError ? e.message : "Couldn't work that out."))
      .finally(() => live && setBusy(null));
    // The operation object is rebuilt by the caller on every render, so depend on its contents
    // rather than its identity or this previews in a loop.
    return () => {
      live = false;
    };
  }, [JSON.stringify(operation)]); // eslint-disable-line react-hooks/exhaustive-deps

  async function apply(alsoRebalance: boolean) {
    setBusy(alsoRebalance ? "rebalance" : "apply");
    setError(null);
    try {
      let result = await runOperation(operation, title);
      if (alsoRebalance && day) {
        // A separate operation on purpose: you asked for it, and you can undo it by itself.
        result = await runOperation({ tool: "rebalance_day", day }, `Rebalanced ${day}`);
      }
      onApplied(result);
      onClose();
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "That didn't go through.");
      setBusy(null);
    }
  }

  // Only the days this change actually moves are worth showing; a seven-row table of mostly zeroes
  // buries the two numbers that matter.
  const moved = (preview?.days ?? []).filter((d) => d.deltaKcal !== 0 || d.deltaProtein !== 0);

  return (
    <Sheet
      title={title}
      labelledBy="reconcile-title"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null || !preview}
            onClick={() => apply(false)}
            className="flex-1 rounded-full bg-vio px-4 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep disabled:opacity-40"
          >
            {busy === "apply" ? "Applying…" : "Apply it"}
          </button>
          {day && (
            <button
              type="button"
              disabled={busy !== null || !preview}
              onClick={() => apply(true)}
              className="flex-1 rounded-full border border-line bg-cream px-4 py-2.5 text-[12.5px] font-semibold transition hover:border-vio disabled:opacity-40"
            >
              {busy === "rebalance" ? "Working…" : "Apply + rebalance the day"}
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={onClose}
            className="rounded-full px-4 py-2.5 text-[12.5px] font-semibold text-mut transition hover:text-plum disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      }
    >
      {busy === "preview" && <p className="text-[12.5px] text-mut">Working out what that would do…</p>}

      {error && (
        <p className="rounded-[10px] bg-red-50 px-4 py-3 text-[12.5px] leading-relaxed text-red-700">{error}</p>
      )}

      {preview && (
        <>
          {!preview.wouldChangePlan ? (
            <p className="rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">
              This wouldn&apos;t change anything.
            </p>
          ) : (
            <>
              {moved.length > 0 && (
                <div className="overflow-hidden rounded-[10px] border border-line">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-tint text-[9.5px] uppercase tracking-[0.12em] text-mut">
                        <th className="px-3 py-2 text-left font-bold">Day</th>
                        <th className="px-3 py-2 text-right font-bold">Calories</th>
                        <th className="px-3 py-2 text-right font-bold">Protein</th>
                      </tr>
                    </thead>
                    <tbody>
                      {moved.map((d) => (
                        <tr key={d.day} className="border-t border-line">
                          <td className="px-3 py-2 font-semibold">{d.day}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {d.kcal.toLocaleString()}{" "}
                            <Delta value={d.deltaKcal} />
                            <span className="ml-1 text-mut">of {d.targetKcal.toLocaleString()}</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {d.protein} g <Delta value={d.deltaProtein} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.moves.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-[12px]">
                  {preview.moves.slice(0, 8).map((m, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-mut">
                        {m.day} {m.slot}
                      </span>
                      <span className="text-mut line-through">{m.from}</span>
                      <span aria-hidden="true" className="text-mut">
                        &rarr;
                      </span>
                      <span className="font-semibold">{m.to}</span>
                    </li>
                  ))}
                  {preview.moves.length > 8 && (
                    <li className="text-mut">and {preview.moves.length - 8} more</li>
                  )}
                </ul>
              )}
            </>
          )}

          {preview.notes.length > 0 && (
            <div className="mt-3 rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">
              {preview.notes.map((n, i) => (
                <p key={i} className={i ? "mt-1.5" : ""}>
                  {n}
                </p>
              ))}
            </div>
          )}

          <p className="mt-3 text-[10.5px] leading-relaxed text-mut">
            A preview, not a promise: the planner picks between near-equal dishes, so the final figures
            can land a little differently. What you see after applying is the real week.
          </p>
        </>
      )}
    </Sheet>
  );
}

/** A signed delta, coloured by direction. Zero renders nothing — "+0" is noise. */
function Delta({ value }: { value: number }) {
  if (value === 0) return null;
  const up = value > 0;
  return (
    <span className={`ml-0.5 font-semibold ${up ? "text-mint" : "text-plum-mid"}`}>
      ({up ? "+" : "−"}
      {Math.abs(value)})
    </span>
  );
}
