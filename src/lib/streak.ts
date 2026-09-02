/**
 * A gentle daily-use streak — the habit hook every widely-used app leans on. It counts REAL,
 * consecutive days the app was opened (recorded in localStorage), nothing fabricated. Day math is
 * pure and keyed to the LOCAL calendar day — the same "today" the rest of the app shows — and
 * "today" is always passed in.
 */

/**
 * A Date -> "YYYY-MM-DD" using LOCAL calendar components. Must be local, not UTC: the rest of the app
 * defines "today" locally (getDay / getHours / toLocaleDateString), so a UTC key broke AND inflated
 * streaks near local midnight for users west of UTC — an evening open landed on the next UTC day,
 * punching a hole in (or double-counting) the local-day sequence.
 */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day before an ISO day, as an ISO day. Local-date arithmetic, so it round-trips with isoDay. */
export function prevDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDay(new Date(y, m - 1, d - 1)); // day - 1 rolls month/year/leap boundaries correctly
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
