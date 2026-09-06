import { demoWeek } from "../demo";
import { groceriesFromWeek } from "../myPlan";
import { GroceriesClient } from "./GroceriesClient";

/**
 * The shopping list. Server-computes the shared demo week's list so a first visit renders instantly;
 * GroceriesClient swaps in the visitor's OWN list once they've built a plan (see myPlan). Ingredients
 * are deduped across the week and bucketed with `groupByAisle`, the tested categoriser the app uses.
 */
export default function SageGroceriesPage() {
  const demoGroups = groceriesFromWeek(demoWeek().raw);
  return <GroceriesClient demoGroups={demoGroups} />;
}
