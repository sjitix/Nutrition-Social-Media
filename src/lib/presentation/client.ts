// presentation, browser-safe: the feed's card type and pure filter/sort, imagery, grocery maths, streaks.
// V1 D5a part 3 (2026-10-03). Only what someone outside this folder uses is here; everything else in
// the folder is private, and check:boundaries fails an import that reaches past this file.
export { filterFeed, sortFeed, HIGH_PROTEIN_G, type FeedItem, type FeedFilter, type FeedMealType, type FeedDiet, type FeedSort } from "./feedFilter";
export { imageForMeal, cutoutForMeal, gradientForMeal, PHOTOGRAPHED_RECIPES } from "./recipes";
export { bulkGroceriesFromWeek, batchEfficiency, formatBulkQuantity, type BatchEfficiency, type SessionGroceries } from "./batchGrocery";
export { currentStreak, isoDay, prevDay, requestDay } from "./streak";
