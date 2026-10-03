"use client";

import { useEffect } from "react";
import { onPulled, startSync } from "@/lib/account/client";
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
 */
const HELD_BY_SCREENS = new Set(["plan", "batchPlan", "profile"]);

export function AccountSync() {
  useEffect(() => {
    const off = onPulled((report) => {
      const touched = [...report.pulled, ...report.merged].some((n) => HELD_BY_SCREENS.has(n));
      if (touched && claimSyncReload() && typeof window.location.reload === "function") {
        window.location.reload();
        return;
      }
      notifyPlanChanged();
    });
    void startSync();
    return off;
  }, []);
  return null;
}
