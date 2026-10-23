/**
 * WHY A MODEL CALL FAILED: the contract between a `ModelFn` and the loop.
 *
 * A ModelFn that cannot produce a turn throws. The loop used to treat every throw alike, so an answer the
 * model DID send, in the wrong shape, reached the person as "the assistant is offline", and a turn refused
 * for one malformed op took a stated allergy with it (F5's mapping, 2026-10-22: MF-2, MF-3). The provider
 * now says which failure it was. The loop and the route act on the kind, never on the error's text, which
 * can carry a server's URL.
 *
 * It lives here, beside ModelFn, because the provider layer sits above this one: the loop may not import
 * providers/, so the provider imports this.
 */
export type ModelFailureKind =
  | "unreachable" // no answer at all: the server or the network is down
  | "timeout" // no answer in time
  | "busy" // 429: rate-limited
  | "unavailable" // 5xx: the host failed
  | "config" // 401, 403, 404: a key, a model name or a URL is wrong
  | "rejected" // any other 4xx: the host refused this request
  | "unreadable" // it answered, but not as a turn the loop can use (not JSON, or not the schema)
  | "empty"; // it answered with nothing

export class ModelFailure extends Error {
  constructor(
    readonly kind: ModelFailureKind,
    message: string,
    /** For "unreadable": what the model sent, parsed (so the facts it asked to remember can be kept), and
     *  why it was refused, for the model's next step. For "busy": how long the host asked us to wait. */
    readonly detail: { raw?: unknown; issues?: string; retryAfterS?: number } = {},
  ) {
    super(message);
    this.name = "ModelFailure";
  }
}

/** Any throw as a failure: a ModelFailure says what it was; anything else reads as unreachable, which is
 *  how every failure was read before the provider said. */
export function modelFailureOf(e: unknown): ModelFailure {
  return e instanceof ModelFailure ? e : new ModelFailure("unreachable", e instanceof Error ? e.message : String(e));
}

/** A model host's HTTP status as a failure. `retryAfter` is the Retry-After header; only its seconds form
 *  is read. */
export function failureFromStatus(status: number, message: string, retryAfter?: string | null): ModelFailure {
  const kind: ModelFailureKind =
    status === 429 ? "busy"
    : status >= 500 ? "unavailable"
    : status === 401 || status === 403 || status === 404 ? "config"
    : "rejected";
  const s = retryAfter?.trim();
  return new ModelFailure(kind, message, s && /^\d+$/.test(s) ? { retryAfterS: Number(s) } : {});
}

/** Whether the same call, tried again, could succeed. An empty answer is the host's failure, not the model's
 *  (the free NVIDIA tier returns empty 200s under load), so it is retried like one and never reaches the loop's
 *  nudge, which would tell the model its turn could not be read (review of F5a, 2026-10-22). */
export const retryableFailure = (f: ModelFailure): boolean =>
  f.kind === "busy" || f.kind === "unavailable" || f.kind === "unreachable" || f.kind === "empty";
