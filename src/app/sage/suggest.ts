"use client";

import { PROTEIN_MISS, DAYS } from "@/lib/core/client";
import type { WeekStats } from "./weekStats";

type Day = (typeof DAYS)[number];
import { previewOperation } from "./actions";

/**
 * The assistant speaks first (V1 D9, RULE 3): a short day is pointed out, with its fix, before anyone asks.
 *
 * Two halves, and the split is the point:
 *   - `shortDays` is pure arithmetic over figures the page already shows: which days are short of protein by more
 *     than PROTEIN_MISS, the same line the engine's own notes use, worst first. A day whose meals are all logged
 *     or eaten out is left out, because those are facts and there is nothing left in it to move.
 *   - `findSuggestion` then asks the ENGINE, by preview (nothing is committed), what re-planning that day would
 *     do. A suggestion is offered only when the engine says it closes at least PROTEIN_MISS of the gap, so the
 *     button never promises a fix the engine cannot make. A week with no short day costs no request at all.
 *
 * Why a re-plan of the day and not `rebalance_day`: measured 2026-10-28, rebalancing holds the day's CALORIES and
 * moves protein by a gram or two (a Tuesday at 128 g stayed at 127 g, with or without a protein target), while
 * `regenerate_day` brought it to 144 g, keeping pins and logged meals. It picks new dishes, so the suggestion names
 * each one it would change (the preview's `moves`), and a dish the person chose is never replaced unannounced.
 */

export interface Suggestion {
  day: Day;
  /** Protein the day has now, and what re-planning it would give, both from the engine's figures. */
  protein: number;
  after: number;
  target: number;
  /** Every dish the re-plan would change, from the preview. */
  moves: { slot: string; from: string; to: string }[];
}

/** Days short of protein by more than PROTEIN_MISS that still hold a meal the engine may move, worst first. */
export function shortDays(stats: WeekStats, proteinTarget: number, onlyDays?: readonly string[]) {
  return stats.days
    .filter((d) => (!onlyDays || onlyDays.includes(d.day)) && proteinTarget - d.protein > PROTEIN_MISS)
    .filter((d) => d.meals.some((m) => !m.record))
    .sort((a, b) => a.protein - b.protein);
}

/** The operation a suggestion previews and, on one tap, commits: the same one, so what was shown is what happens. */
export const fixFor = (day: Day) => ({ tool: "regenerate_day" as const, day });

/** How many short days are previewed before giving up: a preview is a request, and the worst day comes first. */
const TRIES = 2;

export async function findSuggestion(stats: WeekStats, proteinTarget: number, onlyDays?: readonly string[]): Promise<Suggestion | null> {
  for (const d of shortDays(stats, proteinTarget, onlyDays).slice(0, TRIES)) {
    const day = d.day as Day;
    const preview = await previewOperation(fixFor(day));
    const after = preview.days.find((x) => x.day === day);
    if (preview.wouldChangePlan && after && after.protein - d.protein >= PROTEIN_MISS)
      return {
        day, protein: Math.round(d.protein), after: Math.round(after.protein), target: proteinTarget,
        moves: preview.moves.filter((m) => m.day === day).map(({ slot, from, to }) => ({ slot, from, to })),
      };
  }
  return null;
}

/** The line itself. The figures are the engine's; the words say what the button will do, and nothing more. */
export function suggestionText(s: Suggestion): string {
  const short = Math.round(s.target - s.protein);
  const reaches = s.after >= s.target - PROTEIN_MISS ? `${s.after} g, on your ${s.target} g` : `${s.after} g`;
  const swaps = s.moves.map((m) => `${m.slot} to ${m.to}`);
  const how = swaps.length ? `Switching ${swaps.length > 1 ? `${swaps.slice(0, -1).join(", ")} and ${swaps[swaps.length - 1]}` : swaps[0]} brings it to ${reaches}.` : `Re-planning it brings it to ${reaches}.`;
  return `${s.day} is ${short} g short of protein. ${how}`;
}
