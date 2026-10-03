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
import { claimsChange, composeReply } from "./reply";
import type { PlanSnapshot, UserProfile, WeekPlan } from "../core";

/** A cap, not a target. Reaching it is a bug to investigate, not a normal outcome. */
export const MAX_STEPS = 8;

/**
 * What the model is told when it says something changed and nothing did. It goes in the transcript
 * as the result of the write it should have sent, never to the user, and the model gets ONE more
 * step to either send the operation or say plainly that nothing changed. Fixing the turn beats hiding
 * it: the person usually asked for something real. (Models lane's proposal, 2026-10-03.)
 */
export const FALSE_CLAIM_NUDGE =
  "Nothing was applied: no operation ran, but your reply says something changed. Send the operation now, or tell the user plainly that nothing has changed yet.";

/**
 * The same nudge when the only thing that ran was a `remember`. A saved memory backs none of the
 * claims `claimsChange` looks for — they are all about the week — so "Done — I've made your whole
 * week vegetarian" with only a remember sent was shown to the user as true (models lane, 2026-10-03).
 * Telling the model "no operation ran" would be false, so this says what did.
 */
export const FALSE_CLAIM_NUDGE_MEMORY =
  "Only a memory was saved: nothing in the plan or the settings changed, but your reply says something did. Send the operation now, or tell the user plainly what you noted and that the plan has not changed yet.";

/** Plain data, keys sorted, so two profiles compare by content: the engine rebuilds objects, and
 *  key order is not a change (the accounts lane learned the same about Postgres jsonb). */
const canon = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(canon)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])]))
  : x;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/** Did the profile change in a way a claim could be about — anything but the memory? */
const editedApartFromMemory = (a: UserProfile, b: UserProfile) => {
  const { memory: _a, ...restA } = a;
  const { memory: _b, ...restB } = b;
  return !same(restA, restB);
};

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
export type ModelFn = (
  transcript: TranscriptEntry[],
  step: number,
  /** The CURRENT plan and profile — they change under the loop, and a prompt built from the
   *  starting state would have the model reasoning about a week that no longer exists. */
  state: { profile: UserProfile; plan: WeekPlan },
) => Promise<AgentTurn>;

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
  /**
   * True when the MODEL itself could not be reached or failed, as opposed to the agent deciding it
   * was finished. The loop swallows that error on purpose — work the engine already completed in
   * earlier steps must not be thrown away — but swallowing it silently turned an unreachable
   * provider into an ordinary-looking 200 response, which is how a stopped LM Studio came back to
   * the screen as a normal turn reading "1 of 8 steps". The caller has to be able to tell the
   * difference, so it is reported rather than left to be inferred from the reply text.
   */
  modelFailed: boolean;
  notes: string[];
  /** The model claimed a change with nothing applied, and was given one more step to fix it. */
  falseClaimRetried: boolean;
  /** …and still claimed it, so the reply was replaced with an honest one (reply.ts NOTHING_CHANGED_REPLY). */
  falseClaimCaught: boolean;
  /**
   * The finishing call was skipped: the last step only wrote, the engine changed something and wrote
   * notes — which ARE the reply (composeReply) — and the model's turn carried a reply of its own, so it
   * was not mid-plan. A refusal, a lookup, or an empty reply still goes back to the model.
   */
  fastFinished: boolean;
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
  let falseClaimRetried = false;
  let fastFinished = false;
  // What can back a claim the model makes in its own words: a plan change, the engine's notes, a crisis
  // override, or a real edit to the profile. A memory saved cannot — see FALSE_CLAIM_NUDGE_MEMORY.
  const profileEdited = () => editedApartFromMemory(args.profile, profile);
  const memorySaved = () => !same(args.profile.memory ?? [], profile.memory ?? []);

  while (steps < maxSteps) {
    steps++;

    let turn: AgentTurn;
    try {
      turn = await args.model(transcript, steps, { profile, plan });
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

    if (ops.length === 0) {
      // The model says it is done. If its reply is the only thing the user will read (the engine is
      // silent) and it claims a change that nothing made, give it one step to make it real or retract.
      const unbacked = !planChanged && !profileEdited() && notes.length === 0 && replyOverride === undefined;
      if (!falseClaimRetried && unbacked && claimsChange(lastReply) && steps < maxSteps) {
        falseClaimRetried = true;
        transcript.push({ role: "tool", name: "apply",
          result: { notes: [memorySaved() ? FALSE_CLAIM_NUDGE_MEMORY : FALSE_CLAIM_NUDGE], planChanged: false, profileChanged: false } });
        continue;
      }
      break;
    }

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

      // FAST FINISH (the models lane's change 2). After a write the loop calls the model once more so
      // it can finish — but when the engine wrote notes, composeReply returns the notes and discards
      // what that call says, so on "make Tuesday vegetarian" it cost a full model call (10–20 s on the
      // 550B) for nothing the user sees. Skipped when this step ONLY wrote, the engine changed
      // something, and it wrote notes — and (v1's rule) the model's turn carried a reply of its own: a
      // model planning writes across steps leaves it empty and must not be cut short. A refusal
      // (nothing changed) and any step with a lookup still go back to the model. Measured 2026-10-03,
      // 550B, reasoning off: the reply rule withheld a skip 0 times in 26 loop and 28 conversation
      // turns, scores unchanged (23/26; 12 vs 11 of 14, run-to-run noise), calls per message 1.39 → 1.29.
      if (!reads.length && (res.planChanged || res.profileChanged) && res.notes.length > 0 && lastReply.trim()) {
        fastFinished = true;
        break;
      }
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

  // profileChanged here is "changed in a way a claim could be about": a saved memory is not (above).
  const reply = composeReply({ modelReply: lastReply, notes, replyOverride, planChanged, profileChanged: profileEdited(), memorySaved: memorySaved() });
  return {
    reply,
    plan,
    profile,
    planChanged,
    profileChanged,
    // One level of undo: after an undo there is nothing further back.
    previous: undone ? undefined : (snapshot ?? args.previous),
    transcript,
    steps,
    gaveUp,
    modelFailed,
    notes,
    falseClaimRetried,
    falseClaimCaught: reply !== lastReply.trim() && notes.length === 0 && replyOverride === undefined && claimsChange(lastReply),
    fastFinished,
  };
}
