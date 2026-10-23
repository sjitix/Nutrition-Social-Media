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

/** Where the object opened at `start` closes, tracking strings so a brace inside one does not count; -1 if it
 *  never does (the text was cut off). */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Every JSON object written in a model's text, at any depth, in the order each starts. An answer is meant to be
 * one object, but a stray brace in the prose around it ("Output format: {thinking, reply, operations}"), or an
 * answer cut off at the token limit, made the whole of it unreadable, a stated allergy with it (review of F5a,
 * 2026-10-22).
 */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = closingBrace(text, start);
    if (end < 0) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      /* not JSON from this brace; an object inside it may still be */
    }
  }
  return out;
}

/** The turn in a text that is not one object as a whole: the first object in it with a turn's fields. */
export function turnIn(text: string): Record<string, unknown> | undefined {
  return jsonObjectsIn(text).find((o) => "operations" in o || "reply" in o);
}

/** The ops written in a text where no whole turn can be read, each a complete object of its own. */
export function opsIn(text: string): Record<string, unknown>[] {
  return jsonObjectsIn(text).filter((o) => typeof o.op === "string");
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
