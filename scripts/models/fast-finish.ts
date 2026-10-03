/**
 * FAST FINISH — an experiment in skipping the agent loop's last model call, run entirely from the
 * eval side (FAST_FINISH=1 or FAST_FINISH=reply), with no change to the app.
 *
 * Why: after every write, `runAgent` calls the model again so it can "finish". But when the engine
 * wrote notes, `composeReply` returns those notes as the reply and discards whatever the model says in
 * that last call. On a typical two-step message ("make tuesday vegetarian" -> apply -> finish) the
 * finish call costs a full model call (10-20 s on the free 550B) and changes nothing the user sees.
 *
 * This wraps the ModelFn: when the step that just ran (a) made no look-ups, (b) changed the plan or
 * profile, and (c) the engine wrote notes, the wrapper answers the finish call itself with no
 * operations, so the loop ends exactly as if the model had said "done". Every other call goes to the
 * real model, including after a refusal (nothing changed), so the model can still respond to one.
 *
 * Mode "reply" (v1's guard, 2026-10-03): ALSO require that the write step's turn carried a non-empty
 * reply. A model planning writes across steps would leave the reply empty ("more to come"), and must not
 * be cut short. `blockedByEmptyReply` counts how often that rule withheld a skip, which is what decides
 * whether the extra rule costs anything.
 */
import type { ModelFn, TranscriptEntry } from "@/lib/agentLoop";
import { isReadTool } from "@/lib/agentTools";

export type FastFinishMode = "off" | "plain" | "reply";

/** "skip" when this step may be skipped; "blocked" when only the empty-reply rule stopped it. */
function finishable(t: TranscriptEntry[], mode: FastFinishMode): "skip" | "blocked" | "no" {
  const last = t[t.length - 1];
  if (!last || last.role !== "tool" || last.name !== "apply") return "no";
  const r = last.result as { notes?: string[]; planChanged?: boolean; profileChanged?: boolean };
  if (!(r.planChanged || r.profileChanged) || !(r.notes && r.notes.length)) return "no";
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.role !== "assistant") continue;
    if (e.turn.operations.some((o) => isReadTool(String((o as { op?: string }).op)))) return "no";
    if (mode === "reply" && !(e.turn.reply ?? "").trim()) return "blocked";
    return "skip";
  }
  return "no";
}

/** `enabled` keeps the original boolean form working (true = "plain"). */
export function withFastFinish(model: ModelFn, enabled: boolean | FastFinishMode) {
  const mode: FastFinishMode = enabled === true ? "plain" : enabled === false ? "off" : enabled;
  const stats = { realCalls: 0, skipped: 0, blockedByEmptyReply: 0 };
  const fn: ModelFn = async (transcript, step, state) => {
    if (mode !== "off") {
      const f = finishable(transcript, mode);
      if (f === "skip") {
        stats.skipped++;
        return { thinking: "(fast finish: the engine's notes are the reply)", reply: "", operations: [] };
      }
      if (f === "blocked") stats.blockedByEmptyReply++;
    }
    stats.realCalls++;
    return model(transcript, step, state);
  };
  return { fn, stats };
}

/** FAST_FINISH env: "1" = plain, "reply" = with v1's non-empty-reply rule, anything else = off. */
export function fastFinishModeFromEnv(v: string | undefined): FastFinishMode {
  return v === "1" ? "plain" : v === "reply" ? "reply" : "off";
}
