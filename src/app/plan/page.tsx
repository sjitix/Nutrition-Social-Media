"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarIcon,
  CartIcon,
  ChatIcon,
  CheckIcon,
  CompassIcon,
  HomeIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  Wordmark,
  XIcon,
  ZapIcon,
} from "@/components/icons";
import { EXPLORE_RECIPES, gradientForMeal, imageForMeal } from "@/lib/recipes";
import {
  loadChat,
  loadPlan,
  loadProfile,
  saveChat,
  savePlan,
} from "@/lib/storage";
import { DAYS, type ChatMessage, type Meal, type UserProfile, type WeekPlan } from "@/lib/types";

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

function MealPhoto({ meal, className }: { meal: Meal; className: string }) {
  const img = imageForMeal(meal.name);
  return (
    <div
      className={`bg-cover bg-center ${className}`}
      style={
        img
          ? { backgroundImage: `url(${img})` }
          : { background: gradientForMeal(meal.name) }
      }
    />
  );
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
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [plan]);

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
    if (!plan) return;
    const day = todayName();
    const next: WeekPlan = {
      ...plan,
      days: plan.days.map((d) =>
        d.day === day ? { ...d, meals: [...d.meals, meal] } : d,
      ),
    };
    setPlan(next);
    savePlan(next);
    setAdded(new Set(added).add(recipeName));
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
        body: JSON.stringify({ profile, plan, history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      const newChat: ChatMessage[] = [
        ...history,
        { role: "assistant", text: data.reply },
      ];
      setChat(newChat);
      saveChat(newChat);
      if (data.planChanged) {
        setPlan(data.plan);
        savePlan(data.plan);
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setThinking(false);
    }
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
  const tonightImg = tonight ? imageForMeal(tonight.name) : null;

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
      <main className="w-full pb-20 md:ml-56 md:pb-8">
        <div className="mx-auto max-w-4xl px-5 py-8">
          {/* ---------- HOME ---------- */}
          {view === "home" && (
            <>
              <h1 className="font-display text-3xl font-bold tracking-tight">
                {greeting()}, Ana
              </h1>
              <p className="mt-1 text-sm text-mut">{plan.weekSummary}</p>

              {tonight && (
                <div
                  className="relative mt-6 overflow-hidden rounded-3xl p-8 text-white card-shadow"
                  style={{
                    backgroundImage: `linear-gradient(100deg, rgba(28,22,54,.92) 30%, rgba(45,36,90,.65) 60%, rgba(45,36,90,.15) 100%)${
                      tonightImg ? `, url(${tonightImg})` : ""
                    }`,
                    backgroundColor: "#2d2650",
                    backgroundSize: "cover",
                    backgroundPosition: "center 35%",
                  }}
                >
                  <p className="text-[11px] font-bold tracking-widest text-white/70 uppercase">
                    Tonight · {tonight.type}
                  </p>
                  <h2 className="font-display mt-2 text-3xl font-bold">
                    {tonight.name}
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-white/80">
                    {tonight.calories} kcal · {tonight.proteinGrams} g protein
                  </p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      onClick={() => setDetail(tonight)}
                      className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-plum transition hover:bg-lav"
                    >
                      <PlayIcon className="h-3.5 w-3.5" /> Start cooking
                    </button>
                    <button
                      onClick={() => {
                        setView("assistant");
                        setInput(`Swap tonight's ${tonight.name} for something else`);
                      }}
                      className="rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/25"
                    >
                      Swap meal
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-8 flex items-baseline justify-between">
                <h3 className="font-semibold">Today · {today?.day}</h3>
                <span className="text-xs text-mut">
                  week avg {weekStats.kcal} kcal · {weekStats.protein} g protein / day
                </span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {today?.meals.map((meal, i) => (
                  <button
                    key={i}
                    onClick={() => setDetail(meal)}
                    className="flex items-center gap-3 overflow-hidden rounded-xl bg-white text-left transition card-shadow hover:-translate-y-0.5"
                  >
                    <MealPhoto meal={meal} className="h-14 w-14 flex-none" />
                    <div className="min-w-0 py-2 pr-3">
                      <p className="text-[10px] font-bold tracking-wider text-vio-deep uppercase">
                        {meal.type}
                      </p>
                      <p className="truncate text-sm font-semibold">{meal.name}</p>
                      <p className="text-xs text-mut">{meal.calories} kcal</p>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ---------- WEEK (The Board) ---------- */}
          {view === "week" && (
            <>
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
              <div className="mt-6 overflow-x-auto pb-4">
                <div className="flex gap-3" style={{ minWidth: "980px" }}>
                  {plan.days.map((day) => {
                    const kcal = day.meals.reduce((s, m) => s + m.calories, 0);
                    return (
                      <div key={day.day} className="w-36 flex-none">
                        <div className="flex items-baseline justify-between px-1 pb-2">
                          <span className="text-sm font-bold">{day.day.slice(0, 3)}</span>
                          <span className="text-[11px] text-mut tabular-nums">
                            {kcal.toLocaleString()} kcal
                          </span>
                        </div>
                        <div className="space-y-2">
                          {day.meals.map((meal, i) => (
                            <button
                              key={i}
                              onClick={() => setDetail(meal)}
                              className="w-full overflow-hidden rounded-xl bg-white text-left transition card-shadow hover:-translate-y-0.5"
                            >
                              <MealPhoto meal={meal} className="h-16 w-full" />
                              <div className="p-2.5">
                                <p className="text-[9px] font-bold tracking-wider text-vio-deep uppercase">
                                  {meal.type}
                                </p>
                                <p className="mt-0.5 line-clamp-2 text-xs font-semibold">
                                  {meal.name}
                                </p>
                                <p className="mt-1 text-[11px] text-mut">
                                  {meal.calories} kcal
                                </p>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
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
                      <button onClick={() => setDetail(r.meal)} className="block w-full">
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
              <h1 className="font-display text-3xl font-bold tracking-tight">Assistant</h1>
              <p className="mt-1 text-sm text-mut">
                Ask for changes — the plan updates itself.
              </p>
              <div className="mt-6 flex h-[62vh] flex-col rounded-2xl bg-white card-shadow">
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

      {/* ===== Meal detail drawer ===== */}
      {detail && (
        <>
          <div
            className="fixed inset-0 z-30 bg-plum/40"
            onClick={() => setDetail(null)}
          />
          <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto bg-white shadow-2xl">
            <MealPhoto meal={detail} className="h-52 w-full" />
            <button
              onClick={() => setDetail(null)}
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
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                {[
                  [detail.calories, "kcal"],
                  [detail.proteinGrams, "protein g"],
                  [detail.carbsGrams, "carbs g"],
                  [detail.fatGrams, "fat g"],
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
