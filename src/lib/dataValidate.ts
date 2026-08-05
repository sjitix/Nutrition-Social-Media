/**
 * Generate-then-VALIDATE. The clever half of the data pipeline: every training example is checked by
 * actually running its operations through the real engine and confirming they do what the reply
 * claims. This auto-deletes hallucinated / malformed / no-op-but-claims-a-change examples, so the
 * training set is behaviorally CORRECT, not merely plausible. Realistic phrasing gets us variety;
 * this gets us truth.
 */
import type { UserProfile, WeekPlan } from "./types";
import { AssistantTurnV2Schema, applyPrimitives, type PrimitiveOp } from "./primitives";

export interface TrainingExample {
  /** Optional starting state; defaults are used when omitted. */
  profile?: UserProfile;
  plan?: WeekPlan;
  /** The conversation so far; the final user message is what this turn responds to. */
  turns: { role: "user" | "assistant"; text: string }[];
  thinking: string;
  reply: string;
  operations: unknown[];
  /** Optional declarative expectations about the EXECUTED result — the strongest correctness check. */
  expect?: {
    dietIs?: UserProfile["diet"];
    planChanged?: boolean;
    profileChanged?: boolean;
    remembers?: string; // a substring the memory must contain
    noChange?: boolean; // clarify / decline / refuse: nothing should move
  };
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

// Ops that never change the plan or profile (pure questions / advice). Everything else must move
// something when present.
const READ_ONLY = new Set(["report", "explain", "substitute", "symptom", "hydration", "answer"]);

/** Validate one example against the real engine. Pure — pass the default starting state in. */
export function validateExample(
  ex: TrainingExample,
  defaults: { profile: UserProfile; plan: WeekPlan },
): ValidationResult {
  if (!ex.turns.length || ex.turns[ex.turns.length - 1].role !== "user") {
    return { ok: false, reason: "the last turn must be the user's message" };
  }
  if (!ex.reply.trim()) return { ok: false, reason: "empty reply" };

  // 1. Schema-valid structured output.
  const parsed = AssistantTurnV2Schema.safeParse({ thinking: ex.thinking, reply: ex.reply, operations: ex.operations });
  if (!parsed.success) return { ok: false, reason: "schema: " + (parsed.error.issues[0]?.message ?? "invalid") };

  // 2. It actually runs through the engine without throwing.
  let res: ReturnType<typeof applyPrimitives>;
  try {
    res = applyPrimitives(ex.profile ?? defaults.profile, ex.plan ?? defaults.plan, parsed.data.operations as PrimitiveOp[]);
  } catch (e) {
    return { ok: false, reason: "engine threw: " + (e as Error).message };
  }

  // 3. A turn with change-ops must actually change something (no silent no-ops claiming success).
  const changeOps = parsed.data.operations.filter((o) => !READ_ONLY.has((o as { op: string }).op));
  if (changeOps.length && !res.planChanged && !res.profileChanged) {
    return { ok: false, reason: "operations claim a change but nothing moved" };
  }

  // 4. Declarative expectations — the tightest check.
  const e = ex.expect;
  if (e) {
    if (e.noChange && (res.planChanged || res.profileChanged)) return { ok: false, reason: "expected no change, but something moved" };
    if (e.dietIs && res.profile.diet !== e.dietIs) return { ok: false, reason: `expected diet ${e.dietIs}, got ${res.profile.diet}` };
    if (e.planChanged != null && res.planChanged !== e.planChanged) return { ok: false, reason: `planChanged expected ${e.planChanged}` };
    if (e.profileChanged != null && res.profileChanged !== e.profileChanged) return { ok: false, reason: `profileChanged expected ${e.profileChanged}` };
    if (e.remembers && !(res.profile.memory ?? []).some((f) => f.fact.toLowerCase().includes(e.remembers!.toLowerCase()))) {
      return { ok: false, reason: `expected a remembered fact containing "${e.remembers}"` };
    }
  }

  return { ok: true };
}

/** Partition a batch into the examples that pass and a list of rejections with reasons. */
export function validateBatch(
  examples: TrainingExample[],
  defaults: { profile: UserProfile; plan: WeekPlan },
): { kept: TrainingExample[]; rejected: { ex: TrainingExample; reason: string }[] } {
  const kept: TrainingExample[] = [];
  const rejected: { ex: TrainingExample; reason: string }[] = [];
  for (const ex of examples) {
    const r = validateExample(ex, defaults);
    if (r.ok) kept.push(ex);
    else rejected.push({ ex, reason: r.reason ?? "unknown" });
  }
  return { kept, rejected };
}
