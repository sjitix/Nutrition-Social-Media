"use client";

import { useEffect } from "react";
import { startSync } from "@/lib/account/client";
import { notifyPlanChanged } from "../myPlan";

/**
 * Keeps a signed-in browser mirrored to its account, on every screen. Renders nothing.
 *
 * Meant to be mounted once in the /sage layout. With no Supabase keys configured, or nobody signed
 * in, `startSync` returns at once and this costs nothing. When the first sync brings data DOWN from
 * the account, mounted screens are told to re-read through the same event every other plan change
 * uses (`notifyPlanChanged`), so a week edited on the phone appears on the laptop without a reload.
 */
export function AccountSync() {
  useEffect(() => {
    void startSync(() => notifyPlanChanged());
  }, []);
  return null;
}
