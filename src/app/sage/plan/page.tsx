import { demoWeek, DEMO } from "../demo";
import WeekBoard from "./WeekBoard";

/**
 * The Week screen. Server-computes the shared engine DEMO week once (so a first visit and a crawler
 * get a real, instant plan), then hands it to WeekBoard — a client component that swaps in THIS
 * visitor's own saved week when they've built one (see myPlan.ts). Every figure comes from
 * summariseWeek, the single copy of that arithmetic.
 *
 * The board was built from `designs/references/boards/sage-10 … sage-12`: seven independent columns
 * of flat sage blocks on a cream page, ragged bottoms, with the sage-12 photograph strip on top. A
 * dish with no photograph of its own gets a typographic tile — it never borrows another's picture.
 */
export default function SagePlanPage() {
  const week = demoWeek();
  return (
    <WeekBoard
      demo={{
        stats: week,
        targets: {
          targetCalories: DEMO.targetCalories,
          proteinGrams: DEMO.proteinGrams,
          mealsPerDay: DEMO.mealsPerDay,
        },
      }}
    />
  );
}
