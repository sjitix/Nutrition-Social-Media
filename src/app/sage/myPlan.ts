"use client";

import { loadPlan, loadProfile, savePlan } from "@/lib/storage";
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
  const week = loadPlan();
  if (!profile || !week || !Array.isArray(week.days) || week.days.length === 0) return null;
  return { week, stats: summariseWeek(week), profile };
}

/** Build a fresh week for this profile through the real engine (server side) and persist it. */
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
  savePlan(week);
  return { week, stats: summariseWeek(week), profile };
}
