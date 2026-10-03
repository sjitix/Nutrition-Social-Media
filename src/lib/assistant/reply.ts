import type { Operation } from "../core/types";

/**
 * How a turn's final reply and plan-changed flag are assembled.
 *
 * This lived inline in the API route, which meant the single most safety-critical line in the app
 * — the one that decides whether the model is allowed to speak in front of a crisis warning — had
 * no test over it. It's a pure function now, and the tests below it in test-engine.mts are the
 * reason it stays correct.
 */

/** Tools that answer a question. They must never flag the plan as changed. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "answer",
  "weekly_report",
  "explain_meal",
  "substitute_ingredient",
  "symptom_check",
  // Pinning changes the PROFILE, not this week's meals — the plan on screen is untouched.
  "lock_meal",
  "unlock_meal",
  // A rating teaches the selector what to pick NEXT time. It never rewrites the week the user is
  // looking at: nobody says "I loved the salmon" meaning "please rebuild my Thursday".
  "rate_meal",
  // Water is not food. Asking how much to drink cannot change what's for dinner.
  "hydration",
]);

export function planWasChanged(operations: Operation[]): boolean {
  return operations.some((o) => !READ_ONLY_TOOLS.has(o.tool));
}

/**
 * A short phrase for what a turn did, so `undo` can name what it reversed: "put things back to how
 * they were before I rebuilt your week." Saying only "done" leaves the user to work out what moved.
 *
 * Written from the OPERATIONS, not from the model's reply — the reply is untrusted prose, and this
 * sentence is a claim about what actually happened.
 */
// Tools that change NOTHING — a pure question or advice. Undo never has to describe these. NB this
// is a subset of READ_ONLY_TOOLS: lock/unlock/rate DON'T change the plan (so they're read-only for
// the plan) but they DO change the profile, so undo can reverse them and must name them.
const PURE_QUERY_TOOLS: ReadonlySet<string> = new Set([
  "answer", "weekly_report", "explain_meal", "substitute_ingredient", "symptom_check", "hydration",
]);

export function describeOperations(operations: Operation[]): string {
  const phrases = operations
    .filter((o) => !PURE_QUERY_TOOLS.has(o.tool) && o.tool !== "undo")
    .map((o) => {
      const where = o.day && o.mealType ? `${o.day}'s ${o.mealType}` : o.day ? `${o.day}` : "";
      switch (o.tool) {
        case "regenerate_week": return "rebuilt your week";
        case "regenerate_day": return `rebuilt ${where || "that day"}`;
        case "swap_meal": return `swapped ${where || "that meal"}`;
        case "update_profile": return "changed your settings";
        case "compute_targets": return "worked out your targets";
        case "log_meal": return `logged ${where || "that meal"}`;
        case "eating_out": return `set calories aside for ${where || "eating out"}`;
        case "scale_portions": return `resized ${where || "your portions"}`;
        case "rebalance_day": return `rebalanced ${where || "that day"}`;
        case "lock_meal": return `pinned ${where || "that meal"}`;
        case "unlock_meal": return `unpinned ${where || "that meal"}`;
        case "rate_meal": return `saved your rating`;
        default: return "made that change";
      }
    });
  if (!phrases.length) return "made that change";
  return phrases.length === 1
    ? phrases[0]
    : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * Does this reply CLAIM that something changed? ("Done — dinner is now lighter", "Wednesday now has
 * 2000 kcal", "I've swapped your breakfast".)
 *
 * Why it exists: with reasoning turned off, a fast model imitated the engine's note style from earlier
 * turns and claimed changes it never made, quoting numbers the engine never computed. No operation
 * ran, so `planChanged` was rightly false, but the text told the user the opposite (models lane,
 * 2026-10-03: 2 of 28 turns with reasoning off; earlier fine-tunes did it too, e.g. "Done — I've made
 * your breakfast egg-free" after an operation that changed nothing). The pattern is theirs, validated
 * on every stored turn: it catches 8 of 8 fabrications and trips on none of 5 honest replies. Note
 * "right now / currently averages" is a description, not a claim. ONE copy: the evals import this.
 */
const CLAIMS_CHANGE =
  /^(done|all set)\b|(?<!\bright |\bcurrently |\bas of )\bnow (has|lands|averages|comes to)\b|\bi(?:'ve| have) (made|swapped|changed|updated|added|lightened|moved|set|replaced|resized|raised|increased|boosted|bumped)\b/i;

/** The passive voice says it too: "Breakfast has been swapped", "Your dinners are now quicker". Same
 *  exception for a description ("currently lighter", "right now"). Models lane, 2026-10-03: with it,
 *  8/8 of their claims are caught and 0/8 of their honest replies tripped. */
const CLAIMS_CHANGE_PASSIVE =
  /\b(?:has|have) been (?:swapped|changed|updated|added|lightened|scaled|moved|replaced|resized|raised|increased|boosted|bumped|made|set|adjusted|reduced|lowered|removed|cut|trimmed)\b|(?<!\bright |\bcurrently )\b(?:is|are) now (?:lighter|quicker|faster|smaller|bigger|heavier|cheaper|vegetarian|vegan|higher|lower|meat-free|dairy-free|gluten-free)\b/i;

export function claimsChange(text: string): boolean {
  const t = text.trim().replace(/[‘’]/g, "'");
  return CLAIMS_CHANGE.test(t) || CLAIMS_CHANGE_PASSIVE.test(t);
}

/** What the user reads instead of a claim the engine cannot back. Honest, and it keeps the turn going. */
export const NOTHING_CHANGED_REPLY =
  "I haven't changed anything yet. Tell me what you'd like changed and I'll do it, or ask me to show you the plan first.";

export function composeReply(args: {
  /** What the LLM wrote. Untrusted prose. */
  modelReply: string | undefined;
  /** Facts the engine computed. The LLM cannot produce these; it does no arithmetic. */
  notes: string[];
  /** Set by the engine on a crisis or urgent medical symptom. Discards the model entirely. */
  replyOverride?: string;
  planChanged: boolean;
  /**
   * Whether the profile changed. Pass it when you KNOW it (the agent loop does): with both flags
   * false and no engine notes, a model reply that claims a change is replaced by
   * NOTHING_CHANGED_REPLY, because nothing the user can see would back it. Left undefined, the reply
   * passes as before — a caller that cannot tell must not silence a true statement.
   */
  profileChanged?: boolean;
}): string {
  const { modelReply, notes, replyOverride, planChanged, profileChanged } = args;

  // The engine's word is final. Not prepended to, not appended to — the whole reply. Keyed off
  // PRESENCE, not truthiness: an override is set only on a crisis or urgent symptom, where the model
  // must be silenced entirely. If a bug ever set it to "", truthiness would fall through and let the
  // model speak in front of the warning — the exact failure this line exists to prevent — so a
  // present-but-empty override still wins and simply yields an empty reply: a safe, visible failure
  // rather than a dangerous, silent one.
  if (replyOverride !== undefined) return replyOverride;

  // Engine notes are AUTHORITATIVE computed facts. When the engine has something to say, that IS the
  // reply — the model's prose is untrusted and, worse, the fine-tune learned to restate the notes,
  // which duplicated them ("Kept Monday on target. Kept Monday on target — 1993 kcal…"). So notes win
  // outright; the model's reply is only used when the engine is silent (a pure question / clarify).
  // Trim, drop empties, and DE-DUPLICATE before joining: the fine-tune's restatement was fixed, but
  // the same note still arrives twice via a repeated op (single-shot) or an op repeated across loop
  // steps (agentLoop accumulates every step's notes) — the user must not read the same sentence
  // twice, and an all-empty notes array must fall through to the model/fallback, not return "".
  const clean = [...new Set(notes.map((n) => n.trim()).filter(Boolean))];
  if (clean.length) return clean.join(" ");

  const base = modelReply?.trim();
  if (base) {
    // The engine is silent and nothing changed, so this text is the model's alone. It may not say
    // something changed (the two-layer rule: only the engine may claim a change).
    if (profileChanged === false && !planChanged && claimsChange(base)) return NOTHING_CHANGED_REPLY;
    return base;
  }
  return planChanged ? "Done — I updated your plan." : "Happy to help.";
}
