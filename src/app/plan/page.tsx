"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarIcon,
  CartIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  CompassIcon,
  HomeIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  StarIcon,
  Wordmark,
  XIcon,
  ZapIcon,
} from "@/components/icons";
import { EXPLORE_RECIPES } from "@/lib/recipes";
import {
  loadChat,
  loadPlan,
  loadProfile,
  saveChat,
  savePlan,
  saveProfile,
} from "@/lib/storage";
import { DAYS, type ChatMessage, type Meal, type Operation, type PlanSnapshot, type UserProfile, type WeekPlan } from "@/lib/types";

type View = "home" | "week" | "explore" | "groceries" | "assistant";

function todayName(): (typeof DAYS)[number] {
  return DAYS[(new Date().getDay() + 6) % 7];
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Rough per-ingredient weekly grocery cost, matched by keyword. Prices are the
// cost of ONE weekly purchase of that ingredient — a pack of chicken or a bag of
// rice covers several meals (leftovers/bulk), so cost is per-week, not per-use.
// Pantry staples (oil, spices, sauces) are counted cheap. Estimates only.
const PRICE_MAP: [RegExp, number][] = [
  [/protein powder/, 2.5],
  [/smoked salmon|smoked trout|smoked mackerel/, 3.5],
  [/salmon|shrimp|prawn/, 4.5],
  [/steak|beef/, 4],
  [/cod|trout|mackerel|white fish/, 3.5],
  [/chicken|turkey|pork|sausage/, 3.5],
  [/tuna/, 1],
  [/egg/, 1.8],
  [/tofu|tempeh|edamame/, 1.5],
  [/greek yogurt|yogurt|feta|parmesan|mozzarella|cheddar|ricotta|goat cheese|halloumi|cream cheese|cottage cheese/, 1.8],
  [/milk/, 1],
  [/chickpea|black bean|kidney bean|cannellini|lentil|\bbeans?\b|hummus|falafel/, 0.9],
  [/quinoa/, 1.5],
  [/oat|bulgur|couscous|rice|pasta|penne|orzo|noodle|soba|bread|bagel|tortilla|wrap|granola|muesli|panko|flour/, 1],
  [/avocado/, 1.2],
  [/berr|blueberr|raspberr|mango/, 2],
  [/spinach|kale|broccoli|asparagus|cauliflower|brussels|bok choy|green bean|greens|cabbage|mushroom|eggplant|portobello|rocket|romaine/, 0.9],
  [/pepper|zucchini|tomato|carrot|onion|cucumber|sweet potato|potato|corn|peas|beetroot|sprouts|lettuce|apple|banana/, 0.6],
  [/lemon|lime|garlic|parsley|chives|ginger|cilantro|herb/, 0.3],
  [/almond butter|peanut butter|almond|walnut|pecan|peanut|cashew|\bnut/, 1.5],
  [/chia|flax|pumpkin seed|hemp|sesame/, 1],
  [/tahini|pesto|miso|kimchi/, 1],
  [/olive oil|sesame oil|avocado oil|\boil\b/, 0.3],
  [/honey|maple/, 1],
  [/soy|teriyaki|salsa|sriracha|harissa|enchilada|buffalo|horseradish|dressing|tikka|masala|curry|cajun|fajita|shawarma|taco|spice|paprika|cumin|cinnamon|turmeric|cocoa|matcha|salt|sauce/, 0.5],
];

function estimatePrice(name: string, occurrences: number): number {
  const n = name.toLowerCase();
  let base = 1;
  for (const [re, price] of PRICE_MAP) {
    if (re.test(n)) {
      base = price;
      break;
    }
  }
  // One pack usually covers the week; only buy a second for very heavy use.
  const packs = occurrences >= 7 ? 2 : 1;
  return Math.round(base * packs * 2) / 2;
}

export default function PlanPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [view, setView] = useState<View>("home");
  const [detail, setDetail] = useState<Meal | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // One step of history for "undo". Deliberately not persisted: after a reload there is no last
  // change to take back, and offering one would be a lie.
  const [previous, setPrevious] = useState<PlanSnapshot | undefined>(undefined);
  // A brief confirmation line after a direct action (rating a meal, undo). Auto-clears.
  const [toast, setToast] = useState<string | null>(null);
  // The day the open meal sits on, when it's a plan meal. Undefined for an Explore recipe, which is
  // on no day and can't be pinned. Pinning is slot-based (day + mealType), unlike rating.
  const [detailDay, setDetailDay] = useState<string | undefined>(undefined);
  // The deterministic "how your week looks" note (averages + nutrient gaps), computed by the engine
  // and shown on Home. No model — it's just facts about the current plan, so it works while v8 trains.
  const [weekReport, setWeekReport] = useState<string | null>(null);
  // The fluid target, shown on Home only once we know a body weight (from onboarding or compute_targets).
  const [hydration, setHydration] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = loadProfile();
    const w = loadPlan();
    if (!p || !w) {
      router.replace("/onboarding");
      return;
    }
    setProfile(p);
    setPlan(w);
    setChat(loadChat());
  }, [router]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, thinking, view]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Recompute the weekly review whenever the plan or profile changes. Deterministic endpoint, no
  // model — so the Home coach card is live even while the assistant is offline.
  useEffect(() => {
    if (!profile || !plan || plan.days.length === 0) {
      setWeekReport(null);
      return;
    }
    let cancelled = false;
    fetch("/api/operation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, plan, operation: { tool: "weekly_report" } }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.reply) setWeekReport(d.reply);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile, plan]);

  // Fluid target — only when we know a weight. Recomputes if the stored weight changes.
  useEffect(() => {
    if (!profile?.bodyStats?.weightKg || !plan) {
      setHydration(null);
      return;
    }
    let cancelled = false;
    fetch("/api/operation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, plan, operation: { tool: "hydration" } }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.reply) setHydration(d.reply);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile, plan]);

  const groceries = useMemo(() => {
    if (!plan) return [];
    const map = new Map<string, { name: string; quantities: string[] }>();
    for (const day of plan.days) {
      for (const meal of day.meals) {
        for (const ing of meal.ingredients) {
          const key = ing.name.trim().toLowerCase();
          const entry = map.get(key) ?? { name: ing.name, quantities: [] };
          entry.quantities.push(ing.quantity);
          map.set(key, entry);
        }
      }
    }
    return [...map.values()]
      .map((e) => ({ ...e, price: estimatePrice(e.name, e.quantities.length) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [plan]);

  const groceriesTotal = useMemo(
    () => groceries.reduce((s, g) => s + g.price, 0),
    [groceries],
  );

  const weekStats = useMemo(() => {
    if (!plan || plan.days.length === 0) return { kcal: 0, protein: 0 };
    const kcal = plan.days.reduce(
      (s, d) => s + d.meals.reduce((m, x) => m + x.calories, 0),
      0,
    );
    const protein = plan.days.reduce(
      (s, d) => s + d.meals.reduce((m, x) => m + x.proteinGrams, 0),
      0,
    );
    return {
      kcal: Math.round(kcal / plan.days.length),
      protein: Math.round(protein / plan.days.length),
    };
  }, [plan]);

  function addRecipeToToday(recipeName: string, meal: Meal) {
    if (!plan || !profile) return;
    const day = todayName();
    const next: WeekPlan = {
      ...plan,
      days: plan.days.map((d) =>
        d.day === day ? { ...d, meals: [...d.meals, meal] } : d,
      ),
    };
    // Every path that changes the plan owes `undo` a snapshot. Without this, adding a recipe here
    // and then saying "undo" in chat restores whatever the last CHAT change was — a plan the user
    // never asked to come back.
    setPrevious({ plan, profile, label: `added ${meal.name} to ${day}` });
    setPlan(next);
    savePlan(next);
    setAdded(new Set(added).add(recipeName));
  }

  // A direct action — rate, pin, undo — goes to /api/operation, NOT the assistant. No language
  // model needed to understand a button, and it keeps working while the model is offline.
  async function runOperation(operation: Operation) {
    if (!profile || !plan) return;
    try {
      const res = await fetch("/api/operation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, plan, operation, previous }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't do that.");
      if (data.profile) { setProfile(data.profile); saveProfile(data.profile); }
      if (data.plan) {
        setPlan(data.plan);
        savePlan(data.plan);
        // If the drawer is open on a plan meal, refresh it from the new plan — otherwise resizing a
        // portion leaves the drawer showing the old calories until you close and reopen it.
        if (detail && detailDay) {
          const refreshed = (data.plan as WeekPlan).days
            .find((d) => d.day === detailDay)?.meals.find((m) => m.type === detail.type);
          if (refreshed) setDetail(refreshed);
        }
      }
      setPrevious(data.previous ?? undefined);
      if (data.planChanged) setChecked(new Set());
      if (data.reply) setToast(data.reply);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Couldn't do that.");
    }
  }

  const ratingFor = (name: string) =>
    profile?.mealRatings?.find((r) => r.name.toLowerCase() === name.toLowerCase())?.rating ?? 0;

  // Open the meal drawer. `day` is passed for a plan meal (enables pinning) and omitted for an
  // Explore recipe. Always set together so the drawer never shows a pin for the wrong meal.
  function openMeal(meal: Meal, day?: string) {
    setDetail(meal);
    setDetailDay(day);
  }
  function closeDetail() {
    setDetail(null);
    setDetailDay(undefined);
  }
  const isPinned = (day: string | undefined, mealType: string) =>
    !!day && !!profile?.lockedMeals?.some((l) => l.day === day && l.mealType === mealType);

  async function regeneratePlan() {
    if (!profile || regenerating) return;
    setRegenError(null);
    setRegenerating(true);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't regenerate the plan.");
      if (plan) setPrevious({ plan, profile, label: "rebuilt your week" });
      setPlan(data.plan);
      savePlan(data.plan);
      setChecked(new Set());
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Couldn't regenerate the plan.");
    } finally {
      setRegenerating(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || thinking || !profile || !plan) return;
    setChatError(null);
    const history: ChatMessage[] = [...chat, { role: "user", text }];
    setChat(history);
    setInput("");
    setThinking(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `previous` carries the state from before the last change, so "undo" can restore it.
        // The server keeps no state, so this one-step history lives on the client.
        body: JSON.stringify({ profile, plan, history, previous }),
      });
      const data = await res.json();
      // The model being offline isn't an error the user caused — it's a state (right now, it's
      // retraining). Answer in-conversation with what still works, rather than a red banner.
      if (res.status === 503 && data.offline) {
        const offlineChat: ChatMessage[] = [...history, { role: "assistant", text: data.error }];
        setChat(offlineChat);
        saveChat(offlineChat);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      const newChat: ChatMessage[] = [
        ...history,
        { role: "assistant", text: data.reply },
      ];
      setChat(newChat);
      saveChat(newChat);
      if (data.plan) {
        setPlan(data.plan);
        savePlan(data.plan);
      }
      if (data.profile) {
        setProfile(data.profile);
        saveProfile(data.profile);
      }
      setPrevious(data.previous ?? undefined);
      if (data.planChanged) setChecked(new Set());
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setThinking(false);
    }
  }

  function resetChat() {
    setChat([]);
    saveChat([]);
    setChatError(null);
    setInput("");
  }

  if (!plan || !profile) {
    return (
      <main className="flex min-h-screen items-center justify-center text-mut">
        Loading your plan…
      </main>
    );
  }

  const today = plan.days.find((d) => d.day === todayName()) ?? plan.days[0];
  const tonight =
    today?.meals.find((m) => m.type === "dinner") ?? today?.meals[0] ?? null;
  const todayKcal = today?.meals.reduce((s, m) => s + m.calories, 0) ?? 0;
  const targetKcal = profile.targetCalories || 2000;

  const NAV: { key: View; label: string; icon: React.ReactNode }[] = [
    { key: "home", label: "Home", icon: <HomeIcon /> },
    { key: "week", label: "My week", icon: <CalendarIcon /> },
    { key: "explore", label: "Explore", icon: <CompassIcon /> },
    { key: "groceries", label: "Groceries", icon: <CartIcon /> },
    { key: "assistant", label: "Assistant", icon: <ChatIcon /> },
  ];

  return (
    <div className="flex min-h-screen">
      {/* ===== Sidebar (The Shelf) ===== */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col bg-plum-deep p-4 text-white/80 md:flex">
        <div className="px-2 py-2">
          <Wordmark light />
        </div>
        <nav className="mt-4 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                view === n.key
                  ? "bg-plum-mid font-semibold text-white"
                  : "hover:bg-plum-mid/50"
              }`}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <div className="mt-8 px-3 text-[10px] font-bold tracking-widest text-white/40 uppercase">
          Plan
        </div>
        <div className="mt-2 space-y-1 px-3 text-sm text-white/60">
          <p className="truncate">Week of {new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" })}</p>
        </div>
        <Link
          href="/onboarding"
          className="mt-auto rounded-lg border border-white/20 px-3 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-plum-mid"
        >
          New plan
        </Link>
      </aside>

      {/* mobile top nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-white py-2 md:hidden">
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => setView(n.key)}
            className={`flex flex-col items-center gap-1 rounded-lg px-3 py-1 text-[10px] font-semibold ${
              view === n.key ? "text-vio-deep" : "text-mut"
            }`}
          >
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>

      {/* ===== Main ===== */}
      <main className="flex min-h-screen w-full flex-col pb-20 md:ml-56 md:pb-0">
        <div className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col px-6 py-8">
          {/* ---------- HOME ---------- */}
          {view === "home" && (
            <>
              <h1 className="font-display text-3xl font-bold tracking-tight">
                {greeting()}, Ana
              </h1>
              <p className="mt-1 text-sm text-mut">{plan.weekSummary}</p>

              {today && (
                <div className="mt-6 grid gap-5 lg:grid-cols-[1.5fr_1fr]">
                  {/* Today agenda */}
                  <div className="rounded-3xl bg-white p-6 card-shadow">
                    <div className="flex items-start justify-between">
                      <p className="text-[11px] font-bold tracking-widest text-vio-deep uppercase">
                        Today · {today.day}
                      </p>
                      {tonight && (
                        <button
                          onClick={() => openMeal(tonight, today.day)}
                          className="flex items-center gap-1.5 rounded-full bg-vio px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-vio-deep"
                        >
                          <PlayIcon className="h-3 w-3" /> Start cooking
                        </button>
                      )}
                    </div>

                    <div className="mt-5 flex items-center gap-5">
                      <svg viewBox="0 0 100 100" className="h-24 w-24 flex-none">
                        <circle cx="50" cy="50" r="42" fill="none" stroke="var(--color-lav)" strokeWidth="9" />
                        <circle
                          cx="50"
                          cy="50"
                          r="42"
                          fill="none"
                          stroke="var(--color-vio)"
                          strokeWidth="9"
                          strokeLinecap="round"
                          strokeDasharray={2 * Math.PI * 42}
                          strokeDashoffset={2 * Math.PI * 42 * (1 - Math.min(1, todayKcal / targetKcal))}
                          transform="rotate(-90 50 50)"
                        />
                      </svg>
                      <div>
                        <p className="font-display text-3xl font-bold tabular-nums">
                          {todayKcal.toLocaleString()}
                        </p>
                        <p className="text-xs text-mut">
                          of {targetKcal.toLocaleString()} kcal target
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 border-t border-line">
                      {today.meals.map((meal, i) => (
                        <button
                          key={i}
                          onClick={() => openMeal(meal, today.day)}
                          className="flex w-full items-center justify-between gap-4 border-b border-line py-3.5 text-left transition hover:opacity-70"
                        >
                          <div className="min-w-0">
                            <p className="text-[9px] font-bold tracking-wider text-vio-deep uppercase">
                              {meal.type}
                            </p>
                            <p className="mt-0.5 text-sm font-semibold leading-snug">{meal.name}</p>
                            <p className="mt-1 text-[11px] text-mut tabular-nums">
                              P {meal.proteinGrams} · C {meal.carbsGrams} · F {meal.fatGrams}
                            </p>
                          </div>
                          <div className="flex-none text-right">
                            <p className="text-sm font-bold text-vio-deep tabular-nums">
                              {meal.calories} kcal
                            </p>
                            {meal.timeMinutes ? (
                              <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-mut tabular-nums">
                                <ClockIcon className="h-3 w-3" /> {meal.timeMinutes} min
                              </p>
                            ) : null}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Week rail */}
                  <div className="rounded-3xl bg-white p-4 card-shadow">
                    <div className="flex items-baseline justify-between px-2 pb-3">
                      <h3 className="font-semibold">This week</h3>
                      <span className="text-xs text-mut">
                        avg {weekStats.kcal.toLocaleString()} kcal
                      </span>
                    </div>
                    <div className="space-y-1">
                      {plan.days.map((d) => {
                        const k = d.meals.reduce((s, m) => s + m.calories, 0);
                        const isToday = d.day === today.day;
                        return (
                          <button
                            key={d.day}
                            onClick={() => setView("week")}
                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                              isToday ? "bg-lav" : "hover:bg-bgsoft"
                            }`}
                          >
                            <span className="w-9 flex-none text-sm font-bold">
                              {d.day.slice(0, 3)}
                            </span>
                            <span className="flex-1 truncate text-xs text-mut">
                              {d.meals.map((m) => m.name).join(" · ")}
                            </span>
                            <span className="flex-none text-xs font-bold tabular-nums">
                              {k.toLocaleString()}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Coach card — the weekly review a nutritionist would give, computed from the plan.
                  Deterministic, so it's here whether or not the chat model is up. */}
              {weekReport && (
                <div className="mt-6 rounded-3xl bg-white p-6 card-shadow">
                  <div className="flex items-center gap-2">
                    <ZapIcon className="h-4 w-4 text-vio-deep" />
                    <h3 className="font-semibold">How your week looks</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-mut">{weekReport}</p>
                  {hydration && (
                    <p className="mt-3 border-t border-line pt-3 text-sm leading-relaxed text-mut">
                      {hydration}
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/* ---------- WEEK (The Board) ---------- */}
          {view === "week" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between">
                <h1 className="font-display text-3xl font-bold tracking-tight">
                  Your week
                </h1>
                <button
                  onClick={() => setView("assistant")}
                  className="flex items-center gap-2 rounded-full bg-vio px-4 py-2 text-sm font-bold text-white transition hover:bg-vio-deep"
                >
                  <ZapIcon className="h-3.5 w-3.5" /> Ask AI to edit
                </button>
              </div>
              <div className="mt-6 flex min-h-0 flex-col gap-4 lg:h-[calc(100vh-10rem)] lg:flex-row">
                {/* Timetable — fills space; scrolls when narrow */}
                <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
                  <div
                    className="grid h-full min-w-[900px] gap-2"
                  style={{
                    gridTemplateColumns: "80px repeat(7, minmax(140px, 1fr))",
                    gridTemplateRows: `auto repeat(${
                      (["breakfast", "lunch", "dinner", "snack"] as const).filter((t) =>
                        plan.days.some((d) => d.meals.some((m) => m.type === t)),
                      ).length
                    }, minmax(0, 1fr))`,
                  }}
                >
                  {/* header row */}
                  <div />
                  {plan.days.map((day) => {
                    const kcal = day.meals.reduce((s, m) => s + m.calories, 0);
                    const isToday = day.day === todayName();
                    return (
                      <div key={day.day} className="px-1 pb-1">
                        <div
                          className={`text-sm font-bold ${isToday ? "text-vio-deep" : ""}`}
                        >
                          {day.day.slice(0, 3)}
                        </div>
                        <div className="text-[11px] text-mut tabular-nums">
                          {kcal.toLocaleString()} kcal
                        </div>
                      </div>
                    );
                  })}

                  {/* one row per meal type present in the week */}
                  {(["breakfast", "lunch", "dinner", "snack"] as const)
                    .filter((t) => plan.days.some((d) => d.meals.some((m) => m.type === t)))
                    .map((type) => (
                      <Fragment key={type}>
                        <div className="flex items-center text-[10px] font-bold tracking-wide text-mut uppercase">
                          {type}
                        </div>
                        {plan.days.map((day) => {
                          const meal = day.meals.find((m) => m.type === type);
                          if (!meal) {
                            return (
                              <div
                                key={day.day}
                                className="rounded-xl border border-dashed border-line"
                              />
                            );
                          }
                          return (
                            <button
                              key={day.day}
                              onClick={() => openMeal(meal, day.day)}
                              className="flex flex-col overflow-hidden rounded-xl bg-white p-3 text-left transition card-shadow hover:-translate-y-0.5"
                            >
                              <p className="line-clamp-2 text-sm font-semibold leading-snug">
                                {meal.name}
                              </p>
                              <p className="mt-2 flex items-center gap-1 text-[11px] text-mut tabular-nums">
                                <span className="font-bold text-vio-deep">{meal.calories}</span>{" "}
                                kcal
                                {meal.timeMinutes ? (
                                  <>
                                    <span className="mx-0.5">·</span>
                                    <ClockIcon className="h-3 w-3" /> {meal.timeMinutes}m
                                  </>
                                ) : null}
                              </p>
                              <p className="mt-auto pt-2 text-[11px] text-mut tabular-nums">
                                P {meal.proteinGrams} · C {meal.carbsGrams} · F {meal.fatGrams}
                              </p>
                            </button>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                </div>

                {/* Whole-week shopping list + estimated cost + regenerate */}
                <aside className="flex flex-none flex-col overflow-hidden rounded-2xl bg-white p-4 card-shadow lg:w-[440px]">
                  <button
                    onClick={() => void regeneratePlan()}
                    disabled={regenerating}
                    className="flex items-center justify-center gap-2 rounded-full bg-vio px-4 py-2.5 text-sm font-bold text-white transition hover:bg-vio-deep disabled:opacity-60"
                  >
                    <RefreshIcon className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
                    {regenerating ? "Regenerating…" : "Regenerate plan"}
                  </button>
                  {regenError && <p className="mt-2 text-xs text-red-600">{regenError}</p>}

                  <div className="mt-4 flex items-baseline justify-between">
                    <h3 className="font-semibold">Shopping list</h3>
                    <span className="text-xs text-mut">{groceries.length} items</span>
                  </div>
                  <div className="mt-2 min-h-0 flex-1 columns-2 gap-x-6 overflow-y-auto pr-1">
                    {groceries.map((g) => (
                      <div
                        key={g.name}
                        className="flex break-inside-avoid items-center justify-between gap-2 py-0.5 text-sm"
                      >
                        <span className="truncate">{g.name}</span>
                        <span className="flex-none text-mut tabular-nums">${g.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                    <span className="text-sm font-bold">Estimated total</span>
                    <span className="font-display text-lg font-bold text-vio-deep tabular-nums">
                      ${groceriesTotal.toFixed(2)}
                    </span>
                  </div>
                </aside>
              </div>
            </div>
          )}

          {/* ---------- EXPLORE (The Wall) ---------- */}
          {view === "explore" && (
            <>
              <h1 className="font-display text-3xl font-bold tracking-tight">Explore</h1>
              <p className="mt-1 text-sm text-mut">
                Ideas for your week — every recipe drops straight into today&rsquo;s plan.
              </p>
              <div className="mt-6 columns-2 gap-4 lg:columns-3">
                {EXPLORE_RECIPES.map((r) => {
                  const isAdded = added.has(r.meal.name);
                  return (
                    <div
                      key={r.meal.name}
                      className="mb-4 break-inside-avoid overflow-hidden rounded-2xl bg-white card-shadow"
                    >
                      <button onClick={() => openMeal(r.meal)} className="block w-full">
                        <div
                          className="w-full bg-cover bg-center"
                          style={{ height: r.height, backgroundImage: `url(${r.image})` }}
                        />
                      </button>
                      <div className="p-3">
                        <p className="text-sm font-bold">{r.meal.name}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <span className="rounded-full bg-lav px-2 py-0.5 text-[10px] font-bold text-vio-deep">
                            {r.meal.calories} kcal
                          </span>
                          <span className="rounded-full bg-lav px-2 py-0.5 text-[10px] font-bold text-vio-deep">
                            {r.meal.proteinGrams} g protein
                          </span>
                          {r.tag && (
                            <span className="rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold text-mint">
                              {r.tag}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => !isAdded && addRecipeToToday(r.meal.name, r.meal)}
                          className={`mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-bold transition ${
                            isAdded
                              ? "bg-mint-soft text-mint"
                              : "bg-vio text-white hover:bg-vio-deep"
                          }`}
                        >
                          {isAdded ? (
                            <>
                              <CheckIcon className="h-3 w-3" /> In your plan
                            </>
                          ) : (
                            <>
                              <PlusIcon className="h-3 w-3" /> Add to plan
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ---------- GROCERIES ---------- */}
          {view === "groceries" && (
            <>
              <h1 className="font-display text-3xl font-bold tracking-tight">Groceries</h1>
              <p className="mt-1 text-sm text-mut">
                {checked.size} of {groceries.length} items · whole week, aggregated
              </p>
              <div className="mt-6 rounded-2xl bg-white p-6 card-shadow">
                <ul className="grid gap-1 sm:grid-cols-2">
                  {groceries.map((g) => {
                    const done = checked.has(g.name);
                    return (
                      <li key={g.name}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 transition hover:bg-lav ${done ? "opacity-50" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={done}
                            onChange={() => {
                              const next = new Set(checked);
                              if (done) next.delete(g.name);
                              else next.add(g.name);
                              setChecked(next);
                            }}
                            className="mt-1 h-4 w-4 accent-vio"
                          />
                          <span className={done ? "line-through" : ""}>
                            <span className="text-sm font-medium">{g.name}</span>{" "}
                            <span className="text-xs text-mut">
                              ({g.quantities.join(" + ")})
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}

          {/* ---------- ASSISTANT ---------- */}
          {view === "assistant" && (
            <>
              <div className="flex max-w-3xl items-start justify-between">
                <div>
                  <h1 className="font-display text-3xl font-bold tracking-tight">Assistant</h1>
                  <p className="mt-1 text-sm text-mut">
                    Ask for changes — the plan updates itself.
                  </p>
                </div>
                {chat.length > 0 && (
                  <button
                    onClick={resetChat}
                    className="mt-1 flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-mut transition hover:border-vio hover:text-vio-deep"
                  >
                    <RefreshIcon className="h-3 w-3" /> Clear chat
                  </button>
                )}
              </div>
              <div className="mt-6 flex h-[62vh] max-w-3xl flex-col rounded-2xl bg-white card-shadow">
                <div className="flex-1 space-y-4 overflow-y-auto p-6">
                  {chat.length === 0 && (
                    <div className="text-sm text-mut">
                      <p className="font-semibold text-plum">Try:</p>
                      <ul className="mt-2 space-y-1.5">
                        {[
                          "Make Tuesday vegetarian",
                          "I don't have an oven — swap the baked meals",
                          "Make this week cheaper",
                          "More protein at breakfast",
                        ].map((s) => (
                          <li key={s}>
                            <button
                              onClick={() => setInput(s)}
                              className="rounded-full bg-lav px-3 py-1.5 text-xs font-semibold text-vio-deep transition hover:bg-vio hover:text-white"
                            >
                              {s}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {chat.map((m, i) => (
                    <div
                      key={i}
                      className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                          m.role === "user"
                            ? "rounded-br-md bg-vio text-white"
                            : "rounded-bl-md bg-lav"
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))}
                  {thinking && (
                    <div className="flex justify-start">
                      <div className="rounded-2xl rounded-bl-md bg-lav px-4 py-3 text-sm text-mut">
                        Updating your plan…
                      </div>
                    </div>
                  )}
                  {chatError && (
                    <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                      {chatError}
                    </p>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendMessage();
                  }}
                  className="flex gap-2 border-t border-line p-4"
                >
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Change anything about your week…"
                    className="flex-1 rounded-full border-2 border-transparent bg-bgsoft px-5 py-3 text-sm outline-none focus:border-vio"
                  />
                  <button
                    type="submit"
                    disabled={thinking || !input.trim()}
                    className="flex items-center gap-2 rounded-full bg-vio px-5 py-3 text-sm font-bold text-white transition hover:bg-vio-deep disabled:opacity-50"
                  >
                    <SendIcon className="h-3.5 w-3.5" /> Send
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </main>

      {/* Undo the last change. Appears only when there IS one to reverse, and reaches the same
          deterministic endpoint — so it works even while the assistant model is offline. */}
      {previous && (
        <button
          onClick={() => void runOperation({ tool: "undo" } as Operation)}
          className="fixed bottom-6 left-6 z-50 flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-plum shadow-lg ring-1 ring-line transition hover:bg-bgsoft"
          title={`Undo: ${previous.label}`}
        >
          <RefreshIcon className="h-3.5 w-3.5 -scale-x-100" />
          Undo {previous.label}
        </button>
      )}

      {/* A brief confirmation after a direct action (rating, undo). */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-plum px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}

      {/* ===== Meal detail drawer ===== */}
      {detail && (
        <>
          <div
            className="fixed inset-0 z-30 bg-plum/40"
            onClick={closeDetail}
          />
          <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto bg-white shadow-2xl">
            <div className="h-20 w-full bg-gradient-to-r from-vio to-vio-deep" />
            <button
              onClick={closeDetail}
              className="absolute top-4 right-4 rounded-full bg-white/90 p-2 text-plum shadow"
              aria-label="Close"
            >
              <XIcon />
            </button>
            <div className="p-6">
              <p className="text-[11px] font-bold tracking-widest text-vio-deep uppercase">
                {detail.type}
              </p>
              <h2 className="font-display mt-1 text-2xl font-bold">{detail.name}</h2>
              <p className="mt-2 text-sm leading-relaxed text-mut">{detail.description}</p>
              {/* Rate the dish. Deterministic — goes straight to /api/operation, no assistant. A
                  5 gets it planned more often; a 1 stops it coming back (unless a slot would empty). */}
              <div className="mt-3 flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => runOperation({ tool: "rate_meal", dish: detail.name, rating: n } as Operation)}
                    className={n <= ratingFor(detail.name) ? "p-0.5 text-vio-deep" : "p-0.5 text-black/20 hover:text-vio-deep/50"}
                    aria-label={`Rate ${n} of 5`}
                    title={`Rate ${n} of 5`}
                  >
                    <StarIcon className="h-5 w-5" filled={n <= ratingFor(detail.name)} />
                  </button>
                ))}
                {ratingFor(detail.name) > 0 && (
                  <span className="ml-2 text-xs text-mut">
                    you rated this {ratingFor(detail.name)}/5
                  </span>
                )}
              </div>
              {/* Keep this meal in the same slot every week. Only for a PLAN meal (we know its day);
                  an Explore recipe has no slot to pin. Deterministic — no assistant. */}
              {detailDay && (
                <button
                  onClick={() =>
                    runOperation({
                      tool: isPinned(detailDay, detail.type) ? "unlock_meal" : "lock_meal",
                      day: detailDay,
                      mealType: detail.type,
                    } as Operation)
                  }
                  className={
                    isPinned(detailDay, detail.type)
                      ? "mt-3 flex items-center gap-1.5 rounded-full bg-vio px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-vio-deep"
                      : "mt-3 flex items-center gap-1.5 rounded-full bg-bgsoft px-3.5 py-1.5 text-xs font-bold text-plum transition hover:bg-lav"
                  }
                >
                  <PinIcon className="h-3.5 w-3.5" filled={isPinned(detailDay, detail.type)} />
                  {isPinned(detailDay, detail.type) ? "Kept every week" : "Keep every week"}
                </button>
              )}
              {/* Resize this meal's portion. Deterministic; the engine holds the day on target where
                  it can and never crosses the calorie floor. Only for a plan meal (needs a slot). */}
              {detailDay && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-xs font-semibold text-mut">Portion</span>
                  <button
                    onClick={() => runOperation({ tool: "scale_portions", day: detailDay, mealType: detail.type, portionChange: "smaller" } as Operation)}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-bgsoft text-lg font-bold text-plum transition hover:bg-lav"
                    aria-label="Smaller portion"
                    title="Smaller portion"
                  >
                    −
                  </button>
                  <button
                    onClick={() => runOperation({ tool: "scale_portions", day: detailDay, mealType: detail.type, portionChange: "bigger" } as Operation)}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-bgsoft text-lg font-bold text-plum transition hover:bg-lav"
                    aria-label="Bigger portion"
                    title="Bigger portion"
                  >
                    +
                  </button>
                </div>
              )}
              <div className="mt-4 grid grid-cols-5 gap-2 text-center">
                {[
                  [detail.calories, "kcal"],
                  [detail.proteinGrams, "protein g"],
                  [detail.carbsGrams, "carbs g"],
                  [detail.fatGrams, "fat g"],
                  [detail.timeMinutes ?? "—", "min"],
                ].map(([v, l]) => (
                  <div key={l} className="rounded-xl bg-bgsoft py-2.5">
                    <p className="font-display text-lg font-bold tabular-nums">{v}</p>
                    <p className="text-[10px] font-semibold text-mut uppercase">{l}</p>
                  </div>
                ))}
              </div>
              <h3 className="mt-6 text-sm font-bold tracking-wide uppercase">Ingredients</h3>
              <ul className="mt-2 space-y-1.5">
                {detail.ingredients.map((ing) => (
                  <li key={ing.name} className="flex justify-between text-sm">
                    <span>{ing.name}</span>
                    <span className="text-mut">{ing.quantity}</span>
                  </li>
                ))}
              </ul>
              <h3 className="mt-6 text-sm font-bold tracking-wide uppercase">Steps</h3>
              <ol className="mt-2 space-y-2">
                {detail.steps.map((s, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-lav text-[11px] font-bold text-vio-deep">
                      {i + 1}
                    </span>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
