import { NextResponse } from "next/server";
import { applyOperations } from "@/lib/recipeDb";
import { describeOperations } from "@/lib/reply";
import type { Operation, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/types";

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
  "undo",
]);

interface OperationRequest {
  profile: UserProfile;
  plan: WeekPlan;
  operation: Operation;
  previous?: PlanSnapshot;
}

export async function POST(request: Request) {
  let body: OperationRequest;
  try {
    body = (await request.json()) as OperationRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body?.profile || !body?.plan || !body?.operation?.tool) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  if (!ALLOWED.has(body.operation.tool)) {
    // Anything that needs interpretation belongs to the assistant, not here.
    return NextResponse.json({ error: `"${body.operation.tool}" isn't a direct action.` }, { status: 400 });
  }

  const { plan, profile, notes, planChanged, profileChanged, undone } = applyOperations(
    body.profile,
    body.plan,
    [body.operation],
    body.previous,
  );

  // Same one-step-undo bookkeeping as the assistant route: a change stores a snapshot, an undo
  // spends it, a no-op leaves the existing snapshot alone.
  const previous: PlanSnapshot | undefined = undone
    ? undefined
    : planChanged || profileChanged
      ? { plan: body.plan, profile: body.profile, label: describeOperations([body.operation]) }
      : body.previous;

  return NextResponse.json({
    reply: notes.join(" "),
    plan,
    profile,
    planChanged,
    previous,
  });
}
