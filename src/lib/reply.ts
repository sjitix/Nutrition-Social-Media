import type { Operation } from "./types";

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

export function composeReply(args: {
  /** What the LLM wrote. Untrusted prose. */
  modelReply: string | undefined;
  /** Facts the engine computed. The LLM cannot produce these; it does no arithmetic. */
  notes: string[];
  /** Set by the engine on a crisis or urgent medical symptom. Discards the model entirely. */
  replyOverride?: string;
  planChanged: boolean;
}): string {
  const { modelReply, notes, replyOverride, planChanged } = args;

  // The engine's word is final. Not prepended to, not appended to — the whole reply.
  if (replyOverride) return replyOverride;

  // Fall back to filler ONLY when the engine has nothing to say. Otherwise "Happy to help."
  // would introduce a paragraph about the user's vitamin D.
  const base =
    modelReply?.trim() || (notes.length ? "" : planChanged ? "Done — I updated your plan." : "Happy to help.");
  return [base, ...notes].filter(Boolean).join(" ");
}
