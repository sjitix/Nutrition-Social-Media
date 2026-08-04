/**
 * API integration tests — hit the RUNNING dev server and assert the route behaviour.  npm run test:api
 *
 * These cover what test:engine can't: the HTTP routes. The engine is pure and unit-tested; the
 * routes add the allowlist, the one-step undo bookkeeping, and the graceful-offline handling — all
 * of which were only ever verified by hand with curl. This locks them in.
 *
 * Needs `npm run dev` running. /api/operation and /api/plan work with the model OFFLINE (the engine
 * is deterministic), and /api/assistant's offline path is BEST tested with the model down — which is
 * exactly the state while a model trains.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const PROFILE = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};

let pass = 0, fail = 0;
const fails = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; fails.push(`${label}${detail ? "  — " + detail : ""}`); console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

async function main() {
  // A real plan from the DB engine (works with the model offline) — gives real recipe names.
  const planRes = await post("/api/plan", PROFILE);
  check("/api/plan returns a 7-day plan with the model offline", planRes.status === 200 && planRes.json?.plan?.days?.length === 7,
    `status ${planRes.status}`);
  const plan = planRes.json?.plan ?? { days: [] };
  const firstMeal = plan.days?.[0]?.meals?.[0];
  const dishName = firstMeal?.name ?? "Veggie Omelette";
  const day0 = plan.days?.[0]?.day ?? "Monday";
  const type0 = firstMeal?.type ?? "breakfast";

  // ---- /api/operation allowlist ----
  const rated = await post("/api/operation", { profile: PROFILE, plan, operation: { tool: "rate_meal", dish: dishName, rating: 5 } });
  check("operation: rate_meal is allowed (200)", rated.status === 200, `status ${rated.status}`);
  check("operation: rate_meal stores the rating", rated.json?.profile?.mealRatings?.[0]?.rating === 5);
  check("operation: rate_meal returns an undo snapshot", !!rated.json?.previous?.label);

  const denied = await post("/api/operation", { profile: PROFILE, plan, operation: { tool: "update_profile", budget: "low" } });
  check("operation: update_profile is REJECTED (400)", denied.status === 400, `status ${denied.status}`);
  const denied2 = await post("/api/operation", { profile: PROFILE, plan, operation: { tool: "regenerate_week" } });
  check("operation: regenerate_week is REJECTED (400)", denied2.status === 400, `status ${denied2.status}`);

  const missing = await post("/api/operation", { profile: PROFILE, operation: { tool: "rate_meal", rating: 5 } });
  check("operation: missing plan is a 400, not a crash", missing.status === 400, `status ${missing.status}`);

  // ---- undo round-trip ----
  const back = await post("/api/operation", {
    profile: rated.json.profile, plan, operation: { tool: "undo" }, previous: rated.json.previous,
  });
  check("operation: undo restores the rated profile", (back.json?.profile?.mealRatings ?? []).length === 0, JSON.stringify(back.json?.profile?.mealRatings));
  check("operation: undo names what it reversed", /saved your rating/i.test(back.json?.reply ?? ""), back.json?.reply);
  check("operation: undo spends the snapshot (no new previous)", !back.json?.previous);

  // ---- pin / unpin ----
  const pinned = await post("/api/operation", { profile: PROFILE, plan, operation: { tool: "lock_meal", day: day0, mealType: type0 } });
  check("operation: lock_meal pins the slot", pinned.json?.profile?.lockedMeals?.[0]?.day === day0, JSON.stringify(pinned.json?.profile?.lockedMeals));
  const unpinned = await post("/api/operation", { profile: pinned.json.profile, plan, operation: { tool: "unlock_meal", day: day0, mealType: type0 } });
  check("operation: unlock_meal removes the pin", (unpinned.json?.profile?.lockedMeals ?? []).length === 0);

  // ---- scale_portions ----
  const scaled = await post("/api/operation", { profile: PROFILE, plan, operation: { tool: "scale_portions", day: day0, portionChange: "bigger" } });
  const before = plan.days[0].meals.reduce((s, m) => s + m.calories, 0);
  const after = scaled.json?.plan?.days?.[0]?.meals?.reduce((s, m) => s + m.calories, 0) ?? 0;
  check("operation: scale_portions bigger adds calories", after > before, `${before} -> ${after}`);

  // ---- weekly_report (read-only, deterministic) ----
  const report = await post("/api/operation", { profile: PROFILE, plan, operation: { tool: "weekly_report" } });
  check("operation: weekly_report returns the averages", /average/i.test(report.json?.reply ?? ""), (report.json?.reply ?? "").slice(0, 60));

  // ---- /api/assistant offline handling (model is down during training) ----
  const chat = await post("/api/assistant", { profile: PROFILE, plan, history: [{ role: "user", text: "make it cheaper" }] });
  if (chat.status === 200) {
    // Model happens to be UP — skip the offline assertions, just note it.
    console.log("NOTE  assistant is UP — skipping the offline-path assertions");
  } else {
    check("assistant offline: responds 503, not 500/raw", chat.status === 503, `status ${chat.status}`);
    check("assistant offline: sets offline:true", chat.json?.offline === true);
    check("assistant offline: friendly message, NOT a raw provider error", /rate, pin/i.test(chat.json?.error ?? "") && !/lms load|No models loaded/i.test(chat.json?.error ?? ""), chat.json?.error);
  }

  // ---- /api/import (Phase 2) — the network-free paths (no real site is fetched) ----
  // A missing / non-string url is a 400 with a plain-English ask, not a crash.
  const noUrl = await post("/api/import", {});
  check("import: missing url -> 400", noUrl.status === 400, `status ${noUrl.status}`);
  const badType = await post("/api/import", { url: 123 });
  check("import: non-string url -> 400", badType.status === 400, `status ${badType.status}`);
  // SSRF guard: a private/loopback or non-url host is rejected BEFORE any fetch — a 422 with the
  // guard's message, never an attempt to reach it. This is the security-critical route test.
  const ssrf = await post("/api/import", { url: "http://localhost:3000/secret" });
  check("import: blocks localhost (SSRF) -> 422", ssrf.status === 422, `status ${ssrf.status}`);
  check("import: SSRF rejection is the guard message, no fetch attempted", /public recipe link/i.test(ssrf.json?.error ?? ""), ssrf.json?.error);
  const notUrl = await post("/api/import", { url: "not a url at all" });
  check("import: a non-url is rejected -> 422", notUrl.status === 422, `status ${notUrl.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.log("  " + f); process.exit(1); }
}

main().catch((e) => { console.error("test-api crashed:", e.message); process.exit(1); });
