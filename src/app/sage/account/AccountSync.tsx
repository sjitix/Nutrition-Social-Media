"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  carryNoteAcrossReload, onAccountStatus, onPulled, startSync, watchOtherTabs, type AccountStatus,
} from "@/lib/account/client";
import { claimSyncReload } from "@/lib/storage";
import { notifyPlanChanged } from "../myPlan";
import { NO_NOTICE, nextNotice, noticeText, type NoticeState } from "./notice";

/**
 * Keeps a signed-in browser mirrored to its account, on every screen. Mounted once in the /sage layout.
 *
 * With no Supabase keys configured, or nobody signed in, `startSync` returns at once and this costs
 * nothing. When data comes DOWN from the account (the first sync, or a re-sync when the tab regains
 * focus), mounted screens are told to re-read through the same event every other plan change uses
 * (`notifyPlanChanged`).
 *
 * THE RELOAD, AND WHY IT IS HERE (a stopgap, recorded in docs/parallel/lane-accounts.md). Not every
 * screen re-reads on that event: the assistant keeps its own copy of the week and profile from when it
 * mounted, and the one-step undo in `actions.ts` holds a snapshot from before the pull. Either would
 * write that stale copy back over what just came down, and it would win as the newest edit. So when a
 * pull brings the week, the meal-prep week or the profile — the stores those screens hold — the tab
 * reloads once, and every screen starts from the account's data. `claimSyncReload` makes it at most
 * once per 30 seconds, so it can never loop. When those screens re-read on the event themselves (asked
 * of the v1 lane), this reload can go.
 *
 * OTHER TABS (`watchOtherTabs`, review 2). A pull reaches only the tab whose sync made it: another tab
 * holding the same week finds nothing left to pull and is never told. And when the browser changes
 * hands in another tab, this tab's screens still hold the previous person's data. Both reload here too.
 *
 * WHAT THE ACCOUNT HAS TO SAY, ON EVERY SCREEN (review of batches 4-5). The sentences that matter most
 * ("your account had newer data, so it replaced some of what was on this device", "this account was
 * deleted") were shown only on the account page; anywhere else, the next routine "saved" erased them
 * unseen. So this renders one small notice, fixed in a corner and out of the page's layout, while the
 * account has something to say. On the account page the panel says it instead. What is kept, and for
 * how long, follows pure rules that are tested on their own (`notice.ts`).
 */
const HELD_BY_SCREENS = new Set(["plan", "batchPlan", "profile"]);

const reload = () => {
  if (typeof window.location.reload === "function") window.location.reload();
};

const NOTICE =
  "fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 rounded-[12px] bg-panel p-4 text-white shadow-lg sm:inset-x-auto sm:right-6 sm:max-w-[420px]";

export function AccountSync() {
  const pathname = usePathname();
  const [status, setStatus] = useState<AccountStatus>({ state: "off" });
  const [notice, setNotice] = useState<NoticeState>(NO_NOTICE);

  useEffect(() => {
    const offStatus = onAccountStatus((s) => {
      setStatus(s);
      setNotice((n) => nextNotice(n, s));
    });
    const off = onPulled((report) => {
      const touched = [...report.pulled, ...report.merged].some((n) => HELD_BY_SCREENS.has(n));
      if (touched && claimSyncReload()) {
        carryNoteAcrossReload(); // what the sync just did must outlive the reload it causes
        reload();
        return;
      }
      notifyPlanChanged();
    });
    const offTabs = watchOtherTabs({ reload, refresh: notifyPlanChanged });
    void startSync();
    return () => {
      offStatus();
      off();
      offTabs();
    };
  }, []);

  const onAccountPage = (pathname ?? "").replace(/\/+$/, "") === "/sage/account";
  const text = onAccountPage ? null : noticeText(notice, status);
  return (
    // One live region, in the page from the start, so a screen reader announces what appears in it.
    <div role="status" className={text ? NOTICE : "sr-only"}>
      {text && (
        <>
          <p className="text-[13px] leading-relaxed">{text}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/sage/account"
              className="rounded-full bg-white px-4 py-1.5 text-[12px] font-semibold text-plum transition hover:bg-cream"
            >
              Account page
            </Link>
            <button
              type="button"
              onClick={() => setNotice((n) => ({ ...n, dismissed: text }))}
              className="rounded-full px-3 py-1.5 text-[12px] font-semibold text-white/75 transition hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}
