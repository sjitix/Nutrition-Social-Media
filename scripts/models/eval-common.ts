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
import type { ModelFn } from "@/lib/agentLoop";

/** Network, timeout, rate limit, gateway or server errors: not the model's output. An EMPTY response is
 *  counted here too: the free NVIDIA tier returns empty 200s under load (latency-anatomy saw 3 in 16 calls),
 *  so it is the host's failure far more often than the model's. */
const INFRA = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network|timed? ?out|abort|\b429\b|rate.?limit|too many requests|\b50[0-4]\b|bad gateway|service unavailable|unreachable|no models? loaded|model_not_found|empty response/i;
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

/** composeReply's fallback for an empty model reply, or next to nothing: not an answer. */
export const hollowReply = (reply: string) => {
  const t = reply.trim();
  return t === "" || t === "Happy to help." || t.length < 12;
};
