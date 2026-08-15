import { cutoutForMeal, imageForMeal } from "@/lib/recipes";
import { DEMO, demoWeek } from "../demo";
import { TodayClient, type DayMeal } from "./TodayClient";

/**
 * Today — `designs/references/boards/sage-04`, transcribed, inside the sage shell.
 *
 * The board's page, and only its page:
 *
 *   · LEFT   a serif headline of two lines, a short paragraph, and beneath them a HUGE ROUND PLATE
 *            running off the bottom of the frame
 *   · RIGHT  a caption, THREE THICK RINGS with a number in each, two hairline spec rows (the
 *            second with a leader rule), then outlined rows each led by a dot
 *
 * The plate is the dish coming up next, the rings are the macros already hit, and the rows are the
 * meals still to come — the brief for what the parts hold.
 *
 * Three attempts got here. The first invented its own arrangement of the right parts. The second
 * transcribed the whole board — sidebar, side cards, dark footer — when the reference sent was a
 * crop of one panel of it. The third moved it out of `/sage` to shed the sidebar, which was a
 * misread: the sidebar is the app, and the board's own nav row is what the shell already provides.
 * So the composition lives here, in the shell, and drops the board's internal nav row because the
 * sidebar is that nav.
 *
 * WHY THE DAY IS MONDAY. Every figure on `/sage` comes from one fixture week, computed once in
 * `demo.ts` so no two tabs can describe different weeks. Today shows that week's Monday and says
 * "Monday" — it does not claim to be the reader's own day, because there is no reader's own data
 * here. The HOUR is real, so "up next" genuinely moves through the day. Monday is also the day the
 * demo profile pins the photographed poke bowl to, which is how the plate has a photograph on it
 * without any component special-casing a dish.
 */
export default function SageTodayPage() {
  const { days } = demoWeek();
  const day = days[0]; // Monday — see above

  const meals: DayMeal[] = day.meals.map((m) => ({
    name: m.name,
    type: m.type,
    description: m.description,
    calories: m.calories,
    protein: m.proteinGrams,
    fibre: m.fiberGrams ?? 0,
    minutes: m.timeMinutes,
    image: imageForMeal(m.name),
    cutout: cutoutForMeal(m.name),
  }));

  return (
    <TodayClient
      day={day.day}
      meals={meals}
      targets={{ calories: DEMO.targetCalories, protein: DEMO.proteinGrams, fibre: 30 }}
    />
  );
}
