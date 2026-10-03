import { NextResponse } from "next/server";
import { applyOperations, previewOperations } from "@/lib/recipeDb";
import { describeOperations } from "@/lib/assistant";
import type { Operation, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/core";

export const maxDuration = 60;

/**
 * Run ONE deterministic operation, with no language model in the loop.
 *
 * A button press already carries its intent — routing "I liked this meal" or "put it back" through
 * an LLM to recover a `rate_meal` / `undo` it could have stated directly is slower, costs a model
 * call, and can be wrong. So the UI's direct actions (rate, pin, resize, undo) come here instead of
 * /api/assistant. It also means these features keep working when the model is offline.
 *
 * Only deterministic, self-describing tools are allowed. Anything that needs the model to INTERPRET
 * a sentence (which dish did they mean, what did "make it lighter" imply) still goes through the
 * assistant. This endpoint never guesses.
 */
const ALLOWED: ReadonlySet<Operation["tool"]> = new Set([
  "rate_meal",
  "lock_meal",
  "unlock_meal",
  "scale_portions",
  // Deterministic: rescales a day's other meals' portions to the targets, holding fixed anything
  // without a base recipe. Button-driven ("balance my day around this import") — no interpretation.
  "rebalance_day",
  "undo",
  // Read-only and deterministic: the engine computes the week's averages and nutrient gaps. Lets
  // the Home "coach" card show it without a model call — it's just facts about the current plan.
  "weekly_report",
  // Read-only: fluid target from body weight. Shown on Home when we know the weight.
  "hydration",

  // ---------------------------------------------------------------------------------------------
  // Added for the direct-manipulation layer (docs/v1/05-direct-manipulation.md, decision E2).
  //
  // The test for admission here has always been the one stated above: does the tool need a MODEL to
  // interpret a sentence? These six do when the input is prose — "make lunch lighter" has to be
  // resolved into a dish, a slot and a direction. They do NOT when a control supplies those
  // parameters directly: a dish chosen from a list of six is not an interpretation of anything, it
  // is the user pointing at the thing they want. The UI hands over exactly what the model would
  // otherwise have had to guess, so the guess — and the only reason to spend a model call — is gone.
  //
  // Each one is still fully guarded by the engine: a swap to a dish that breaks a diet or carries an
  // allergen is refused there, not here, and the refusal comes back as a note the UI must show.
  // ---------------------------------------------------------------------------------------------

  // The user picked the dish from a list the engine itself produced. `dish` is an exact name.
  "swap_meal",
  // A "regenerate this day" button. Any per-day diet/cuisine/cook-time cap comes from a control,
  // not from reading a sentence.
  "regenerate_day",
  // "I ate something else" — the dish comes from a search over the library, or the user typed the
  // calories themselves. The engine re-solves the REST of that day.
  "log_meal",
  // "I'm out for dinner on Friday" as a slot the user tapped. The engine reserves the calories and
  // lightens the rest of the day, and says when it estimated.
  "eating_out",
  // "I've run out of greek yogurt", with the ingredient picked from the recipe's own list. Read-only:
  // it returns safe swaps and the macro cost, and changes nothing.
  "substitute_ingredient",
  // Read-only: why this dish is in this slot. A button on the meal sheet.
  "explain_meal",
]);

interface OperationRequest {
  profile: UserProfile;
  plan: WeekPlan;
  operation?: Operation;
  /**
   * Several operations applied as ONE change, for a move: dragging Monday's lunch onto Tuesday's is
   * two swaps that must stand or fall together. `applyOperations` already takes a list and the undo
   * snapshot is per call, so a pair is one undo rather than two — which is what the user did.
   */
  operations?: Operation[];
  previous?: PlanSnapshot;
  /**
   * Simulate instead of committing: the engine runs the operation against a clone and reports what
   * it WOULD do — new day totals, the deltas, which dishes move, and anything it would refuse or
   * relax. Nothing is persisted and the caller's plan is untouched.
   *
   * This is what lets a control show the consequence of a change before the user accepts it, which
   * is the whole of "tell me how my day changed and let me choose". The UI then commits the SAME
   * operation with `preview` absent.
   */
  preview?: boolean;
}

export async function POST(request: Request) {
  let body: OperationRequest;
  try {
    body = (await request.json()) as OperationRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const ops: Operation[] = Array.isArray(body?.operations)
    ? body.operations
    : body?.operation
      ? [body.operation]
      : [];

  if (!body?.profile || !body?.plan || ops.length === 0 || ops.some((o) => !o?.tool)) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  // Every operation in the list is checked: one allowed tool must not smuggle in a disallowed one.
  const offender = ops.find((o) => !ALLOWED.has(o.tool));
  if (offender) {
    // Anything that needs interpretation belongs to the assistant, not here.
    return NextResponse.json({ error: `"${offender.tool}" isn't a direct action.` }, { status: 400 });
  }

  // Simulate and return. Deliberately before the executor call: a preview must have no path that
  // can commit, rather than a flag checked on the way out.
  if (body.preview) {
    const sim = previewOperations(body.profile, body.plan, ops);
    return NextResponse.json({ preview: true, ...sim });
  }

  const { plan, profile, notes, planChanged, profileChanged, undone } = applyOperations(
    body.profile,
    body.plan,
    ops,
    body.previous,
  );

  // Same one-step-undo bookkeeping as the assistant route: a change stores a snapshot, an undo
  // spends it, a no-op leaves the existing snapshot alone.
  const previous: PlanSnapshot | undefined = undone
    ? undefined
    : planChanged || profileChanged
      ? { plan: body.plan, profile: body.profile, label: describeOperations(ops) }
      : body.previous;

  return NextResponse.json({
    reply: notes.join(" "),
    plan,
    profile,
    planChanged,
    previous,
  });
}
