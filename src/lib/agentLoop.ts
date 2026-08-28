/**
 * THE AGENT LOOP — act, observe, re-plan, stop.
 *
 * Specified in ASSISTANT-SCHEMA.md v3; the reasoning is VISION.md's agent section. Everything
 * before this was single-shot: one model call, apply, respond. That is a classifier with good
 * manners. An agent acts, READS WHAT CAME BACK, notices it failed or surprised it, and goes again.
 *
 * The whole design in five lines:
 *
 *     turn = model(transcript)
 *     while turn asks for tools and steps < MAX_STEPS:
 *         results = execute(turn.operations)   // reads answer; writes go through applyPrimitives
 *         transcript += turn, results          // <- THE RESULTS GO BACK TO THE MODEL
 *         turn = model(transcript)
 *     reply = composeReply(turn.reply, engine notes)
 *
 * ── WHY THIS FILE TAKES THE MODEL AS AN ARGUMENT ───────────────────────────────────────────────
 * `model` is injected rather than imported. That is VISION's RULE 2: the loop is deterministic
 * infrastructure and must be testable with NO model at all — no GPU, no keys, no fine-tune. A
 * scripted provider returning canned turns pins down termination, the step cap, that engine notes
 * are fed back, and recovery from a refused operation. Build and test the harness BEFORE the model,
 * or a harness bug and a model weakness are indistinguishable.
 *
 * ── WHAT THIS FILE MUST NEVER DO ───────────────────────────────────────────────────────────────
 * Arithmetic. The two-layer rule is untouched: writes still go through `applyPrimitives`, which
 * remains the only thing allowed to claim that something changed.
 */
import { runReadTool, isReadTool, type AgentContext } from "./agentTools";
import { applyPrimitives, type PrimitiveOp } from "./primitives";
import { composeReply } from "./reply";
import type { PlanSnapshot, UserProfile, WeekPlan } from "./types";

/** A cap, not a target. Reaching it is a bug to investigate, not a normal outcome. */
export const MAX_STEPS = 8;

/** One reason-then-act turn: exactly what the v2 model was trained to emit. */
export interface AgentTurn {
  thinking: string;
  reply: string;
  operations: PrimitiveOp[];
}

/** What the loop shows the model. The transcript IS the memory — nothing is stored between turns. */
export type TranscriptEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; turn: AgentTurn }
  | { role: "tool"; name: string; result: unknown };

/**
 * The model, as a function. The real adapter formats the transcript for a provider and parses the
 * reply; the tests hand over a scripted one. Either way the loop never knows which it has.
 */
export type ModelFn = (transcript: TranscriptEntry[], step: number) => Promise<AgentTurn>;

export interface AgentRunResult {
  reply: string;
  plan: WeekPlan;
  profile: UserProfile;
  planChanged: boolean;
  profileChanged: boolean;
  previous?: PlanSnapshot;
  /** Every entry, for logging and for building training data out of real turns. */
  transcript: TranscriptEntry[];
  steps: number;
  /** True when MAX_STEPS stopped it rather than the model deciding it was done. */
  gaveUp: boolean;
  notes: string[];
}

const isRead = (o: PrimitiveOp): boolean => isReadTool(String((o as { op?: string }).op ?? ""));

function labelOps(ops: PrimitiveOp[]): string {
  const names = ops.map((o) => (o as { op?: string }).op).filter(Boolean);
  return names.length ? `your last change (${names.join(", ")})` : "your last change";
}

/**
 * Run one user message to completion.
 *
 * `previous` is threaded through so `undo` works, and the snapshot is taken ONCE — before the first
 * write of this run, not per step. Per step, "undo" would walk back one loop iteration rather than
 * one thing the person asked for, which is not what anybody means by undo.
 */
export async function runAgent(args: {
  profile: UserProfile;
  plan: WeekPlan;
  message: string;
  history?: TranscriptEntry[];
  saved?: string[];
  today?: string;
  previous?: PlanSnapshot;
  model: ModelFn;
  maxSteps?: number;
}): Promise<AgentRunResult> {
  const maxSteps = args.maxSteps ?? MAX_STEPS;
  const transcript: TranscriptEntry[] = [
    ...(args.history ?? []),
    { role: "user", content: args.message },
  ];

  let profile = args.profile;
  let plan = args.plan;
  let planChanged = false;
  let profileChanged = false;
  let replyOverride: string | undefined;
  let undone = false;
  const notes: string[] = [];

  // Taken before the first WRITE, not here — a run that only looks things up must not consume the
  // undo slot, or "undo" after a question would throw away the change before it.
  let snapshot: PlanSnapshot | undefined;

  let steps = 0;
  let lastReply = "";
  let gaveUp = false;
  let modelFailed = false;

  while (steps < maxSteps) {
    steps++;

    let turn: AgentTurn;
    try {
      turn = await args.model(transcript, steps);
    } catch {
      // The model itself failed. Stop honestly rather than pretending a turn happened.
      modelFailed = true;
      break;
    }

    // A model that emits nothing usable is treated as a plain reply rather than an error: the
    // person still gets an answer, and the loop ends instead of spinning on malformed output.
    const ops = Array.isArray(turn?.operations) ? turn.operations : [];
    transcript.push({ role: "assistant", turn: { ...turn, operations: ops } });
    lastReply = typeof turn?.reply === "string" ? turn.reply : "";

    if (ops.length === 0) break; // the model says it is done

    const reads = ops.filter(isRead);
    const writes = ops.filter((o) => !isRead(o));

    // 1) Lookups. Their results go back to the MODEL and are never shown to the person.
    for (const r of reads) {
      const { op, ...rest } = r as { op?: string } & Record<string, unknown>;
      const result = runReadTool(
        { profile, plan, saved: args.saved, today: args.today } satisfies AgentContext,
        String(op),
        rest,
      );
      transcript.push({ role: "tool", name: String(op), result });
    }

    // 2) Writes, through the engine, exactly as before. It stays the only thing that may claim a
    //    change, and its notes are fed BACK so the model can see what it actually did — including
    //    a refusal or a relaxed constraint it should now respond to.
    if (writes.length) {
      if (!snapshot) snapshot = { plan, profile, label: labelOps(writes) };
      const res = applyPrimitives(profile, plan, writes, args.today, args.previous);
      plan = res.plan;
      profile = res.profile;
      planChanged = planChanged || res.planChanged;
      profileChanged = profileChanged || res.profileChanged;
      undone = undone || Boolean(res.undone);
      if (res.replyOverride) replyOverride = res.replyOverride;
      notes.push(...res.notes);
      transcript.push({
        role: "tool",
        name: "apply",
        result: {
          notes: res.notes,
          planChanged: res.planChanged,
          profileChanged: res.profileChanged,
        },
      });
    }

    if (steps >= maxSteps) gaveUp = true;
  }

  if (modelFailed) {
    notes.push("I couldn't reach the assistant to finish that.");
  } else if (gaveUp) {
    // Say so. Handing back a half-finished change without mentioning it is the silent-failure mode
    // this project keeps writing rules against.
    notes.push(
      `I worked through ${maxSteps} steps without finishing that — here's where I got to. Tell me if you want me to keep going.`,
    );
  }

  return {
    reply: composeReply({ modelReply: lastReply, notes, replyOverride, planChanged }),
    plan,
    profile,
    planChanged,
    profileChanged,
    // One level of undo: after an undo there is nothing further back.
    previous: undone ? undefined : (snapshot ?? args.previous),
    transcript,
    steps,
    gaveUp,
    notes,
  };
}
