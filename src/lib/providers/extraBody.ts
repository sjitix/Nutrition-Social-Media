/**
 * Extra fields for the local/hosted chat request, from LOCAL_AI_EXTRA_BODY (a JSON object), merged
 * into the body last. It exists so a host-specific switch is CONFIGURATION, not a code fork: on the
 * NVIDIA-hosted 550B, {"chat_template_kwargs":{"enable_thinking":false}} turns reasoning off, which
 * the models lane measured at ~4x faster per turn with no loss of quality (with the false-claim
 * guard; without it, that model claimed changes it never made). Hosts differ: LM Studio ignores
 * unknown fields, a strict host may reject them, and other models use other fields
 * (reasoning_effort), so nothing is assumed. Unset means today's body, byte for byte. Anything that is
 * not a JSON object is ignored with one warning, never a crash.
 */
let warned = false;
export function localExtraBody(raw: string | undefined = process.env.LOCAL_AI_EXTRA_BODY): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through to the warning */
  }
  if (!warned) {
    warned = true;
    console.warn("LOCAL_AI_EXTRA_BODY is set but is not a JSON object; ignoring it.");
  }
  return {};
}
