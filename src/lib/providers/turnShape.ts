/**
 * A model's turn, read the way the schema reads it, before it is validated. Its own module, like
 * ./extraBody, so the rule is tested without loading the provider.
 *
 * Open models write a meal type in capitals ("Breakfast"), and name a constrain's slot their own way:
 * {mealType: "lunch"}, {type: "Lunch"}, or {slot: null, days: [...]} for the whole day. The schema's {days}
 * scope is strict, because a slot it could not read used to be stripped and the whole day re-planned
 * (review, 2026-10-21); so everything readable is made readable here first, and only a slot that really
 * cannot be read ("brunch", a list of slots) reaches the schema and is refused.
 */
const MEAL_TYPE_SET = new Set(["breakfast", "lunch", "dinner", "snack"]);
/** A scope key that names a meal, whatever the model called it. */
const SLOT_KEYS = ["slot", "mealType", "type", "meal"];
/** Keys that name several meals: kept, so the schema refuses them rather than reading the whole day. */
const MANY_SLOT_KEYS = /^(?:slots|meals|mealtypes|types)$/i;
/** Values that name no one meal: a scope holding one means the whole day(s). */
const ALL_MEALS = /^\s*(?:all|any|every|all meals|every meal|whole day|the whole day|all day)?\s*$/i;

/**
 * A constrain scope as the schema reads it: {slot, days?}, {days} or "week". A slot under another key or in
 * capitals is the slot. A key that names no meal (null, "", "all") is dropped, so the scope means the whole
 * day(s), as the model meant: the strict schema refused those turns, an allergy in the same turn was lost,
 * and the person was told the assistant was offline (review, 2026-10-21). So are keys that are not about
 * meals at all ({note: "..."}).
 */
function normalizeScope(sc: Record<string, unknown>): void {
  for (const key of SLOT_KEYS) {
    const v = sc[key];
    if (v === null || v === undefined || (typeof v === "string" && ALL_MEALS.test(v))) { delete sc[key]; continue; }
    if (key === "slot" || typeof v !== "string") continue;
    if (sc.slot === undefined) { sc.slot = v; delete sc[key]; }
    else if (typeof sc.slot === "string" && sc.slot.trim().toLowerCase() === v.trim().toLowerCase()) delete sc[key];
  }
  if (typeof sc.slot === "string" && MEAL_TYPE_SET.has(sc.slot.trim().toLowerCase())) sc.slot = sc.slot.trim().toLowerCase();
  for (const key of Object.keys(sc)) if (key !== "days" && !SLOT_KEYS.includes(key) && !MANY_SLOT_KEYS.test(key)) delete sc[key];
}

/** Lowercases any "type", "slot" or "mealType" field whose lowercase form is a meal type, wherever it appears,
 *  and reads every constrain scope as the schema does (normalizeScope). Mutates `node`. */
export function normalizeMealTypes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeMealTypes(item);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["type", "slot", "mealType"]) {
      const v = obj[key];
      if (typeof v === "string" && MEAL_TYPE_SET.has(v.toLowerCase())) obj[key] = v.toLowerCase();
    }
    const scope = obj.scope;
    if (scope && typeof scope === "object" && !Array.isArray(scope)) normalizeScope(scope as Record<string, unknown>);
    for (const value of Object.values(obj)) normalizeMealTypes(value);
  }
}
