import { loadPlan, loadProfile, savePlan, saveProfile, loadBatchPlan, saveBatchPlan } from "@/lib/storage";
import { groupByAisle, type Aisle } from "@/lib/grocery";
import { summariseWeek, type WeekStats } from "./weekStats";
import type { UserProfile, WeekPlan } from "@/lib/types";

/**
 * The bridge between the shared /sage demo and a REAL person's week.
 *
 * The /sage screens render a fixed demo week on the server (demo.ts) so a first-time visitor and a
 * search crawler see a real, engine-built plan instantly. This module is the client half: once
 * someone has completed onboarding, their profile + plan live in localStorage (storage.ts, the same
 * keys the classic app writes), and these helpers surface THAT instead of the demo.
 *
 * Generation goes through /api/plan (the server engine, selectWeekFromDb behind PLAN_ENGINE=db), NOT
 * a client import of recipeDb — importing the engine here would serialise all 501 recipes into the
 * browser bundle. Only summariseWeek (a type-only, pure function) runs on the client.
 */
export interface MyWeek {
  week: WeekPlan;
  stats: WeekStats;
  profile: UserProfile;
}

/** This device's saved week, or null when the person hasn't set one up yet (→ show the demo). */
export function loadMyWeek(): MyWeek | null {
  const profile = loadProfile();
  if (!profile) return null;
  // Each mode's week is cached under its own key, so a fresh<->batch toggle is lossless.
  const week = profile.planMode === "batch" ? loadBatchPlan() : loadPlan();
  if (!week || !Array.isArray(week.days) || week.days.length === 0) return null;
  return { week, stats: summariseWeek(week), profile };
}

/** Build this profile's week through the real engine (server side) and persist it under the key for
 *  its mode (fresh -> `plan`, batch -> `batchPlan`). /api/plan dispatches fresh vs batch on planMode. */
export async function generateMyWeek(profile: UserProfile): Promise<MyWeek> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.plan) {
    throw new Error(data.error ?? "Couldn't build your week just now — is the app running?");
  }
  const week = data.plan as WeekPlan;
  if (profile.planMode === "batch") saveBatchPlan(week);
  else savePlan(week);
  return { week, stats: summariseWeek(week), profile };
}

/**
 * Flip the planning mode (fresh <-> meal-prep) and return the week to show. Persists the choice on
 * the profile; each mode's week lives under its own key, so if the target mode was already built we
 * reuse it (lossless), otherwise we build it. The caller reloads so every mounted screen re-reads it.
 */
export async function switchPlanMode(mode: "fresh" | "batch"): Promise<MyWeek | null> {
  const profile = loadProfile();
  if (!profile) return null;
  const next: UserProfile = { ...profile, planMode: mode };
  saveProfile(next);
  const cached = mode === "batch" ? loadBatchPlan() : loadPlan();
  if (cached && Array.isArray(cached.days) && cached.days.length) {
    return { week: cached, stats: summariseWeek(cached), profile: next };
  }
  return generateMyWeek(next);
}

export interface GroceryRow {
  name: string;
  quantity: string;
  count: number;
}

/**
 * The week's shopping list, deduped across the seven days and bucketed by aisle with the same tested
 * `groupByAisle` the server page uses. Pure (no engine), so it runs on the client to build the list
 * from THIS person's plan. Seven days repeat a lot of staples, so an ingredient seen N times becomes
 * one row with a ×N badge rather than N lines.
 */
export function groceriesFromWeek(week: WeekPlan): { aisle: Aisle; items: GroceryRow[] }[] {
  const seen = new Map<string, GroceryRow>();
  for (const d of week.days) {
    for (const m of d.meals) {
      for (const ing of m.ingredients) {
        const key = ing.name.trim().toLowerCase();
        const hit = seen.get(key);
        if (hit) hit.count += 1;
        else seen.set(key, { name: ing.name, quantity: ing.quantity, count: 1 });
      }
    }
  }
  return groupByAisle([...seen.values()]);
}
