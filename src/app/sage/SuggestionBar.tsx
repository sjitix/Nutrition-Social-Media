"use client";

import { useEffect, useRef, useState } from "react";
import { ZapIcon, XIcon } from "@/components/icons";
import { runOperation, ActionError } from "./actions";
import { findSuggestion, fixFor, suggestionText, type Suggestion } from "./suggest";
import type { WeekStats } from "./weekStats";

/**
 * The assistant speaking first (V1 D9): one line, one button, on Week and Today. It appears only when the engine has
 * previewed a fix that closes a short day (suggest.ts), and the button commits exactly the operation that was
 * previewed, as one undoable change. After it, the engine's own notes are shown, as every direct control does.
 *
 * "Not now" hides it until the week changes. It is held in memory, not storage: a suggestion is about this week as it
 * stands, and a dismissal that outlived a change would hide a new shortfall.
 */
export function SuggestionBar({
  stats,
  proteinTarget,
  onlyDays,
  enabled,
}: {
  stats: WeekStats;
  proteinTarget: number;
  /** Today passes its own day; Week passes nothing and gets the worst day. */
  onlyDays?: readonly string[];
  /** Off for the sample week (there is no saved week to change) and in meal-prep mode (a day cannot be re-planned alone). */
  enabled: boolean;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // What the week looks like, as the figures the bar reads: a suggestion found for one week is dropped when it changes.
  const key = JSON.stringify(stats.days.map((d) => [d.day, Math.round(d.protein), d.meals.map((m) => m.name)])) + proteinTarget;
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    setSuggestion(null);
    setErr(null);
    if (!enabled || dismissed === key) return;
    let live = true;
    findSuggestion(stats, proteinTarget, onlyDays)
      .then((s) => { if (live && latest.current === key) setSuggestion(s); })
      // A preview that fails is not worth an error on the page: the bar is an offer, and it simply is not made.
      .catch(() => {});
    return () => { live = false; };
    // `stats` and `onlyDays` are read through `key`, which is what decides whether anything changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, dismissed]);

  async function fix(s: Suggestion) {
    setWorking(true);
    setErr(null);
    try {
      const r = await runOperation(fixFor(s.day), `Re-planned ${s.day}`);
      setDone(r.notes.join(" ") || `Re-planned ${s.day}.`);
      setSuggestion(null);
    } catch (e) {
      setErr(e instanceof ActionError ? e.message : "Couldn't change that day just now.");
    } finally {
      setWorking(false);
    }
  }

  if (done)
    return (
      <p role="status" className="mt-3 flex items-start justify-between gap-3 rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">
        <span>{done}</span>
        <button type="button" onClick={() => setDone(null)} aria-label="Close" className="mt-0.5 shrink-0 text-mut transition hover:text-ink">
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </p>
    );
  if (!suggestion) return null;
  return (
    <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-line bg-cream px-4 py-3 text-[12.5px] leading-relaxed">
      <ZapIcon className="h-4 w-4 shrink-0 text-vio" />
      <span className="min-w-0 flex-1">{suggestionText(suggestion)}</span>
      <span className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => fix(suggestion)}
          disabled={working}
          className="rounded-full bg-vio px-4 py-1.5 text-[12px] font-semibold text-white transition hover:bg-vio-deep disabled:opacity-60"
        >
          {working ? "Changing…" : `Fix ${suggestion.day}`}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(key)}
          className="rounded-full px-3 py-1.5 text-[12px] font-semibold text-mut transition hover:text-ink"
        >
          Not now
        </button>
      </span>
      {err && <span className="basis-full text-red-700">{err}</span>}
    </div>
  );
}
