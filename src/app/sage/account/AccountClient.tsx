"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  STORE_NAMES, clearAll, loadBackup, readStore, restoreBackup, takeBackup, writeStore,
  type LocalBackup, type StoreName,
} from "@/lib/storage";
import {
  applyImport, buildExport, describeData, exportFilename, parseExport, type ParseResult,
} from "@/lib/account/portable";
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
  const [backup, setBackup] = useState<LocalBackup | null>(null);
  const [incoming, setIncoming] = useState<{ file: string; result: ParseResult } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Read storage in an effect, never during render: the server render has no browser storage, and a
  // first client render that disagreed with it would be a hydration mismatch.
  function refresh() {
    const data: Partial<Record<StoreName, unknown>> = {};
    for (const n of STORE_NAMES) {
      const v = readStore(n);
      if (v !== null) data[n] = v;
    }
    setHeld(describeData(data));
    setBackup(loadBackup());
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote(`Saved ${a.download}. Open this page on another device and bring it back in.`);
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setNote(null);
    setIncoming({ file: file.name, result: parseExport(await file.text()) });
    if (fileInput.current) fileInput.current.value = ""; // so picking the same file again re-reads it
  }

  function importNow() {
    if (!incoming?.result.ok) return;
    takeBackup(`before importing ${incoming.file}`);
    const written = applyImport(incoming.result.bundle, (n, v) => writeStore(n, v));
    setIncoming(null);
    setNote(`Brought in ${written.length} item${written.length === 1 ? "" : "s"} from ${incoming.file}. What was here before is kept below until you discard it.`);
    refresh();
  }

  function restoreNow() {
    if (restoreBackup()) setNote("Put back exactly what this browser held before.");
    refresh();
  }

  function deleteNow() {
    clearAll();
    setConfirmDelete(false);
    setNote("Everything this app kept in this browser is gone.");
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

      {note && (
        <p role="status" className="mt-6 max-w-[720px] rounded-[10px] bg-tint px-4 py-3 text-[12.5px] leading-relaxed">
          {note}
        </p>
      )}

      {backup && (
        <div className="mt-6 max-w-[720px] rounded-[12px] bg-panel p-5 text-white">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-white/60">A way back</p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/85">
            This browser kept a copy of your data from {when(backup.takenAt)}, {backup.reason}:{" "}
            {describeData(backup.data).join(", ") || "it was empty"}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={restoreNow} className="rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-plum transition hover:bg-cream">
              Put it back
            </button>
          </div>
        </div>
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
          <label className="mt-4 inline-block cursor-pointer rounded-full border border-line bg-cream px-5 py-2.5 text-[12.5px] font-semibold transition hover:border-vio">
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
                    {describeData(incoming.result.bundle.data).join(", ")}.
                  </p>
                  {incoming.result.warnings.map((w) => (
                    <p key={w} className="mt-1.5 text-[11.5px] text-mut">{w}</p>
                  ))}
                  <p className="mt-2 text-[11.5px] leading-relaxed text-mut">
                    Those replace what is here. Anything the file doesn&apos;t carry stays as it is.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={importNow} className="rounded-full bg-vio px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-vio-deep">
                      Bring it in
                    </button>
                    <button type="button" onClick={() => setIncoming(null)} className="rounded-full px-3 py-2 text-[12px] font-semibold text-mut transition hover:text-plum">
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-red-700">{incoming.result.error}</p>
              )}
            </div>
          )}
        </section>

        {/* ---- what is kept where — the privacy note, in plain words and only true ones ---- */}
        <section className="rounded-[12px] bg-cream p-5 lg:col-span-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">What is kept, and where</h2>
          <ul className="mt-2 max-w-[78ch] space-y-1.5 text-[12.5px] leading-relaxed">
            <li>
              <b className="font-semibold">In this browser:</b> your profile and targets, your weeks,
              saved and imported recipes, ticked grocery items, chat with the assistant, and which days
              you opened the app. Nothing leaves it unless you sign in or download a file.
            </li>
            <li>
              <b className="font-semibold">In your account, when you sign in:</b> a copy of exactly that
              list, plus your email address so a sign-in link can reach you. It is readable only by
              you — the database refuses every other account, and signed-out visitors see nothing.
            </li>
            <li>
              <b className="font-semibold">Not kept anywhere:</b> a password (sign-in is by email link),
              payment details, or your location.
            </li>
            <li>
              <b className="font-semibold">Messages to the assistant</b> go to the server and the AI
              model that answer them, and the server may keep a log of each conversation to improve the
              assistant. Your account copy holds only the chat history you see here.
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
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[10px] bg-red-50 px-4 py-3">
              <span className="text-[12.5px] text-red-700">Delete {held?.join(", ")}?</span>
              <button type="button" onClick={deleteNow} className="rounded-full bg-red-700 px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-red-800">
                Yes, delete it all
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-full px-3 py-2 text-[12px] font-semibold text-mut transition hover:text-plum">
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
