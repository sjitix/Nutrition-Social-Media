/**
 * JSON with every object's keys sorted, so two values compare by CONTENT. Pure, no imports.
 *
 * Why it exists: a screen that keeps a copy of the week (the chat, the undo snapshot) has to know
 * whether storage still holds what it last wrote, or whether something else wrote since: a sync
 * pulling a newer week from the account, "Delete everything", a mode switch, another tab. Comparing
 * raw JSON would call a reordered object a change; storage and Postgres both reorder keys (the
 * accounts lane's lesson about jsonb), so the comparison has to be blind to order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return x;
}
