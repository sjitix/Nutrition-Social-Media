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
import { applyPrimitives, earlierAllergyFacts, expandConstrain, type EarlierMessage, noOpConstrain, sameAllergies, verbToOperations, withoutUnchangedClaims, type ConstrainOp, type PrimitiveOp, type VerbOp } from "./primitives";
import { claimsChange, composeReply, joinPhrases, NOTED_NOTHING_CHANGED_REPLY, NOTHING_CHANGED_REPLY, operationPhrases, withoutEmoji } from "./reply";
import { modelFailureOf, type ModelFailure, type ModelFailureKind } from "./modelFailure";
import { CRISIS_REPLY } from "../nutrition";
import { withSeed } from "../plan";
import { settleByPhase, changedDays, targetsChanged, type RunNote, type PhaseChange } from "./runNotes";
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
  /** Why it failed, when it did: the provider's kind (assistant/modelFailure.ts), never its message. */
  modelFailure?: { kind: ModelFailureKind; retryAfterS?: number };
  /** The engine, or the loop's own answer, had something to say before any failure line: notes, or an
   *  urgent reply. A failed run that has it is not "offline": the route returns what it said (MF-1). */
  engineSpoke: boolean;
  notes: string[];
  /** The model claimed a change with nothing applied, and was given one more step to fix it. */
  falseClaimRetried: boolean;
  /** …and still claimed it, so the reply was replaced with an honest one (reply.ts NOTHING_CHANGED_REPLY). */
  falseClaimCaught: boolean;
  /** The finishing call was not made: the loop answered it itself (see `fastFinishable`). */
  fastFinished: boolean;
  /** A turn the model sent could not be read, and it was given one more step (`unreadableNudge`). */
  unreadableRetried: boolean;
}

const isRead = (o: PrimitiveOp): boolean => isReadTool(String((o as { op?: string }).op ?? ""));

/**
 * What the model is told when its turn could not be read: why, and what of it was kept. Like the
 * false-claim nudge it goes in the transcript, never to the person, and the model gets ONE more step.
 * Ending the run there used to lose the whole turn and tell the person the assistant was offline, though
 * the model had answered (F5's mapping, MF-2, MF-3).
 */
export function unreadableNudge(issues: string | undefined, kept: PrimitiveOp[]): string {
  const facts = kept.filter(isRemember).length;
  const saved = facts === 0 ? "" : facts === 1 ? ", except the fact to remember, which was saved" : `, except the ${facts} facts to remember, which were saved`;
  const answered = kept.some((o) => opName(o) === "symptom") ? " The symptom you passed on was answered." : "";
  return `Your last turn could not be read${issues ? ` (${issues})` : ""}, so none of its changes ran${saved}.${answered} Send them again as one JSON object in the right shape. If the user told you something to remember, such as an allergy, and it is not saved above, send that remember again. Or tell the user plainly what you could not do.`;
}

const REMEMBER_KINDS = new Set(["preference", "allergy", "condition", "goal", "context"]);
/** A remember's fact as text, however the model wrote it: a string, a list of strings, or an object of them. */
const factText = (f: unknown): string =>
  typeof f === "string" ? f.trim()
  : Array.isArray(f) ? f.filter((x): x is string => typeof x === "string").join(", ").trim()
  : f && typeof f === "object" ? Object.values(f).filter((x): x is string => typeof x === "string").join(", ").trim()
  : "";

/**
 * What a turn that could not be read still says, each op read on its own and leniently: its remembers and its
 * symptoms. A stated allergy must never be lost with the rest of its turn (I2), and a symptom carries the
 * urgent or crisis reply, which the person must read whatever the model does next (review of F5a,
 * 2026-10-22). A remember keeps its fact even when its label is unreadable ("Allergy", null, "allergen"): the
 * engine binds an allergy from the fact's own words. Nothing else is kept, because any other op of a refused
 * turn could be half of something ([undo, an unreadable swap] would undo alone).
 */
function keptFromUnreadable(raw: unknown): PrimitiveOp[] {
  const listed = (raw as { operations?: unknown } | null | undefined)?.operations;
  const ops = Array.isArray(listed) ? listed : listed && typeof listed === "object" ? [listed] : [];
  return ops.flatMap((o): PrimitiveOp[] => {
    const rec = (o ?? {}) as Record<string, unknown>;
    if (rec.op === "symptom") {
      return typeof rec.text === "string" && rec.text.trim() ? [{ op: "symptom", text: rec.text } as PrimitiveOp] : [];
    }
    if (rec.op !== "remember") return [];
    const fact = factText(rec.fact);
    if (!fact) return [];
    const label = typeof rec.kind === "string" ? rec.kind.trim().toLowerCase().replace(/^allerg(?:en|ens|ies|ic)$/, "allergy") : "";
    const kind = REMEMBER_KINDS.has(label) ? label
      // {fact: {allergy: "peanuts"}}: the key says what the value is.
      : rec.fact && typeof rec.fact === "object" && !Array.isArray(rec.fact) && Object.keys(rec.fact).some((k) => /allerg|intoleran/i.test(k)) ? "allergy"
      : undefined;
    return [{ op: "remember", fact, ...(kind ? { kind } : {}) } as PrimitiveOp];
  });
}

/**
 * FAST FINISH: the model call that only "finishes" is skipped. After a write the loop calls the model
 * once more so it can say it is done, but when the engine wrote notes, `composeReply` returns those notes
 * and discards whatever that call says. On "make Tuesday vegetarian" it cost a full model call for
 * nothing the person reads. Skipped when the step that just ran changed something and the engine wrote
 * notes, its turn made no lookups, and that turn carried a reply of its own. A refusal (nothing changed),
 * a lookup, a nudge and an empty reply still go back to the model.
 *
 * This is the rule the models lane measured with its eval wrapper (`scripts/models/fast-finish.ts`, mode
 * "reply"), moved into the loop unchanged and answered the same way: a turn with no operations and no
 * reply, so every rule after it runs exactly as it did when measured.
 *
 * What makes it safe is the MODEL, not the reply rule. The skip also cuts any write the model would have
 * sent next: a scripted run that adds a snack in one step and remembers a peanut allergy in the next
 * keeps the peanut dishes. Nemotron-3-Ultra 550B with reasoning off finishes in one write turn: of the 24
 * messages the skip ended early in its fair run (`cd2244b`), the same messages in the run without it sent
 * nothing more after the write (0 of 23; one failed at its first step), and across every recorded 550B run
 * with the skip off, 0 of 275 write messages sent anything new after a write (3 at most, if the ambiguous
 * ones count). The reply rule, meant to spare a model planning across steps, withheld 1 skip in 84, because
 * the 550B writes a reply beside nearly every write. gpt-oss-20b did send more after a write, in 7 of
 * 49 messages. So the route turns it on only where it was measured (AI_FAST_FINISH).
 */
function fastFinishable(t: TranscriptEntry[]): boolean {
  const last = t[t.length - 1];
  if (!last || last.role !== "tool" || last.name !== "apply") return false;
  const r = last.result as { notes?: string[]; planChanged?: boolean; profileChanged?: boolean };
  if (!(r.planChanged || r.profileChanged) || !r.notes?.length) return false;
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.role !== "assistant") continue;
    // Read the way the loop reads it: a reply that is not text is no reply (and must not throw here, outside
    // the model call's try, where the wrapper's own TypeError used to count as a model failure).
    const said = e.turn.reply;
    return !e.turn.operations.some(isRead) && typeof said === "string" && said.trim() !== "";
  }
  return false;
}
/** What the loop answers a skipped finishing call with: done, nothing to add. A new one each time, so no
 *  two transcripts share its operations array. */
const finishTurn = (): AgentTurn => ({ thinking: "(fast finish: no model call; the engine's notes are the reply)", reply: "", operations: [] });
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
 * The writes of a step that changed something, for the undo label. A step is applied as a whole, so a refused write
 * beside a real one was named as if it had happened: [swap Monday (no such dish), swap Tuesday] was labelled
 * "swapped Monday's dinner and swapped Tuesday's dinner" (the second review's #4, reproduced 2026-10-27). In a step of
 * several writes each is also tried alone from the same state, and only those that change something are named. The
 * trials draw from a seed of their own, so the run's own random choices are exactly what they were. If none changes
 * anything alone (the change came from writes together), the whole step is named, as before.
 */
function changers(group: PrimitiveOp[], before: { plan: WeekPlan; profile: UserProfile }, target: PlanSnapshot | undefined, today?: string): PrimitiveOp[] {
  const isRem = (o: PrimitiveOp) => (o as { op?: string }).op === "remember";
  const tried = group.filter((o) => !isRem(o));
  if (tried.length < 2) return group;
  const alone = tried.filter((o) => {
    const r = withSeed(1, () => applyPrimitives(before.profile, before.plan, [o], today, target));
    return r.planChanged || !same(before.profile, r.profile);
  });
  return alone.length ? [...group.filter(isRem), ...alone] : group;
}

/** The line a run that lost its model ends with, and the words of the one a run at the step cap ends with. A turn whose
 *  reply holds either did not finish, so the history allergy reads its message as unanswered. */
const MODEL_FAILED_LINE = "I couldn't reach the assistant to finish that.";
const GAVE_UP_LINE = "without finishing that";

/** What the history allergy's first note opens with, so the person knows why an allergy arrived now. */
export const EARLIER_LEAD = "Going by what you said earlier, ";

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
  /** Skip the finishing call when the engine's notes are the reply (`fastFinishable`). Off unless asked:
   *  the route asks only for a model it was measured on, and an eval gets it only by asking (or through
   *  the models lane's wrapper; not both, or the wrapper's counts are wrong). */
  fastFinish?: boolean;
}): Promise<AgentRunResult> {
  const maxSteps = args.maxSteps ?? MAX_STEPS;
  const transcript: TranscriptEntry[] = [
    ...(args.history ?? []),
    { role: "user", content: args.message },
  ];

  // THE HISTORY ALLERGY (I2): an allergy stated in an EARLIER message that never bound (its turn's model failed,
  // or never sent the remember) binds now, before the first model call, through the same gate the live path
  // uses (primitives.ts, earlierAllergyFacts). It is the run's starting state, not one of its changes: it takes
  // no undo slot, an undo never takes it back, nor any allergy the conversation states that is already bound
  // (both join `remembered`, and are folded into the `previous` this run returns), and every claim check below is
  // judged against the state after it. Its note is said first. A message whose turn ended in the failure line, or
  // stopped at the step cap, counts as unanswered, as one with no reply at all does (the chat sends none for a
  // turn that failed outright).
  const history = args.history ?? [];
  const earlier = earlierAllergyFacts(
    history.flatMap((e, i): EarlierMessage[] => {
      if (e.role !== "user") return [];
      const next = history[i + 1];
      const reply = next?.role === "assistant" && typeof next.turn.reply === "string" ? next.turn.reply : null;
      return [{ text: e.content, reply: reply === null || reply.includes(MODEL_FAILED_LINE) || reply.includes(GAVE_UP_LINE) ? null : reply }];
    }),
    args.message,
    args.profile,
  );
  const asRemember = (fact: string) => ({ op: "remember", fact }) as PrimitiveOp;
  const earlierOps = earlier.bind.map(asRemember);
  const statedOps = [...earlierOps, ...earlier.held.map(asRemember)];
  const start = { profile: args.profile, plan: args.plan };
  // Its notes are phase 0 of the run's, settled with them against the final week: a later step that changed the week
  // made "Your week now averages …" from the binding false, and it was shown as true (open since 97e0cec).
  const earlierEntries: RunNote[] = [];
  if (earlierOps.length) {
    const res = applyPrimitives(args.profile, args.plan, earlierOps, args.today);
    start.profile = res.profile;
    start.plan = res.plan;
    earlierEntries.push(...(res.noteSources ?? res.notes).map((source) => ({ source, phase: 0 })));
  }

  let profile = start.profile;
  let plan = start.plan;
  let planChanged = false;
  let replyOverride: string | undefined;
  let undone = false;
  // Every note, tagged with the engine call ("phase") that wrote it, and what each call changed: at the end they
  // are settled against the FINAL week (runNotes.ts), so a figure or an allergy promise a later step made untrue
  // is not shown as true (#14).
  const entries: RunNote[] = [];
  const changes: PhaseChange[] = [];
  let phase = 0;

  // Taken by the first step that CHANGES something, not before: a run that only looks things up, answers,
  // explains, or has a change refused must not consume the undo slot, or "undo" after a question would
  // restore the state it was already in and throw away the change before it (models lane audit,
  // 2026-10-20: an explain after a change took the slot).
  let snapshot: PlanSnapshot | undefined;
  // The writes of every step that changed something, so the snapshot's label names all of what an undo
  // reverses, not only the first step's. Only the wording grows: what is restored is still the state
  // before the first. A refused write that shares a step with a real change is not named (changers, below).
  const written: PrimitiveOp[] = [];
  // Every remember this run applied: an undo in the same run must not take them back (G, run level).
  const remembered: PrimitiveOp[] = [...statedOps];

  const withEarlier = (prev: PlanSnapshot | undefined): PlanSnapshot | undefined => {
    if (!prev || !statedOps.length) return prev;
    const kept = applyPrimitives(prev.profile, prev.plan, statedOps, args.today);
    return { ...prev, plan: kept.plan, profile: kept.profile };
  };

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
  let fastFinished = false;
  let unreadableRetried = false;
  let modelFailure: ModelFailure | undefined;
  // Set by an unreadable turn; said to the model once the step's kept remembers have run.
  let nudge: string | undefined;
  // An unreadable turn past the one retry: what it kept runs as the step, and then the run ends as this failure.
  let endAfterStep: ModelFailure | undefined;
  // The retried failure, when nothing at all could be read from it: if the retry then brings nothing the engine
  // can vouch for, the run is still that failure, not the model's unverified words ("noted" over an allergy
  // that was never saved; review of F5a, 2026-10-22).
  let blindRetry: ModelFailure | undefined;
  // What can back a claim the model makes in its own words: a plan change, the engine's notes, a crisis
  // override, or a real edit to the profile. A memory saved cannot — see FALSE_CLAIM_NUDGE_MEMORY.
  const profileEdited = () => editedApartFromMemory(start.profile, profile);
  const memorySaved = () => !same(start.profile.memory ?? [], profile.memory ?? []);

  while (steps < maxSteps) {
    steps++;

    let turn: AgentTurn;
    if (args.fastFinish && fastFinishable(transcript)) {
      turn = finishTurn();
      fastFinished = true;
    } else {
      try {
        turn = await args.model(transcript, steps, { profile, plan });
      } catch (e) {
        const failure = modelFailureOf(e);
        // The model answered, but not as a turn the loop can use. One malformed op used to throw the whole
        // turn away, a stated allergy with it, and the person read "offline" (F5's mapping, MF-2). What it asked
        // to remember, and any symptom it passed on, run whatever happens next. The model gets ONE more step,
        // told why; past that, or on the cap step, the run ends as the failure it is.
        const kept = failure.kind === "unreadable" ? keptFromUnreadable(failure.detail.raw) : [];
        if (failure.kind === "unreadable" && !unreadableRetried && steps < maxSteps) {
          unreadableRetried = true;
          if (failure.detail.raw === undefined) blindRetry = failure;
          nudge = unreadableNudge(failure.detail.issues, kept);
        } else if (kept.length) {
          endAfterStep = failure;
        } else {
          // The model itself failed. Stop honestly rather than pretending a turn happened.
          modelFailure = failure;
          modelFailed = true;
          break;
        }
        turn = { thinking: "(the model's turn could not be read; only what it asked to remember, and any symptom, were kept)", reply: "", operations: kept };
      }
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
      // Nothing of an unreadable turn could be kept: the model is told why, and tries once more.
      if (nudge) {
        transcript.push({ role: "tool", name: "apply", result: { notes: [nudge], planChanged: false, profileChanged: false } });
        nudge = undefined;
        continue;
      }
      if (lastReply.trim()) spoken = lastReply;
      // The model says it is done. If its reply is the only thing the user will read (the engine is
      // silent) and it claims a change that nothing made, give it one step to make it real or retract.
      const unbacked = !planChanged && !profileEdited() && entries.length === 0 && replyOverride === undefined;
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
    // A crisis runs alone, before anything, an undo included: nothing else of its turn is applied, and its reply
    // ends the run (applyPrimitives; the CRISIS_REPLY break below).
    const crisisOp = writes.find((o) => opName(o) === "crisis");
    const groups = crisisOp ? [[crisisOp]]
      : undos.length && undos.length < writes.length ? [[undos[0]], writes.filter((o) => !isUndo(o))] : [writes];
    for (const group of groups) {
      if (!group.length) continue;
      // The one level of undo is spent: say so, rather than pass a second undo to the engine.
      if (group.every(isUndo) && undoneArgs && !snapshot) {
        entries.push({ source: NO_FURTHER_UNDO, phase });
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
        entries.push({ source: NOTHING_EARLIER_TO_UNDO, phase });
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
        else for (const [from, to] of [...stale].reverse()) entries.splice(from, to - from);
        stale = [];
        snapshot = undefined;
        written.length = 0;
      } else if (stepChanged) {
        written.push(...changers(group, before, target, args.today));
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
      // A crisis outranks an urgent reply, whichever step said it first.
      if (res.replyOverride && replyOverride !== CRISIS_REPLY) replyOverride = res.replyOverride;
      phase++;
      changes.push({ phase, days: changedDays(before.plan, res.plan), targets: targetsChanged(before.profile, res.profile) });
      const from = entries.length;
      entries.push(...(res.noteSources ?? res.notes).map((source) => ({ source, phase })));
      if (snapshot && !res.undone && (stepChanged || group.some((o) => PLAN_DESCRIBING.has(opName(o))))) stale.push([from, entries.length]);
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

    // The remembers of an unreadable turn have run: now the model is told why the rest did not.
    if (nudge) {
      transcript.push({ role: "tool", name: "apply", result: { notes: [nudge], planChanged: false, profileChanged: false } });
      nudge = undefined;
    }
    // A crisis reply is the whole answer and nothing outranks it, so the run ends with it, as the pre-scan's does.
    // An urgent reply does not end it: a later step can still bind an allergy, or raise it to a crisis. A later
    // failure no longer replaces it either, because the route returns any run the engine spoke in
    // (`engineSpoke`; F5's mapping, MF-1; review of F5a, 2026-10-22).
    if (replyOverride === CRISIS_REPLY) break;
    // Past its one retry, an unreadable turn's kept ops have run, and the run ends as the failure it is.
    if (endAfterStep) {
      modelFailure = endAfterStep;
      modelFailed = true;
      break;
    }
    if (steps >= maxSteps) gaveUp = true;
  }

  // A retry after a turn nothing could be read from, which brought nothing the engine vouches for: still that
  // failure. The model's words alone ("Noted.") would stand over an allergy that was never saved.
  if (blindRetry && !modelFailed && entries.length === 0 && replyOverride === undefined && !planChanged && same(start.profile, profile)) {
    modelFailure = blindRetry;
    modelFailed = true;
  }

  // Said before any failure line is added: whether the run has an answer of its own to give.
  const engineSpoke = earlierEntries.length > 0 || entries.length > 0 || replyOverride !== undefined;
  // What the person reads: every note, rendered and judged against the week the run ENDS with. The history
  // allergy's are kept apart, to be said first; a stale figure of theirs is re-stated among the run's own.
  const settled = settleByPhase([...earlierEntries, ...entries], changes, { plan, profile });
  const earlierNotes = settled.filter((n) => n.phase === 0).map((n, i) => (i === 0 ? EARLIER_LEAD + n.text : n.text));
  const notes = settled.filter((n) => n.phase !== 0).map((n) => n.text);
  if (modelFailed) {
    notes.push(MODEL_FAILED_LINE);
  } else if (gaveUp) {
    // Say so. Handing back a half-finished change without mentioning it is the silent-failure mode
    // this project keeps writing rules against.
    notes.push(
      `I worked through ${maxSteps} steps ${GAVE_UP_LINE} — here's where I got to. Tell me if you want me to keep going.`,
    );
  }

  // An empty finishing turn does not erase what the model already said beside a change or an answer.
  const said = lastReply.trim() ? lastReply : spoken;
  // What the run did, compared with where it started: a change and its undo in the same run cancel out,
  // and "Plan updated." under a week that did not change would be false (review, 2026-10-21). The
  // flags OR-ed step by step stay for the decisions inside the run.
  const planDiffers = !samePlan(start.plan, plan);
  // "Your allergies haven't changed" is true of one step at most: the run runs an undo as a step of its own,
  // so a denial's step could not see that the undo's step took an allergy off (review, 2026-10-21).
  if (!sameAllergies(args.profile.allergies, profile.allergies)) notes.splice(0, notes.length, ...withoutUnchangedClaims(notes));
  // profileChanged here is "changed in a way a claim could be about": a saved memory is not (above).
  const body = composeReply({ modelReply: said, notes, replyOverride, planChanged: planDiffers, profileChanged: profileEdited(), memorySaved: memorySaved() });
  // The history allergy's note goes first, unless an urgent or crisis reply is the whole answer. When the rest of
  // the run has nothing of its own to say (an empty finishing turn, or a claim caught as unbacked, which the
  // allergy just bound would make false), the note is the reply.
  const bodyEmpty = (!said.trim() && notes.length === 0 && !planDiffers) || body === NOTHING_CHANGED_REPLY || body === NOTED_NOTHING_CHANGED_REPLY;
  const reply = replyOverride !== undefined || !earlierNotes.length ? body
    : bodyEmpty ? earlierNotes.join(" ")
    : `${earlierNotes.join(" ")} ${body}`;
  return {
    reply,
    plan,
    profile,
    planChanged: !samePlan(args.plan, plan),
    profileChanged: !same(args.profile, profile),
    // One level of undo: after an undo there is nothing further back. The previous turn's state, when that is
    // where an undo goes, carries the history allergy too, so the next "undo" cannot take it off.
    previous: snapshot ?? (undoneArgs ? undefined : withEarlier(args.previous)),
    transcript,
    steps,
    gaveUp,
    modelFailed,
    modelFailure: modelFailure
      ? { kind: modelFailure.kind, ...(modelFailure.detail.retryAfterS !== undefined ? { retryAfterS: modelFailure.detail.retryAfterS } : {}) }
      : undefined,
    engineSpoke,
    notes: [...earlierNotes, ...notes],
    falseClaimRetried,
    // Compared with the words as the person would read them: an emoji taken out is not a claim caught.
    falseClaimCaught: body !== withoutEmoji(said) && notes.length === 0 && replyOverride === undefined && claimsChange(said),
    fastFinished,
    unreadableRetried,
  };
}
