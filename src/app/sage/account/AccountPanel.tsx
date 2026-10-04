"use client";

import { useEffect, useRef, useState } from "react";
import {
  accountConfig, accountStatus, canRetrySignIn, completeSignInFromUrl, deleteAccount, onAccountStatus, onPulled,
  openedFromSignInLink, retrySignIn, sendSignInLink, signOut, startSync, type AccountStatus,
} from "@/lib/account/client";
import { notifyPlanChanged } from "../myPlan";

/**
 * Sign in, see that your data is kept in your account, sign out, delete the account.
 *
 * What it promises in words, because each is a real property of the design rather than copy:
 *  - signing in never costs the week on this device (the first sync backs up anything it replaces);
 *  - signing out keeps this device's data (the account is a mirror, not the working copy);
 *  - deleting the account removes what is stored in it, and says this device's copy is separate.
 *
 * With accounts not configured it says so plainly, rather than showing a sign-in that cannot work.
 */
export function AccountPanel({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<AccountStatus>({ state: "off" });
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // While a sign-in link's code is being exchanged, the email form is not offered: a second request
  // made then could only confuse the sign-in already under way (review 2).
  const [signingIn, setSigningIn] = useState(false);
  // A sign-in whose exchange failed for a transient reason can be finished from here: the emailed link
  // was used up when it was opened, so opening it again could not.
  const [canRetry, setCanRetry] = useState(false);
  // What the panel itself has to say, when the account has nothing to: "Signed out." Cleared by the
  // next change of status, so it never outlives the moment it describes.
  const [said, setSaid] = useState<string | null>(null);
  // Where keyboard focus goes when a confirm step opens or a message replaces the control that had it,
  // so a screen-reader user hears the question instead of focus falling to the page body.
  const keepButton = useRef<HTMLButtonElement>(null);
  const sentNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (confirmDelete) keepButton.current?.focus();
  }, [confirmDelete]);
  useEffect(() => {
    if (sent) sentNote.current?.focus();
  }, [sent]);
  // ...and once a step closes, or the control that was pressed is gone: back to the control that
  // opened the step, or to the note that says what happened. Focus used to fall to the page body, so
  // the next Tab started again from the top of the page (review 2, ui-tests-8).
  const [focusOn, setFocusOn] = useState<"note" | "delete" | "signOut" | "alert" | null>(null);
  const statusNote = useRef<HTMLParagraphElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const signOutButton = useRef<HTMLButtonElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusOn) return;
    ({ note: statusNote, delete: deleteButton, signOut: signOutButton, alert: alertBox })[focusOn].current?.focus();
    setFocusOn(null);
  }, [focusOn]);

  useEffect(() => {
    setConfigured(accountConfig() !== null);
    const offStatus = onAccountStatus((s) => {
      setStatus(s);
      setSaid(null);
    });
    // This page shows what is stored, so it re-reads whenever data comes down from the account; the
    // other screens hear the same pull through notifyPlanChanged.
    const offPulled = onPulled(() => {
      notifyPlanChanged();
      onChange();
    });
    // Finish a sign-in this page was opened from (if any), THEN sync — the sync needs the session the
    // link produces. A sign-in can set data aside (another account's) or replace some of it, so the
    // page's view of what is stored is refreshed once the first sync settles, whatever it did.
    setSigningIn(openedFromSignInLink());
    void completeSignInFromUrl()
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Sign-in didn't complete. Ask for a new link.");
        setCanRetry(canRetrySignIn());
      })
      .finally(() => setSigningIn(false))
      .then(() => startSync())
      .then(() => onChange());
    return () => {
      offStatus();
      offPulled();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await sendSignInLink(email);
      setSent(email.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the email.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    // The alert stays up while this runs, its button reading "Trying…": clearing it first unmounted the
    // very button that was pressed, and focus fell to the page body. The form gives way to "Signing you
    // in…" meanwhile, since asking for another link mid-retry can only confuse it (review of batches 4-5).
    setSigningIn(true);
    try {
      await retrySignIn();
      setError(null);
      setCanRetry(false);
      await startSync();
      onChange();
      if (!accountStatus().message) setSaid(`Signed in as ${accountStatus().email || "your account"}.`);
      setFocusOn("note");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in didn't complete. Ask for a new link.");
      setCanRetry(canRetrySignIn());
      setFocusOn("alert");
    } finally {
      setBusy(false);
      setSigningIn(false);
    }
  }

  /** Sign out or delete. Done: focus goes to the note saying so. Failed: back to the control pressed. */
  async function run(fn: () => Promise<void>, failedFocus: "delete" | "signOut", after?: () => void) {
    setBusy(true);
    setError(null);
    let failed = false;
    try {
      await fn();
      after?.();
      onChange();
    } catch (e) {
      failed = true;
      const message = e instanceof Error ? e.message : "That didn't go through.";
      // A refusal can already have said exactly this in the note (a delete refused in a stale tab signs
      // the tab out and says why): once is enough, and an alert would repeat it, assertively.
      if (message !== accountStatus().message) setError(message);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
      // Back to the control pressed, if it is still there. A refusal that signed this tab out took that
      // control away with the signed-in view, so the note saying why takes focus instead.
      const stillSignedIn = !["off", "signed-out"].includes(accountStatus().state);
      setFocusOn(failed && stillSignedIn ? failedFocus : "note");
    }
  }

  const signedIn = !["off", "signed-out"].includes(status.state);
  const note = status.message || said || "";

  return (
    <section className="rounded-[12px] bg-panel p-5 text-white lg:col-span-2" aria-labelledby="account-h">
      <h2 id="account-h" className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">
        Your account
      </h2>

      {/* ONE live region, in the page from the start, signed in or out: a role="status" node mounted
          together with its text is announced unreliably, and the panel used to have one per view, each
          gone with its view (review 2, ui-tests-8). Offline and error states always carry a message, so
          they are announced here; the routine "Syncing…" / "saved" line beside the email is not. */}
      <p
        ref={statusNote}
        tabIndex={-1}
        role="status"
        className={note ? "mt-3 max-w-[70ch] rounded-[10px] bg-white/10 px-4 py-3 text-[12.5px] leading-relaxed outline-none" : "sr-only"}
      >
        {note}
      </p>

      {configured === false && (
        <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-white/85">
          Accounts aren&apos;t switched on for this copy of the app yet, so nothing about you is kept in an
          account: your data stays in this browser. What is sent to the server to work out your plan,
          and what the server may log, is explained below. Until accounts are on, the file download
          below is how you move your plan to another device.
        </p>
      )}

      {configured && !signedIn && (
        <>
          <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-white/85">
            Sign in to keep your plan on every device you use. We email you a link — no password. A
            week you made here before having an account comes with you; if your account already has a
            newer one, that wins and this browser&apos;s is kept as a copy on this page. If this browser
            holds another account&apos;s data, it is set aside rather than added to yours.
          </p>
          {signingIn ? (
            <p role="status" className="mt-4 rounded-[10px] bg-white/10 px-4 py-3 text-[12.5px] leading-relaxed">
              Signing you in…
            </p>
          ) : sent ? (
            <p ref={sentNote} tabIndex={-1} role="status" className="mt-4 rounded-[10px] bg-white/10 px-4 py-3 text-[12.5px] leading-relaxed outline-none">
              Check <b className="font-semibold">{sent}</b> for a sign-in link, and open it{" "}
              <b className="font-semibold">in this browser</b> — for your safety, a link opened anywhere else
              won&apos;t sign you in.
            </p>
          ) : (
            <form
              className="mt-4 flex max-w-[520px] flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor="account-email" className="sr-only">Email address</label>
              <input
                id="account-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-full border border-white/20 bg-white/10 px-4 py-2.5 text-[13px] text-white outline-none placeholder:text-white/40 focus:border-white/60"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-full bg-white px-5 py-2.5 text-[12.5px] font-semibold text-plum transition hover:bg-cream disabled:opacity-50"
              >
                {busy ? "Sending…" : "Email me a link"}
              </button>
            </form>
          )}
        </>
      )}

      {signedIn && (
        <>
          <p className="mt-2 text-[13px] leading-relaxed text-white/85">
            Signed in as <b className="font-semibold text-white">{status.email || "your account"}</b>.{" "}
            <SyncLine status={status} />
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              ref={signOutButton}
              type="button"
              disabled={busy}
              onClick={() =>
                void run(signOut, "signOut", () => {
                  // Nothing to report from the account (everything had gone up): still say it happened.
                  if (!accountStatus().message) setSaid("Signed out. Everything is still in this browser.");
                })
              }
              className="rounded-full bg-white/12 px-4 py-2 text-[12px] font-semibold transition hover:bg-white/20 disabled:opacity-50"
            >
              Sign out
            </button>
            {!confirmDelete ? (
              <button
                ref={deleteButton}
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                className="rounded-full px-4 py-2 text-[12px] font-semibold text-white/70 transition hover:text-white disabled:opacity-50"
              >
                Delete my account
              </button>
            ) : (
              // A labelled group, so focus landing on "Keep it" reads the question too, not just the button.
              <span role="group" aria-labelledby="delete-account-q" className="flex flex-wrap items-center gap-2 rounded-full bg-white/10 py-1 pl-4 pr-1 text-[12px]">
                <span id="delete-account-q">Delete the account and everything stored in it?</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(deleteAccount, "delete")}
                  className="rounded-full bg-white px-3 py-1.5 font-semibold text-red-700 transition hover:bg-cream"
                >
                  Yes, delete it
                </button>
                <button
                  ref={keepButton}
                  type="button"
                  onClick={() => {
                    setConfirmDelete(false);
                    setFocusOn("delete");
                  }}
                  className="px-2 py-1.5 font-semibold text-white/70 hover:text-white"
                >
                  Keep it
                </button>
              </span>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-white/55">
            Signing out keeps your data in this browser. Deleting the account removes what is stored
            in it; to clear this browser too, use Delete below.
          </p>
        </>
      )}

      {error && (
        <div ref={alertBox} tabIndex={-1} role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-[10px] bg-white px-4 py-3 text-[12.5px] text-red-700 outline-none">
          <span>{error}</span>
          {canRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void retry()}
              className="rounded-full bg-red-700 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-red-800 disabled:opacity-50"
            >
              {busy ? "Trying…" : "Try again"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function SyncLine({ status }: { status: AccountStatus }) {
  const text: Record<string, string> = {
    syncing: "Syncing…",
    pending: "Changes waiting to send…",
    saved: status.lastSyncedAt
      ? `Everything is saved to your account (${new Date(status.lastSyncedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}).`
      : "Everything is saved to your account.",
    offline: "Offline — your changes are kept here and will be sent.",
    error: "Syncing needs your attention: see the note above.",
  };
  return <span>{text[status.state] ?? ""}</span>;
}
