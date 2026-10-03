/**
 * FAST FINISH — an experiment in skipping the agent loop's last model call, run entirely from the
 * eval side (FAST_FINISH=1), with no change to the app.
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
 * If the evals score the same with it on, the loop could do this itself; that change would be v1's.
 */
import type { ModelFn, TranscriptEntry } from "@/lib/agentLoop";
import { isReadTool } from "@/lib/agentTools";

function finishable(t: TranscriptEntry[]): boolean {
  const last = t[t.length - 1];
  if (!last || last.role !== "tool" || last.name !== "apply") return false;
  const r = last.result as { notes?: string[]; planChanged?: boolean; profileChanged?: boolean };
  if (!(r.planChanged || r.profileChanged) || !(r.notes && r.notes.length)) return false;
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.role === "assistant") return !e.turn.operations.some((o) => isReadTool(String((o as { op?: string }).op)));
  }
  return false;
}

export function withFastFinish(model: ModelFn, enabled: boolean) {
  const stats = { realCalls: 0, skipped: 0 };
  const fn: ModelFn = async (transcript, step, state) => {
    if (enabled && finishable(transcript)) {
      stats.skipped++;
      return { thinking: "(fast finish: the engine's notes are the reply)", reply: "", operations: [] };
    }
    stats.realCalls++;
    return model(transcript, step, state);
  };
  return { fn, stats };
}
