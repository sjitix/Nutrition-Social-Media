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
]);

export function planWasChanged(operations: Operation[]): boolean {
  return operations.some((o) => !READ_ONLY_TOOLS.has(o.tool));
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
