"use client";

import { useEffect } from "react";
import { carryNoteAcrossReload, onPulled, startSync, watchOtherTabs } from "@/lib/account/client";
import { claimSyncReload } from "@/lib/storage";
import { notifyPlanChanged } from "../myPlan";

/**
 * Keeps a signed-in browser mirrored to its account, on every screen. Renders nothing. Mounted once in
 * the /sage layout.
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
 */
const HELD_BY_SCREENS = new Set(["plan", "batchPlan", "profile"]);

const reload = () => {
  if (typeof window.location.reload === "function") window.location.reload();
};

export function AccountSync() {
  useEffect(() => {
    const off = onPulled((report) => {
      const touched = [...report.pulled, ...report.merged].some((n) => HELD_BY_SCREENS.has(n));
      if (touched && claimSyncReload()) {
        carryNoteAcrossReload(); // what the sync just said must outlive the reload it causes
        reload();
        return;
      }
      notifyPlanChanged();
    });
    const offTabs = watchOtherTabs({ reload, refresh: notifyPlanChanged });
    void startSync();
    return () => {
      off();
      offTabs();
    };
  }, []);
  return null;
}
