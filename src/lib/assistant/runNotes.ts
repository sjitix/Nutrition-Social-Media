/**
 * A run's notes, settled against its FINAL week. Pure: no model, no engine state.
 *
 * The agent loop runs a message as steps, and each step's engine notes describe the week as that step
 * left it. The person reads all of them at the end, so a note a later step made untrue was shown as true
 * (the second review's #14, reproduced 2026-10-27 on main):
 *   - "Monday now has 2000 kcal … Fiber is 19g" from a swap, then "Monday now comes to 2192 kcal" from a
 *     resize of the same day: two totals for one day, the first false;
 *   - "Your allergies still include peanuts, so nothing with them is planned." from a denial, then an
 *     undo that took peanuts off, over a week serving two peanut dishes.
 *
 * Two kinds of note are settled here, and every other note is kept as written (an action record, "I
 * swapped …", stays true after a later step):
 *   1. A note given as a FUNCTION of the final week and profile (an allergy fact's sentences,
 *      primitives.ts allergyNotes) is rendered once, from the run's end.
 *   2. A FIGURES sentence (the engine's own templates: "<Day> now has …", "<Day> now comes to …",
 *      "Your week now averages …", and the sentences achievementNote appends to them) is dropped when a
 *      later step changed what it describes: that day, or for the week any day, or the targets it is
 *      measured against. If nothing after it states those figures again, one line from the final week
 *      replaces it (plan/report.ts figuresNote), so the reply still says where the day landed.
 */
import { DAYS, MICRO_KEYS, MICRO_LABEL, type MicroKey, type UserProfile, type WeekPlan } from "../core";
import { figuresNote, microNote } from "../plan";

export type Final = { plan: WeekPlan; profile: UserProfile };
/** A note as text, or as a function of the run's final week and profile. */
export type NoteSource = string | ((final: Final) => string[]);
/** One note, tagged with the phase (an engine call) that wrote it. */
export interface RunNote {
  source: NoteSource;
  phase: number;
}
/** What one phase changed: the days whose meals differ, and whether the targets moved. */
export interface PhaseChange {
  phase: number;
  days: ReadonlySet<string>;
  targets: boolean;
}

type Day = (typeof DAYS)[number];
/** What a figure describes: a day, the week's calories and protein, or the week's average of one nutrient. */
type Subject = Day | "week" | `micro:${MicroKey}`;

const DAY = `(${DAYS.join("|")})`;
const DAY_FIGURES = new RegExp(`^${DAY} now (?:has|comes to) \\d`);
const WEEK_FIGURES = /^Your week now averages /;
// A boost's figure (plan/report.ts microNote): the week's average of one nutrient, re-stated with microNote when stale.
const MICRO_FIGURES = /^Your week now averages about [\d.]+\S* of (.+?) a day\b/;
const microKeyOf = (label: string) => MICRO_KEYS.find((k) => MICRO_LABEL[k] === label);
// "I re-solved the rest of Monday: it now lands at …" and "Balanced Monday around … — the day now lands at about …":
// an action and a figure in one sentence. Stale, the figure half goes and the action half stays.
const LANDS = new RegExp(`^(.*?\\b${DAY}\\b.*?)(?::| —) (?:it|the day) now lands at [^.]*\\.$`);
// What achievementNote appends after "<label> N kcal and Mg protein.": each belongs to the figure before it.
const CONTINUES = /^(?:I couldn't reach \d|That's \d+g? (?:under|kcal)|That's \d+ kcal|Carbs come to \d|Fat comes to \d|Fiber is \d)/;

/** Sentences, split the way the claim guard splits a reply (reply.ts). */
const sentencesOf = (text: string) => text.split(/(?<=[.!?…]["”')\]]*)\s+/).filter((s) => s.trim());

export function settleNotes(entries: RunNote[], changes: PhaseChange[], final: Final): string[] {
  // Did anything after `phase` change what a figure about `subject` describes?
  const staleAfter = (phase: number, subject: Subject) =>
    changes.some((c) => c.phase > phase && (c.targets || (subject === "week" || subject.startsWith("micro:") ? c.days.size > 0 : c.days.has(subject))));

  const rendered = entries.flatMap((e) =>
    (typeof e.source === "string" ? [e.source] : e.source(final)).map((text) => ({ text, phase: e.phase })));

  const dropped = new Set<Subject>();
  const stated = new Set<Subject>(); // subjects some surviving sentence still gives figures for
  const out: string[] = [];
  for (const { text, phase } of rendered) {
    let subject: Subject | null = null; // the figure the next continuation sentence belongs to
    let stale = false;
    const kept: string[] = [];
    for (const s of sentencesOf(text)) {
      const day = s.match(DAY_FIGURES)?.[1] as Day | undefined;
      const micro = microKeyOf(s.match(MICRO_FIGURES)?.[1] ?? "");
      const lands = s.match(LANDS);
      if (day || micro || WEEK_FIGURES.test(s)) {
        subject = day ?? (micro ? (`micro:${micro}` as const) : "week");
        stale = staleAfter(phase, subject);
        if (stale) dropped.add(subject);
        else { stated.add(subject); kept.push(s); }
      } else if (lands) {
        subject = lands[2] as Day;
        stale = staleAfter(phase, subject);
        if (stale) { dropped.add(subject); kept.push(`${lands[1]}.`); }
        else { stated.add(subject); kept.push(s); }
      } else if (subject && CONTINUES.test(s)) {
        if (!stale) kept.push(s);
      } else {
        subject = null;
        kept.push(s);
      }
    }
    if (kept.length) out.push(kept.join(" "));
  }

  // Say where each day whose figures went stale finally landed, unless a later sentence already does.
  const order: Subject[] = [...DAYS, ...MICRO_KEYS.map((k) => `micro:${k}` as const), "week"];
  for (const subject of order) {
    if (!dropped.has(subject) || stated.has(subject)) continue;
    const line = subject.startsWith("micro:") ? microNote(final.plan, subject.slice(6) as MicroKey)
      : figuresNote(final.plan, final.profile, subject === "week" ? undefined : (subject as Day));
    if (line) out.push(line);
  }
  return out;
}

/** The days whose meals differ between two weeks. */
export function changedDays(before: WeekPlan, after: WeekPlan): Set<string> {
  const days = new Set<string>();
  const key = (p: WeekPlan, d: string) => JSON.stringify(p.days.find((x) => x.day === d)?.meals ?? null);
  for (const d of DAYS) if (key(before, d) !== key(after, d)) days.add(d);
  return days;
}

/** Whether the targets a figure is measured against moved. */
export function targetsChanged(a: UserProfile, b: UserProfile): boolean {
  const pick = (p: UserProfile) => [p.targetCalories, p.proteinGrams, p.carbsGrams, p.fatGrams, p.fiberGrams, p.diet];
  return JSON.stringify(pick(a)) !== JSON.stringify(pick(b));
}
