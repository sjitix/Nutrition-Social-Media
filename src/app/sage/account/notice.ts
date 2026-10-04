import type { AccountStatus } from "@/lib/account/client";

/**
 * What the account has to say on EVERY /sage screen, not only on the account page (the batch 4-5
 * review: a week replaced by a newer one from another device, or an account deleted elsewhere, was
 * announced only on /sage/account; anywhere else the next routine "saved" erased the sentence unseen).
 *
 * Two kinds of sentence, kept differently:
 *  - A ONE-OFF NOTE, said once by a sync or a sign-out ("set aside", "your account had newer data",
 *    "this account was deleted", "you signed out in another tab"). The status forgets it at the next
 *    edit, so it is KEPT here until the person dismisses it, or until they sign in or out (it was
 *    about the other side of that line), or until another note replaces it.
 *  - A CONDITION, true while it lasts (offline; a store held back; a sync that needs attention). It
 *    follows the live status, so it goes away by itself once the condition does. Dismissing it holds
 *    for as long as it is the same sentence: being offline re-reports itself on every failed send.
 *
 * Pure, so the rules are tested without a React renderer (scripts/test-account.mts).
 */
export interface NoticeState {
  /** The one-off note being kept, and whether it was said while signed in. */
  kept: { text: string; signedIn: boolean } | null;
  /** The sentence the person dismissed. */
  dismissed: string | null;
}

export const NO_NOTICE: NoticeState = { kept: null, dismissed: null };

const isSignedIn = (s: AccountStatus) => s.state !== "off" && s.state !== "signed-out";
const isCondition = (s: AccountStatus) => s.state === "error" || s.state === "offline";

/** The notice state after this status arrives. */
export function nextNotice(prev: NoticeState, s: AccountStatus): NoticeState {
  if (s.message && !isCondition(s)) {
    // A new one-off note: kept, and shown even if an earlier note with the same words was dismissed.
    return { kept: { text: s.message, signedIn: isSignedIn(s) }, dismissed: null };
  }
  // Signed in or out since the kept note was said: it is no longer about now.
  if (prev.kept && prev.kept.signedIn !== isSignedIn(s)) return { ...prev, kept: null };
  return prev;
}

/** The sentence to show now, or null. A condition wins: it is what is true at this moment. */
export function noticeText(state: NoticeState, s: AccountStatus): string | null {
  const text = (isCondition(s) && s.message) || state.kept?.text || null;
  return text && text !== state.dismissed ? text : null;
}
