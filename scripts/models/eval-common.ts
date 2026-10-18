/**
 * Shared by loop-eval and convo-eval: two rules an adversarial review of the harness showed were missing
 * (2026-10-03).
 *
 * 1. A model failure is not automatically infrastructure. `runAgent` reports every thrown model error as
 *    `modelFailed`, and the evals used to treat all of those as infra: re-run them, then leave them out of
 *    the score. But the adapter also throws when the MODEL's output is unusable (invalid JSON, a schema
 *    miss, empty content). That is the model's fault, and dropping it flatters weak models. So the error
 *    is captured, and only transport failures (network, timeout, rate limit, 5xx) count as infra.
 * 2. A hold turn must still answer. With an empty model reply, composeReply falls back to "Happy to
 *    help.", and a hold check that only asked "did the plan stay put?" passed it, so a model that says
 *    nothing scored like one that answered well.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { AgentTurnSchema, type AgentRunResult, type AgentTurn, type ModelFn } from "@/lib/assistant";

/** Network, timeout, rate limit, gateway or server errors: not the model's output. An EMPTY response is
 *  counted here too: the free NVIDIA tier returns empty 200s under load (latency-anatomy saw 3 in 16 calls),
 *  so it is the host's failure far more often than the model's. */
const INFRA = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network|timed? ?out|abort|\b429\b|rate.?limit|too many requests|\b50[0-4]\b|bad gateway|service unavailable|unreachable|no models? loaded|model_not_found|empty response|could not reach|server error \(\d{3}\)/i;
export const isInfraError = (msg: string) => msg === "" || INFRA.test(msg);

/** Wraps a ModelFn and remembers the message of the last error it threw (reset before each run). */
export function withErrorCapture(model: ModelFn) {
  let last = "";
  const fn: ModelFn = async (t, s, st) => {
    try {
      return await model(t, s, st);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      throw e;
    }
  };
  return { fn, lastError: () => last, reset: () => { last = ""; } };
}

/**
 * MODEL_SCRIPT=<file.json>: an in-process scripted model, for the harness's POSITIVE and NEGATIVE
 * controls (a check must pass the answer it rewards and fail the plausible wrong ones). No server and no
 * port, so many controls run at once. The file maps a phrase of the user's message (case-blind) to the
 * turn sent on that message's FIRST call, or to a list of turns, one per call (a look-up, then a write).
 * A call past the list, or a message no phrase matches, gets the do-nothing turn. Each turn is checked
 * against AgentTurnSchema first, as the adapter checks a real model's, and an invalid one throws
 * (graded "unusable model output"), so a typo in a script cannot pose as a strict check.
 */
export function scriptedModel(path: string): ModelFn {
  const script = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return async (transcript, step) => {
    const last = [...transcript].reverse().find((e) => e.role === "user");
    const text = last && last.role === "user" ? last.content.toLowerCase() : "";
    const hit = Object.keys(script).find((phrase) => text.includes(phrase.toLowerCase()));
    const entry = hit === undefined ? undefined : script[hit];
    const turns = entry === undefined ? [] : Array.isArray(entry) ? entry : [entry];
    const raw = (turns[step - 1] ?? {}) as Record<string, unknown>;
    const parsed = AgentTurnSchema.safeParse({ thinking: "", reply: "", operations: [], ...raw });
    if (!parsed.success) throw new Error(`MODEL_SCRIPT: call ${step} for "${hit}" is not a valid agent turn: ${parsed.error.message.slice(0, 300)}`);
    return parsed.data as unknown as AgentTurn;
  };
}
/** The scorecard's model name for a scripted run. */
export const scriptLabel = (path: string) => `script-${basename(path).replace(/\.json$/i, "")}`;

/** composeReply's fallback for an empty model reply, or next to nothing: not an answer. */
export const hollowReply = (reply: string) => {
  const t = reply.trim();
  return t === "" || t === "Happy to help." || t.length < 12;
};

/**
 * Why a turn that should HOLD (leave the plan alone) failed, or null. It must also have answered: an
 * empty reply fails, and so does a reply the false-claim guard had to replace. A model that answered
 * every question with "Done, I've swapped it" and no operations passed 8 of 10 loop holds (the hollow
 * stub, 2026-10-18): the guard swapped its reply for a canned honest line (NOTHING_CHANGED_REPLY, or
 * since 5c12c4c NOTED_NOTHING_CHANGED_REPLY), which reads like an answer. The guard's own flag is the
 * test, so a third canned line can't reopen the hole. Read optionally: it exists only from 361b2e1.
 */
export const holdFailure = (r: Pick<AgentRunResult, "planChanged" | "reply"> & { falseClaimCaught?: boolean }) =>
  r.planChanged ? "changed the plan when it should have held"
  : r.falseClaimCaught ? "claimed a change it never made (the guard replaced its reply)"
  : hollowReply(r.reply) ? `held, but said nothing ("${r.reply.trim()}")`
  : null;
