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

/**
 * The day a request acts on: the person's OWN calendar day when their browser sent a believable one,
 * else the server's UTC day.
 *
 * The assistant tells the model "Today is Monday…" and the engine logs meals against that date. Taken
 * from the server alone, it was the UTC day, so for someone in New York at 9 pm, "today" was already
 * tomorrow: "I had pasta tonight" landed on the wrong day. The browser knows the local day; the server
 * only checks it is a real date that some time zone is in RIGHT NOW: between the date at UTC-12 and the
 * date at UTC+14, the two ends of the Earth's clocks. (A plain "within a day of UTC" window was three
 * days wide and accepted dates no zone was in.) Anything else (missing, malformed, "2026-02-31", a
 * week off) falls back to the server's day rather than letting a request set an arbitrary date.
 */
export function requestDay(sent: unknown, now: Date): string {
  const server = now.toISOString().slice(0, 10);
  if (typeof sent !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sent)) return server;
  const t = Date.parse(`${sent}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== sent) return server;
  const HOUR = 3_600_000;
  const earliest = new Date(now.getTime() - 12 * HOUR).toISOString().slice(0, 10);
  const latest = new Date(now.getTime() + 14 * HOUR).toISOString().slice(0, 10);
  return sent >= earliest && sent <= latest ? sent : server;
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
