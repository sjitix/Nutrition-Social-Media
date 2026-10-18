"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  STORE_NAMES, discardBackup, loadBackups, putBackCopy, readStore, takeBackup, writeStore,
  type LocalBackup, type StoreName,
} from "@/lib/storage";
import {
  applyImport, buildExport, describeData, exportFilename, parseExport, type ParseResult,
} from "@/lib/account/portable";
import { forgetThisBrowser } from "@/lib/account/client";
import { AccountPanel } from "./AccountPanel";

/**
 * "Your data" — take it with you, bring it back, delete it.
 *
 * Three honesty rules shape this screen:
 *
 *  1. **It says what is actually stored**, counted off the data (`describeData`), not a generic
 *     "your information". If this browser holds nothing, it says that.
 *  2. **Nothing replaces your data without a way back.** An import first snapshots everything
 *     (`takeBackup`), and the page offers to put it back for as long as that snapshot exists.
 *  3. **Destructive actions confirm in the page**, in words that say exactly what will go — no
 *     browser `confirm()` dialog that reads the same for every action.
 */
export function AccountClient() {
  const [held, setHeld] = useState<string[] | null>(null);
  const [backups, setBackups] = useState<LocalBackup[]>([]);
  const [incoming, setIncoming] = useState<{ file: string; result: ParseResult } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Focus goes INTO a confirm step when it opens, so a keyboard or screen-reader user lands on the
  // question rather than on the page body after the button they pressed disappears.
  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmDelete) keepButton.current?.focus();
  }, [confirmDelete]);
  const fileInput = useRef<HTMLInputElement>(null);
  // When an action removes the control that was pressed (Put it back, Forget this copy, Bring it in,
  // Cancel, Keep it), focus goes to the note saying what happened. Without this it fell to the page
  // body, and the next Tab started again from the top (review 2).
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [focusNote, setFocusNote] = useState(0);
  useEffect(() => {
    if (focusNote) noteRef.current?.focus();
  }, [focusNote]);
  const sayAndFocus = (text: string) => {
    setNote(text);
    setFocusNote((n) => n + 1);
  };

  // Read storage in an effect, never during render: the server render has no browser storage, and a
  // first client render that disagreed with it would be a hydration mismatch.
  function refresh() {
    const data: Partial<Record<StoreName, unknown>> = {};
    for (const n of STORE_NAMES) {
      const v = readStore(n);
      if (v !== null) data[n] = v;
    }
    setHeld(describeData(data));
    setBackups(loadBackups());
  }
  useEffect(refresh, []);

  function exportNow() {
    const bundle = buildExport((n) => readStore(n));
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Kept alive for a minute, not a second: iPhone Safari asks "Download?" and only then reads the
    // file — a link revoked after one second is already dead and the download silently does nothing.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setNote(`Your browser is downloading ${a.download}. Open this page on another device and bring it back in.`);
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setNote(null);
    setIncoming({ file: file.name, result: parseExport(await file.text()) });
    if (fileInput.current) fileInput.current.value = ""; // so picking the same file again re-reads it
  }

  function importNow() {
    if (!incoming?.result.ok) return;
    try {
      takeBackup(`before importing ${incoming.file}`);
    } catch (e) {
      // No room for a safety copy means no import: replacing data without one is the thing to avoid.
      setNote(e instanceof Error ? e.message : "Couldn't keep a safety copy, so nothing was imported.");
      return;
    }
    applyImport(incoming.result.bundle, (n, v) => writeStore(n, v));
    setIncoming(null);
    // The same words as the preview, so what was done is exactly what was offered.
    sayAndFocus(`Brought in from ${incoming.file}: ${describeData(incoming.result.bundle.data, { incoming: true }).join(", ")}. What was here before is kept as a copy in the list below until you forget it.`);
    refresh();
  }

  function restoreNow(b: LocalBackup) {
    // Putting a copy back replaces what is here now — so what is here now is kept as a copy first,
    // without ever pushing out the copy being put back (storage.putBackCopy).
    let ok: boolean;
    try {
      ok = putBackCopy(b.id, `before putting back the copy from ${when(b.takenAt)}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't keep a safety copy, so nothing was changed.");
      return;
    }
    sayAndFocus(ok
      ? "Put back exactly what this browser held then. What was here a moment ago is kept as a copy."
      : "That copy is no longer here (it may have been forgotten in another tab), so nothing was changed.");
    refresh();
  }

  function forget(b: LocalBackup) {
    discardBackup(b.id);
    sayAndFocus(`Forgot the copy from ${when(b.takenAt)}. It can't be put back now.`);
    refresh();
  }

  async function deleteNow() {
    // Stop syncing (and cancel a sync in flight) BEFORE clearing, or a pull landing a moment later
    // would put everything straight back; then end the sign-in. The account itself is untouched.
    try {
      await forgetThisBrowser();
    } catch (e) {
      // Refused: this browser now holds an account this page isn't showing (another tab signed in).
      setConfirmDelete(false);
      sayAndFocus(e instanceof Error ? e.message : "Nothing was deleted.");
      return;
    }
    setConfirmDelete(false);
    sayAndFocus("Everything this app kept in this browser is gone, and this browser is signed out. Your account, if you had one, is untouched.");
    refresh();
  }

  const nothing = held !== null && held.length === 0;

  return (
    <div className="px-6 pb-16 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="border-b border-plum/25 pb-6">
        <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">Account · your data</span>
        <h1 className="font-serif-display mt-4 max-w-[16ch] text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
          Your plan is yours.
        </h1>
        <p className="mt-4 max-w-[62ch] text-[13.5px] leading-relaxed text-mut">
          Everything NutriFlow knows about you lives in this browser, and — when you sign in — in your
          account too. Take it with you as a file, bring it back on another device, or delete it.
        </p>
      </div>

      <p
        ref={noteRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={note ? "mt-6 max-w-[720px] rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed outline-none" : "sr-only"}
      >
        {note ?? ""}
      </p>

      {backups.length > 0 && (
        <section className="mt-6 max-w-[720px] rounded-[12px] bg-panel p-5 text-white" aria-labelledby="backups-h">
          <h2 id="backups-h" className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-white/60">
            {backups.length === 1 ? "A way back" : `${backups.length} ways back`}
          </h2>
          <ul className="mt-2 space-y-3">
            {backups.map((b) => (
              <li key={b.id} className="border-t border-white/15 pt-3 first:border-0 first:pt-0">
                <p className="text-[13px] leading-relaxed text-white/85">
                  A copy from {when(b.takenAt)}, {b.reason}: {describeData(b.data).join(", ") || "it was empty"}.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => restoreNow(b)} className="rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-plum transition hover:bg-cream">
                    Put it back
                  </button>
                  <button type="button" onClick={() => forget(b)} className="rounded-full px-3 py-2 text-[12px] font-semibold text-white/70 transition hover:text-white">
                    Forget this copy
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-white/55">
            Putting a copy back replaces what is here now, which is kept as a copy in turn. If you are
            signed in, what you put back becomes your account&apos;s data too. The last three copies are kept.
          </p>
        </section>
      )}

      <div className="mt-8 grid max-w-[1100px] gap-4 lg:grid-cols-2">
        <AccountPanel onChange={refresh} />

        {/* ---- what is here ---- */}
        <section className="rounded-[12px] bg-cream p-5 lg:col-span-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">In this browser right now</h2>
          {held === null ? (
            <p className="mt-2 text-[12.5px] text-mut">Reading…</p>
          ) : nothing ? (
            <p className="mt-2 text-[13px] leading-relaxed">
              Nothing yet.{" "}
              <Link href="/onboarding" className="font-semibold text-vio hover:text-vio-deep">Set up your plan</Link>{" "}
              or bring in a file below.
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {held.map((h) => (
                <li key={h} className="rounded-full border border-line bg-bgsoft px-3 py-1 text-[12px]">{h}</li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- take it with you ---- */}
        <section className="rounded-[12px] bg-tint p-5">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Take it with you</h2>
          <p className="mt-2 text-[13px] leading-relaxed">
            One file with your profile, your weeks, saved recipes and history. It never includes a
            password or sign-in token.
          </p>
          <button
            type="button"
            onClick={exportNow}
            disabled={nothing}
            className="mt-4 rounded-full bg-vio px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep disabled:opacity-40"
          >
            Download my data
          </button>
        </section>

        {/* ---- bring it back ---- */}
        <section className="rounded-[12px] bg-tint p-5">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Bring it back</h2>
          <p className="mt-2 text-[13px] leading-relaxed">
            Choose a NutriFlow file. You will see what is in it before anything changes, and what is
            here now is kept so you can put it back.
          </p>
          <label className="mt-4 inline-block cursor-pointer rounded-full border border-line bg-cream px-5 py-2.5 text-[12.5px] font-semibold transition hover:border-vio focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-vio">
            Choose a file
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
          </label>

          {incoming && (
            <div className="mt-4 rounded-[10px] border border-line bg-cream p-4">
              {incoming.result.ok ? (
                <>
                  <p className="text-[12.5px] leading-relaxed">
                    <b className="font-semibold">{incoming.file}</b> holds{" "}
                    {describeData(incoming.result.bundle.data, { incoming: true }).join(", ")}.
                  </p>
                  {incoming.result.warnings.map((w) => (
                    <p key={w} className="mt-1.5 text-[11.5px] text-mut">{w}</p>
                  ))}
                  <p className="mt-2 text-[11.5px] leading-relaxed text-mut">
                    Those replace what is here — and, if you are signed in, in your account and on your
                    other devices too. Anything the file doesn&apos;t carry stays as it is.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={importNow} className="rounded-full bg-vio px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-vio-deep">
                      Bring it in
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIncoming(null);
                        sayAndFocus("Nothing was brought in.");
                      }}
                      className="rounded-full px-3 py-2 text-[12px] font-semibold text-mut transition hover:text-plum"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p role="alert" className="text-[12.5px] leading-relaxed text-red-700">{incoming.result.error}</p>
              )}
            </div>
          )}
        </section>

        {/* ---- what is kept where — the privacy note, in plain words and only true ones ---- */}
        <section className="rounded-[12px] bg-cream p-5 lg:col-span-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">What is kept, and where</h2>
          {/*
            Every sentence here was checked against the code, and two were corrected by an adversarial
            review: "nothing leaves this browser unless you sign in" was false (building or changing a
            plan sends your profile to the server), and "readable only by you" left out the people who
            run the service and the sign-in records the provider keeps. Keep it true when things change.
          */}
          <ul className="mt-2 max-w-[78ch] space-y-1.5 text-[12.5px] leading-relaxed">
            <li>
              <b className="font-semibold">In this browser:</b> your profile and targets (including any
              body measurements and things you told the assistant), your weeks, saved and imported
              recipes, ticked grocery items, chat with the assistant, and which days you opened the app.
            </li>
            <li>
              <b className="font-semibold">Sent to work things out, not kept for your account:</b>
              building or changing your plan sends your profile and your week to NutriFlow&apos;s server,
              and, when an AI model is switched on, to that model&apos;s provider, to calculate the answer.
              Messages to the assistant go the same way, together with your profile and week, and the
              server may keep a log of each conversation to improve the assistant.
            </li>
            <li>
              <b className="font-semibold">In your account, when you sign in:</b> a copy of the
              in-browser list above, plus your email address so a sign-in link can reach you. It is
              stored with our database provider, Supabase. Other accounts and signed-out visitors cannot
              read it; the people who run NutriFlow can, to operate the service. Each sign-in, and its
              automatic renewal about once an hour while the app is open, is logged with your email
              address, and the sign-in provider&apos;s request logs record the IP address and browser
              each came from. Sign-in links are sent through an email delivery service, which keeps its
              own record of each email it sends to you.
            </li>
            <li>
              <b className="font-semibold">Not kept:</b> a password (sign-in is by email link) or payment
              details.
            </li>
            <li>
              <b className="font-semibold">Deleting your account</b> removes everything stored in it.
              The sign-in logs and the email service&apos;s records above are not part of the account:
              they keep your email address for as long as those services&apos; log settings keep them.
            </li>
          </ul>
        </section>

        {/* ---- delete ---- */}
        <section className="rounded-[12px] border border-line p-5 lg:col-span-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Delete</h2>
          <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed">
            Removes everything this app keeps in this browser — profile, weeks, saved recipes, chat and
            history. It cannot be undone, so download a copy first if you might want it.
          </p>
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={nothing}
              className="mt-4 rounded-full border border-line px-5 py-2.5 text-[12.5px] font-semibold text-red-700 transition hover:border-red-700 disabled:opacity-40"
            >
              Delete everything in this browser
            </button>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[10px] bg-red-50 px-4 py-3" role="group" aria-label="Confirm deleting everything in this browser">
              <span className="text-[12.5px] text-red-700">Delete {held?.join(", ")}? This also signs this browser out.</span>
              <button type="button" onClick={deleteNow} className="rounded-full bg-red-700 px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-red-800">
                Yes, delete it all
              </button>
              <button
                ref={keepButton}
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  sayAndFocus("Nothing was deleted.");
                }}
                className="rounded-full px-3 py-2 text-[12px] font-semibold text-mut transition hover:text-plum"
              >
                Keep it
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}
