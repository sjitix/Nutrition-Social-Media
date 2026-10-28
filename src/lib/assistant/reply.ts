import type { Operation } from "../core";

/**
 * How a turn's final reply and plan-changed flag are assembled.
 *
 * This lived inline in the API route, which meant the single most safety-critical line in the app
 * — the one that decides whether the model is allowed to speak in front of a crisis warning — had
 * no test over it. It's a pure function now, and the tests below it in test-engine.mts are the
 * reason it stays correct.
 */

/** Tools that answer a question. They must never flag the plan as changed. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "answer",
  "weekly_report",
  "explain_meal",
  "substitute_ingredient",
  "symptom_check",
  // Pinning changes the PROFILE, not this week's meals — the plan on screen is untouched.
  "lock_meal",
  "unlock_meal",
  // A rating teaches the selector what to pick NEXT time. It never rewrites the week the user is
  // looking at: nobody says "I loved the salmon" meaning "please rebuild my Thursday".
  "rate_meal",
  // Water is not food. Asking how much to drink cannot change what's for dinner.
  "hydration",
]);

export function planWasChanged(operations: Operation[]): boolean {
  return operations.some((o) => !READ_ONLY_TOOLS.has(o.tool));
}

/**
 * A short phrase for what a turn did, so `undo` can name what it reversed: "put things back to how
 * they were before I rebuilt your week." Saying only "done" leaves the user to work out what moved.
 *
 * Written from the OPERATIONS, not from the model's reply — the reply is untrusted prose, and this
 * sentence is a claim about what actually happened.
 */
// Tools that change NOTHING — a pure question or advice. Undo never has to describe these. NB this
// is a subset of READ_ONLY_TOOLS: lock/unlock/rate DON'T change the plan (so they're read-only for
// the plan) but they DO change the profile, so undo can reverse them and must name them.
const PURE_QUERY_TOOLS: ReadonlySet<string> = new Set([
  "answer", "weekly_report", "explain_meal", "substitute_ingredient", "symptom_check", "hydration",
]);

export function describeOperations(operations: Operation[]): string {
  return joinPhrases(operationPhrases(operations)) || "made that change";
}

/** "a", "a and b", "a, b and c" — or "" for nothing. */
export function joinPhrases(phrases: string[]): string {
  return phrases.length <= 1
    ? phrases[0] ?? ""
    : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * One past-tense verb phrase per operation that changes something ("swapped Monday's dinner"); pure
 * questions and undo say nothing. Every label `undo` reads is built from these (describeOperations for
 * the routes, the agent loop's labelOps), because the undo note is "…before I ${label}" and a noun
 * phrase there read "before I your last change (remember)" (review of 49385e5, LC-12).
 */
export function operationPhrases(operations: Operation[]): string[] {
  return operations
    .filter((o) => !PURE_QUERY_TOOLS.has(o.tool) && o.tool !== "undo")
    .map((o) => {
      const where = o.day && o.mealType ? `${o.day}'s ${o.mealType}` : o.day ? `${o.day}` : "";
      switch (o.tool) {
        case "regenerate_week": return "rebuilt your week";
        case "regenerate_day": return `rebuilt ${where || "that day"}`;
        case "swap_meal": return `swapped ${where || "that meal"}`;
        case "update_profile": return "changed your settings";
        case "compute_targets": return "worked out your targets";
        case "log_meal": return `logged ${where || "that meal"}`;
        case "eating_out": return `set calories aside for ${where || "eating out"}`;
        case "scale_portions": return `resized ${where || "your portions"}`;
        case "rebalance_day": return `rebalanced ${where || "that day"}`;
        case "lock_meal": return `pinned ${where || "that meal"}`;
        case "unlock_meal": return `unpinned ${where || "that meal"}`;
        case "rate_meal": return `saved your rating`;
        default: return "made that change";
      }
    });
}

/**
 * Does this reply CLAIM that something changed? ("Done — dinner is now lighter", "Wednesday now has
 * 2000 kcal", "I've swapped your breakfast".)
 *
 * Why it exists: with reasoning turned off, a fast model imitated the engine's note style from earlier
 * turns and claimed changes it never made, quoting numbers the engine never computed. No operation
 * ran, so `planChanged` was rightly false, but the text told the user the opposite (models lane,
 * 2026-10-03: 2 of 28 turns with reasoning off; earlier fine-tunes did it too, e.g. "Done — I've made
 * your breakfast egg-free" after an operation that changed nothing). The pattern is theirs, validated
 * on every stored turn: it catches 8 of 8 fabrications and trips on none of 5 honest replies. Note
 * "right now / currently averages" is a description, not a claim. ONE copy: the evals import this.
 */
// "I've removed / excluded / dropped / cut …" and "I've taken … off" joined the verbs after a review
// showed them shown as written over an allergy the engine never bound ("I've removed celery from all
// your meals", "Got it, I've taken eggs off your allergy list" while eggs stayed blocked: review of
// 49385e5, LC-06). An offer never matches: it is "I can take…", "Shall I exclude…", never "I've".
// The models lane's audit of the claims its evals meet (scripts/models/probe-claims.mts, 2026-10-20)
// added "switched", "pinned", "locked", "rated", "doubled" and "you're all set", and narrowed "made" to a
// PLAN object: "I've made your week lighter" is a claim; "I've made a quick comparison" and "I've made a
// note that…" are not, and the honest line used to replace them.
// The review of B2 (2026-10-20, on the stored model turns) then:
// - tied dropped / cut to what was taken out ("…from your plan", "…out of", "…off", "the mushroom
//   dishes"), because "I've dropped you a quick summary below" is not a change. It tied removed and
//   excluded too, and that let "Got it, I've excluded shellfish across your whole week" through over an
//   allergy nothing bound; no honest use of either was found, so both are bare again (review, 2026-10-21);
// - added the passive list's verbs to the active one, plus reworked, rebuilt, re-solved, capped and
//   tweaked: "I've scaled Saturday and Sunday down" and "I've gently reworked this week" were stored
//   claims the guard missed.
const CLAIMS_CHANGE =
  /^(done|all set)\b|\b(?:you're|you are) all set\b|(?<!\bright |\bcurrently |\bas of )\bnow (has|lands|averages|comes to)\b|\bi(?:'ve| have) (?:\w+ly )?(?:swapped|changed|updated|added|lightened|moved|set|replaced|resized|raised|increased|boosted|bumped|switched|pinned|locked|rated|doubled|halved|scaled|adjusted|reduced|lowered|trimmed|reworked|rebuilt|re-solved|capped|tweaked|removed|excluded)\b|\bi(?:'ve| have) (?:dropped|cut)\b[^.!?]{0,40}?\b(?:from|out of|off|out|dish(?:es)?|meals?|breakfasts?|lunch(?:es)?|dinners?|snacks?|plan|week|days?)\b|\bi(?:'ve| have) cut back\b|\bi(?:'ve| have) made (?:(?:your|the|this|that|these|those|every|each|all|both|it|them)\b|(?:a|some|a few|a couple of) (?:changes?|tweaks?|swaps?|adjustments?)\b|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|breakfasts?|lunch(?:es)?|dinners?|snacks?|portions?|meals?|week|plan|days?)\b)|\bi(?:'ve| have) taken (?!note\b)[^.!?]{0,40}?\boff\b/i;

/** The passive voice says it too: "Breakfast has been swapped", "Your dinners are now quicker". Same
 *  exception for a description ("currently lighter", "right now"). Models lane, 2026-10-03: with it,
 *  8/8 of their claims are caught and 0/8 of their honest replies tripped. "is now excluded": LC-06. */
const CLAIMS_CHANGE_PASSIVE =
  /\b(?:has|have) been (?:swapped|changed|updated|added|lightened|scaled|moved|replaced|resized|raised|increased|boosted|bumped|made|set|adjusted|reduced|lowered|removed|cut|trimmed)\b|(?<!\bright |\bcurrently )\b(?:is|are) now (?:lighter|quicker|faster|smaller|bigger|heavier|cheaper|vegetarian|vegan|higher|lower|meat-free|dairy-free|gluten-free|excluded)\b|\b(?:is|are) now set up for\b|\bset up for (?:two|three|four|five|six|\d+)(?: people)? now\b|\b(?:is|are) (?:now )?locked in\b(?![^.!?]*\b(?:can't|cannot|until|unpin|because|so i)\b)|\b(?:week|plan|day|meals?|menu) (?:is|are) (?:now )?ready\b/i;
// "is set up for" alone is a DESCRIPTION ("Your current plan is set up for three meals a day", a stored
// honest decline); only "is now set up for" or "set up for two now" claims a change (review of B2).
// "is locked in" is a claim, except when the sentence goes on to say why nothing moved: "Your Monday
// dinner is locked in, so I can't swap it until you unpin it" (review, 2026-10-21).

/**
 * A state the engine never produced, said as fact: "so they're back on the menu", "Eggs can go back into
 * your plan now", "no more celery in your week" (LC-06). These words are as natural in an offer or a
 * question as in a claim, so they count only in a sentence that is neither: "Want eggs back on the
 * menu?" and "I can put them back into your plan if you like" are honest.
 */
const CLAIMS_STATE =
  /\bback on the menu\b|\bback (?:in|into|onto|on) your (?:plan|week|meals|menu|diet)\b|\bno more (?!(?:room|space|time|than|need)\b)[a-z'-]+(?: [a-z'-]+)? in your (?:plan|week|meals|menu|diet|food)\b/i;
/** A change promised and never sent: "I'll put a tasty chicken dish on your Friday lunch" with no
 *  operation reads as done (models lane, 2026-10-20). Counted like a state, never in an offer or a
 *  question; "I'll keep it in mind" and "I'll make sure…" promise no change. */
const PROMISES_CHANGE =
  /\bi(?:'ll| will) (?!make sure\b)(?:put|add|swap|change|plan|make|move|replace|switch|set|lighten|scale|double|halve|remove|drop|take|cut|exclude|pin|lock|rate|build|rebuild|update|boost|bump|slot|pick)\b|\bi(?:'ll| will) keep\b[^.!?]{0,30}\bout\b/i;
const OFFER_OR_QUESTION =
  /\?\s*$|\b(?:want me to|shall i|should i|can i|i can|i could|would you like|do you want|if|once|unless|until|happy to|let me know)\b/i;
/** A promise that waits on the person's choice is not a change: "Pick two, and I'll build it", "Tell me
 *  which day and I'll swap it", "Which day is today? Then I'll make dinner lighter" are stored honest
 *  refusals and clarifications that B2 replaced with the canned line (review of B2, 2026-10-20). Judged
 *  SENTENCE by sentence, and only where the request opens the sentence or "Then" follows a question. The
 *  whole-reply gate it replaces let any "?" or "which" anywhere pass every promise and state claim:
 *  "Got it — no more celery in your week! Anything else?" and "I'll swap Monday's dinner for the salmon
 *  bowl, which has more protein" were shown as true with nothing changed (review, 2026-10-21). */
const REQUEST = /^(?:(?:just|so|okay|ok)[,\s]+)?(?:tell me|pick|choose|say the word|confirm|let me know)\b/i;
/** A question that asks for what the change needs (which day, what kind, this or that), not a sign-off:
 *  "…so I'll make it a dairy-free creamy pasta. One quick thing: which day is tomorrow on your plan?" waits
 *  on the answer, while "Anything else?" and "Want me to add a few?" do not. Two stored clarifications
 *  read as claims without it (of 1,045 stored replies, 2026-10-21). */
const CLARIFY = /\b(?:which|what|when|where|how (?:many|much)|or)\b[^.!]*\?\s*$/i;
/** A closing question that asks to go ahead with the change just described: "I'll rebuild your week around
 *  1,800 kcal. Shall I go ahead?" asks before acting, and was replaced by the canned line (models lane,
 *  2026-10-21). It excuses only the promise right before it. */
const CONFIRM =
  /^(?:(?:so|ok|okay|great|just to check)[,\s]+)?(?:(?:shall|should|can|may) i|(?:do you )?want me to|would you like me to) (?:go ahead|proceed|do (?:it|that|this))\b[^.!]*\?\s*$|^(?:sounds? good|does that sound (?:good|ok|okay|right)|is that (?:ok|okay|alright)|does that work(?: for you)?|ok(?:ay)?)\?\s*$/i;
/** ...unless it asks about a DIFFERENT change: "Shall I go ahead and do Wednesday as well?", "Should I do that
 *  for your snacks too?" left the promise standing as if made, and the loop's nudge never fired (review,
 *  2026-10-21). */
const OTHER_CHANGE =
  /\b(?:too|also|as well|next|instead|another|others?|rest|every|each|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|breakfasts?|lunch(?:es)?|dinners?|snacks?)\b/i;
/** ...or the reply says elsewhere that the change is done: "Updated. I'll keep the peanuts out from now on.
 *  Okay?" claims the change; the promise was what caught it (review, 2026-10-21). */
const DONE_ALREADY =
  /^(?:all )?(?:done|updated|swapped|sorted|changed|fixed|finished)\b|\ball set\b|\bhere'?s your (?:new|updated)\b|\b(?:is|are) now\b|\b(?:is|are) gone\b/i;

export function claimsChange(text: string): boolean {
  const t = text.trim().replace(/[‘’]/g, "'");
  if (CLAIMS_CHANGE.test(t) || CLAIMS_CHANGE_PASSIVE.test(t)) return true;
  // "…" ends a sentence too: "I'll add more protein to your breakfasts… Let me know if…" was one sentence,
  // and its "let me know" excused the promise. So does a full stop inside a closing quote, a bracket or bold:
  // "I'll swap it for “Salmon Bowl.” Anything else?" was one sentence, and its "?" excused the promise.
  const sentences = t.replace(/\*\*|__/g, "").split(/(?<=[.!?…]["”')\]]*)\s+/);
  const last = sentences[sentences.length - 1] ?? "";
  const confirms = CONFIRM.test(last) && !OTHER_CHANGE.test(last) && !sentences.slice(0, -1).some((s) => DONE_ALREADY.test(s));
  return sentences.some((s, i) => {
    if (OFFER_OR_QUESTION.test(s)) return false;
    if (CLAIMS_STATE.test(s)) return true;
    if (!PROMISES_CHANGE.test(s)) return false;
    return !(REQUEST.test(s) || (/^then\b/i.test(s) && /\?\s*$/.test(sentences[i - 1] ?? "")) ||
      sentences.some((q, j) => j !== i && CLARIFY.test(q)) ||
      (i === sentences.length - 2 && confirms));
  });
}

/** What the user reads instead of a claim the engine cannot back. Honest, and it keeps the turn going. */
export const NOTHING_CHANGED_REPLY =
  "I haven't changed anything yet. Tell me what you'd like changed and I'll do it, or ask me to show you the plan first.";

/** The same, when the turn saved a memory: true about what was kept AND about the plan. */
export const NOTED_NOTHING_CHANGED_REPLY =
  "I've noted that, but I haven't changed your plan yet. Tell me what you'd like changed and I'll do it.";

// What renders as an emoji, as check:boundaries rule 6 defines it (emoji presentation, or a pictograph forced into it
// by U+FE0F), with what joins onto one: skin tones, a zero-width-joined sequence, a keycap. "✓" and "→" are not.
const EMOJI_PART = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)(?:\p{Emoji_Modifier}|️)*`;
const EMOJI = new RegExp(`${EMOJI_PART}(?:\\u200D(?:${EMOJI_PART}|\\p{Extended_Pictographic}))*|\\uFE0F?\\u20E3`, "gu");

/**
 * The model's text with no emoji in it (the project rule: the app shows none, and they read as AI-generated). The
 * prompt asks for plain words, and a model does not always do as it is asked; engine notes never carry one, because
 * check:boundaries fails an emoji anywhere in src/. The gap an emoji leaves is closed up, newlines kept.
 */
export function withoutEmoji(text: string): string {
  return text
    .replace(EMOJI, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:)])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

export function composeReply(args: {
  /** What the LLM wrote. Untrusted prose. */
  modelReply: string | undefined;
  /** Facts the engine computed. The LLM cannot produce these; it does no arithmetic. */
  notes: string[];
  /** Set by the engine on a crisis or urgent medical symptom. Discards the model entirely. */
  replyOverride?: string;
  planChanged: boolean;
  /**
   * Whether the profile changed. Pass it when you KNOW it (the agent loop does): with both flags
   * false and no engine notes, a model reply that claims a change is replaced by
   * NOTHING_CHANGED_REPLY, because nothing the user can see would back it. Left undefined, the reply
   * passes as before — a caller that cannot tell must not silence a true statement.
   */
  profileChanged?: boolean;
  /**
   * A memory was saved this turn. It backs no claim (`profileChanged` above should not count it), but
   * the line that replaces a caught claim must not then say "I haven't changed anything" — something
   * was saved — so it says what was.
   */
  memorySaved?: boolean;
}): string {
  const { modelReply, notes, replyOverride, planChanged, profileChanged, memorySaved } = args;

  // The engine's word is final. Not prepended to, not appended to — the whole reply. Keyed off
  // PRESENCE, not truthiness: an override is set only on a crisis or urgent symptom, where the model
  // must be silenced entirely. If a bug ever set it to "", truthiness would fall through and let the
  // model speak in front of the warning — the exact failure this line exists to prevent — so a
  // present-but-empty override still wins and simply yields an empty reply: a safe, visible failure
  // rather than a dangerous, silent one.
  if (replyOverride !== undefined) return replyOverride;

  // Engine notes are AUTHORITATIVE computed facts. When the engine has something to say, that IS the
  // reply — the model's prose is untrusted and, worse, the fine-tune learned to restate the notes,
  // which duplicated them ("Kept Monday on target. Kept Monday on target — 1993 kcal…"). So notes win
  // outright; the model's reply is only used when the engine is silent (a pure question / clarify).
  // Trim, drop empties, and DE-DUPLICATE before joining: the fine-tune's restatement was fixed, but
  // the same note still arrives twice via a repeated op (single-shot) or an op repeated across loop
  // steps (agentLoop accumulates every step's notes) — the user must not read the same sentence
  // twice, and an all-empty notes array must fall through to the model/fallback, not return "".
  const clean = [...new Set(notes.map((n) => n.trim()).filter(Boolean))];
  if (clean.length) return clean.join(" ");

  const base = modelReply === undefined ? undefined : withoutEmoji(modelReply);
  if (base) {
    // The engine is silent and nothing changed, so this text is the model's alone. It may not say
    // something changed (the two-layer rule: only the engine may claim a change).
    if (profileChanged === false && !planChanged && claimsChange(base)) return memorySaved ? NOTED_NOTHING_CHANGED_REPLY : NOTHING_CHANGED_REPLY;
    return base;
  }
  return planChanged ? "Done — I updated your plan." : "Happy to help.";
}
