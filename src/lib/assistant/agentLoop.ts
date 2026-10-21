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
import { applyPrimitives, expandConstrain, noOpConstrain, verbToOperations, type ConstrainOp, type PrimitiveOp, type VerbOp } from "./primitives";
import { claimsChange, composeReply, joinPhrases, operationPhrases } from "./reply";
import type { Operation, PlanSnapshot, UserProfile, WeekPlan } from "../core";

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
/** Two weeks hold the same meals, ignoring the ingredient slugs a re-solve may add (the engine's own
 *  sameContent rule in execute.ts). */
const samePlan = (a: WeekPlan, b: WeekPlan) => {
  const dropSlug = (k: string, v: unknown) => (k === "slug" ? undefined : v);
  return JSON.stringify(canon(a), dropSlug) === JSON.stringify(canon(b), dropSlug);
};
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
}

const isRead = (o: PrimitiveOp): boolean => isReadTool(String((o as { op?: string }).op ?? ""));
const opName = (o: PrimitiveOp) => String((o as { op?: string }).op ?? (o as { tool?: string }).tool ?? "");
const isUndo = (o: PrimitiveOp) => opName(o) === "undo";
const isRemember = (o: PrimitiveOp) => opName(o) === "remember";
/** A step whose words describe the week as it then stood: undone with the change it described. */
const PLAN_DESCRIBING = new Set(["report", "weekly_report", "explain", "explain_meal", "substitute", "substitute_ingredient"]);

/** A second undo in one run, once the one level there is has been used: said by the loop, because the
 *  engine's own answer ("I haven't changed anything yet") is false right after "I've put things back". */
export const NO_FURTHER_UNDO = "That's as far back as I can go: I can undo one change.";
/** An undo in a run that has only remembered something, with no earlier change to take back. */
export const NOTHING_EARLIER_TO_UNDO = "There's no earlier change for me to undo, and what you've just told me stays noted.";

/**
 * What `undo` says it reversed: "…before I noted what you told me and swapped Monday's dinner." A
 * past-tense verb phrase, built from the same phrases as the routes' labels (describeOperations). It
 * was a noun phrase, so every undo through the loop read "before I your last change (remember)" (review
 * of 49385e5, LC-12).
 */
function labelOps(ops: PrimitiveOp[]): string {
  const phrases = ops.flatMap((o): string[] => {
    const op = (o as { op?: string }).op;
    if (op === "remember") return ["noted what you told me"];
    if (op === "constrain") return noOpConstrain(o as ConstrainOp) ? [] : operationPhrases(expandConstrain(o as ConstrainOp));
    if (op) return operationPhrases(verbToOperations(o as VerbOp));
    return operationPhrases([o as Operation]); // a raw engine Operation, passed straight through
  });
  return joinPhrases([...new Set(phrases)]) || "made that change";
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
  let replyOverride: string | undefined;
  let undone = false;
  const notes: string[] = [];

  // Taken by the first step that CHANGES something, not before: a run that only looks things up, answers,
  // explains, or has a change refused must not consume the undo slot, or "undo" after a question would
  // restore the state it was already in and throw away the change before it (models lane audit,
  // 2026-10-20: an explain after a change took the slot).
  let snapshot: PlanSnapshot | undefined;
  // The writes of every step that changed something, so the snapshot's label names all of what an undo
  // reverses, not only the first step's. Only the wording grows: what is restored is still the state
  // before the first. A step is judged as a whole, so a refused write that shares a step with a real
  // change is named too (open, recorded: telling them apart means applying a step's writes one by one).
  const written: PrimitiveOp[] = [];
  // Every remember this run applied: an undo in the same run must not take them back (G, run level).
  const remembered: PrimitiveOp[] = [];

  let steps = 0;
  let lastReply = "";
  // The newest non-empty reply written beside a CHANGE or an answer (not beside a lookup, where it is
  // a preamble like "Let me check"). The user reads only the finishing turn's reply, so an answer or a
  // decline sent with {op:"answer"} or a remember, followed by an empty finishing turn, was lost: the
  // 550B's general-qa runs read "Happy to help." eleven times (models lane audit, 2026-10-20).
  let spoken = "";
  // Set when this run undid the PREVIOUS turn's change: there is one level of undo, so it is then spent.
  let undoneArgs = false;
  // The notes, since this run's snapshot, that an undo of the run's own change makes untrue: those of
  // every step that changed something or described the week as it then stood. A step that changed
  // nothing and answered something else (hydration, a symptom, a refused swap) keeps its words: an
  // in-run undo used to drop every note after the snapshot, the water answer with them (review, 2026-10-21).
  let stale: [number, number][] = [];
  let gaveUp = false;
  let modelFailed = false;
  let falseClaimRetried = false;
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
    // {op:"answer"} changes nothing and asks for nothing: the reply beside it IS the answer, so a turn
    // carrying only answers is a finishing turn. promptV2 teaches [{"op":"answer"}] for a question while
    // LOOP RULE 2 teaches [], and the loop used to run "answer" as a write and call the model again.
    const acting = ops.filter((o) => (o as { op?: string }).op !== "answer");

    if (acting.length === 0) {
      if (lastReply.trim()) spoken = lastReply;
      // The model says it is done. If its reply is the only thing the user will read (the engine is
      // silent) and it claims a change that nothing made, give it one step to make it real or retract.
      const unbacked = !planChanged && !profileEdited() && notes.length === 0 && replyOverride === undefined;
      // Judged on the text the person will actually read, which may be a line said beside a remember.
      const willShow = lastReply.trim() ? lastReply : spoken;
      if (!falseClaimRetried && unbacked && claimsChange(willShow) && steps < maxSteps) {
        falseClaimRetried = true;
        transcript.push({ role: "tool", name: "apply",
          result: { notes: [memorySaved() ? FALSE_CLAIM_NUDGE_MEMORY : FALSE_CLAIM_NUDGE], planChanged: false, profileChanged: false } });
        continue;
      }
      break;
    }

    const reads = acting.filter(isRead);
    const writes = acting.filter((o) => !isRead(o));

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
    // An undo that shares a step with other writes runs as a step of its own, first. applyPrimitives
    // already runs it first (G), but it returns one merged result marked undone, so the change made on
    // top of the undo never got a snapshot: [swap, undo] left the swap with nothing to undo it, and
    // [undo, swap Tuesday] made the next "undo" revert Tuesday AND the earlier turn (review, 2026-10-21).
    const undos = writes.filter(isUndo);
    const groups = undos.length && undos.length < writes.length ? [[undos[0]], writes.filter((o) => !isUndo(o))] : [writes];
    for (const group of groups) {
      if (!group.length) continue;
      // The one level of undo is spent: say so, rather than pass a second undo to the engine.
      if (group.every(isUndo) && undoneArgs && !snapshot) {
        notes.push(NO_FURTHER_UNDO);
        transcript.push({ role: "tool", name: "apply", result: { notes: [NO_FURTHER_UNDO], planChanged: false, profileChanged: false } });
        continue;
      }
      // G at the level of the run: an undo never takes back what this run remembered. A run that has only
      // remembered means the change BEFORE it ("I'm allergic to peanuts, and undo that swap", sent as two
      // steps), so its undo goes to the previous turn. Either way, this run's remembers are folded into the
      // state the undo restores, so the engine never takes them off (and says nothing false about them),
      // and a restored week that still serves a bound allergen is re-solved by the remember itself. Sent as
      // [remember], [undo], the allergy used to be unbound and the peanut dish left on the plate (I2;
      // review, 2026-10-21).
      const undoing = group.every(isUndo);
      const remembersOnly = undoing && written.length > 0 && written.every(isRemember);
      if (remembersOnly && (undoneArgs || !args.previous)) {
        notes.push(NOTHING_EARLIER_TO_UNDO);
        transcript.push({ role: "tool", name: "apply", result: { notes: [NOTHING_EARLIER_TO_UNDO], planChanged: false, profileChanged: false } });
        continue;
      }
      let target = remembersOnly ? args.previous : snapshot ?? (undoneArgs ? undefined : args.previous);
      if (undoing && target && remembered.length) {
        const kept = applyPrimitives(target.profile, target.plan, remembered, args.today);
        target = { ...target, plan: kept.plan, profile: kept.profile };
      }
      const before = { plan, profile };
      // An undo inside the run reverts THIS run's changes first (to the state before its first change);
      // it used to restore the previous turn's snapshot, reverting the person's earlier change as well.
      const res = applyPrimitives(profile, plan, group, args.today, target);
      // Compared, not flagged: a profile write that leaves the profile as it was (a repeated remember, a
      // weight that was already stored) is no change, and must not take the undo slot.
      const stepChanged = res.planChanged || !same(before.profile, res.profile);
      if (!undoing) remembered.push(...group.filter(isRemember));
      if (res.undone) {
        if (!snapshot || remembersOnly) undoneArgs = true;
        // Undoing this run's own change: what its steps said ("Monday now has …") is no longer true.
        else for (const [from, to] of [...stale].reverse()) notes.splice(from, to - from);
        stale = [];
        snapshot = undefined;
        written.length = 0;
      } else if (stepChanged) {
        written.push(...group);
        snapshot = { plan: snapshot?.plan ?? before.plan, profile: snapshot?.profile ?? before.profile, label: labelOps(written) };
      }
      // A line written beside writes was written BEFORE the engine ran, so it may describe a change that
      // never came ("I've made Tuesday vegetarian" over a budget constrain). Any change beyond the memory
      // clears it, so the engine's result, not the earlier line, is what an empty finishing turn shows. A
      // step of remembers alone keeps its line (a decline said beside a remember) whether or not the fact
      // was new: a restated fact changes nothing, and its line used to be lost, so the person read "Happy
      // to help." and a claim beside it was never retried (review, 2026-10-21). An empty line never
      // replaces a kept one.
      if (res.planChanged || editedApartFromMemory(before.profile, res.profile)) spoken = "";
      else if (group.every(isRemember) && !reads.length && lastReply.trim()) spoken = lastReply;
      plan = res.plan;
      profile = res.profile;
      planChanged = planChanged || res.planChanged;
      undone = undone || Boolean(res.undone);
      if (res.replyOverride) replyOverride = res.replyOverride;
      const from = notes.length;
      notes.push(...res.notes);
      if (snapshot && !res.undone && (stepChanged || group.some((o) => PLAN_DESCRIBING.has(opName(o))))) stale.push([from, notes.length]);
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

  // An empty finishing turn does not erase what the model already said beside a change or an answer.
  const said = lastReply.trim() ? lastReply : spoken;
  // What the run did, compared with where it started: a change and its undo in the same run cancel out,
  // and "Plan updated." under a week that did not change would be false (review, 2026-10-21). The
  // flags OR-ed step by step stay for the decisions inside the run.
  const planDiffers = !samePlan(args.plan, plan);
  // profileChanged here is "changed in a way a claim could be about": a saved memory is not (above).
  const reply = composeReply({ modelReply: said, notes, replyOverride, planChanged: planDiffers, profileChanged: profileEdited(), memorySaved: memorySaved() });
  return {
    reply,
    plan,
    profile,
    planChanged: planDiffers,
    profileChanged: !same(args.profile, profile),
    // One level of undo: after an undo there is nothing further back.
    previous: snapshot ?? (undoneArgs ? undefined : args.previous),
    transcript,
    steps,
    gaveUp,
    modelFailed,
    notes,
    falseClaimRetried,
    falseClaimCaught: reply !== said.trim() && notes.length === 0 && replyOverride === undefined && claimsChange(said),
  };
}
