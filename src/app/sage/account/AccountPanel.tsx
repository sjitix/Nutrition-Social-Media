"use client";

import { useEffect, useState } from "react";
import {
  accountConfig, completeSignInFromUrl, deleteAccount, onAccountStatus, sendSignInLink, signOut, startSync,
  type AccountStatus,
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

  useEffect(() => {
    setConfigured(accountConfig() !== null);
    const off = onAccountStatus(setStatus);
    try {
      completeSignInFromUrl();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in didn't complete.");
    }
    void startSync(() => {
      notifyPlanChanged();
      onChange();
    });
    return off;
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

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const signedIn = !["off", "signed-out"].includes(status.state);

  return (
    <section className="rounded-[12px] bg-panel p-5 text-white lg:col-span-2" aria-labelledby="account-h">
      <h2 id="account-h" className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">
        Your account
      </h2>

      {configured === false && (
        <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-white/85">
          Accounts aren&apos;t switched on for this copy of the app yet, so everything stays in this
          browser. Until they are, the file download below is how you move your plan to another device.
        </p>
      )}

      {configured && !signedIn && (
        <>
          <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-white/85">
            Sign in to keep your plan on every device you use. We email you a link — no password. If
            this browser already has a week, it comes with you; nothing here is thrown away.
          </p>
          {sent ? (
            <p role="status" className="mt-4 rounded-[10px] bg-white/10 px-4 py-3 text-[12.5px] leading-relaxed">
              Check <b className="font-semibold">{sent}</b> for a sign-in link, and open it in this browser.
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
          {status.message && (
            <p className="mt-2 max-w-[70ch] text-[12px] leading-relaxed text-white/65">{status.message}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(signOut)}
              className="rounded-full bg-white/12 px-4 py-2 text-[12px] font-semibold transition hover:bg-white/20 disabled:opacity-50"
            >
              Sign out
            </button>
            {!confirmDelete ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                className="rounded-full px-4 py-2 text-[12px] font-semibold text-white/70 transition hover:text-white disabled:opacity-50"
              >
                Delete my account
              </button>
            ) : (
              <span className="flex flex-wrap items-center gap-2 rounded-full bg-white/10 py-1 pl-4 pr-1 text-[12px]">
                Delete the account and everything stored in it?
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(deleteAccount)}
                  className="rounded-full bg-white px-3 py-1.5 font-semibold text-red-700 transition hover:bg-cream"
                >
                  Yes, delete it
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1.5 font-semibold text-white/70 hover:text-white">
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

      {error && <p role="alert" className="mt-3 rounded-[10px] bg-white px-4 py-3 text-[12.5px] text-red-700">{error}</p>}
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
    error: "Sync hit a problem.",
  };
  return <span>{text[status.state] ?? ""}</span>;
}
