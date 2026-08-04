/**
 * A gentle daily-use streak — the habit hook every widely-used app leans on. It counts REAL,
 * consecutive days the app was opened (recorded in localStorage), nothing fabricated. All date math
 * is pure and UTC-normalised so it's testable and timezone-stable, and "today" is always passed in.
 */

/** A Date -> "YYYY-MM-DD" (UTC), the canonical day key we store and compare. */
export function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** The day before an ISO day, as an ISO day. */
export function prevDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  return isoDay(new Date(t));
}

/**
 * The current streak: how many consecutive days up to and INCLUDING `today` appear in the visit
 * history. Since the app records a visit on open, `today` is present whenever the user is looking at
 * it, so an active user sees at least 1. Returns 0 if today isn't recorded (streak not active today).
 */
export function currentStreak(visitDates: string[], today: string): number {
  const set = new Set(visitDates);
  if (!set.has(today)) return 0;
  let streak = 0;
  let day = today;
  while (set.has(day)) {
    streak++;
    day = prevDay(day);
  }
  return streak;
}
