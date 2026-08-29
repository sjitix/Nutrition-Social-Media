import { selectWeekFromDb, rebalanceWeek, applyOperations } from "@/lib/recipeDb";
import type { UserProfile, Operation } from "@/lib/types";
const BASE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const op = (o: Partial<Operation>): Operation => ({
  tool: "answer", day: null, mealType: null, dish: null, cuisine: null, diet: null,
  budget: null, excludeFoods: [], targetCalories: null, targetProtein: null,
  targetCarbs: null, targetFat: null, targetFiber: null, maxCookTime: null, ...o,
} as Operation);
let identical = 0, notChanged = 0;
const N = 300;
for (let i = 0; i < N; i++) {
  const plan = rebalanceWeek(selectWeekFromDb(BASE), BASE);
  const changed = applyOperations(BASE, plan, [op({ tool: "regenerate_week" })]);
  if (JSON.stringify(changed.plan) === JSON.stringify(plan)) identical++;
  if (!changed.planChanged) notChanged++;
}
console.log(`identical plans: ${identical}/${N}`);
console.log(`planChanged=false: ${notChanged}/${N}`);
