"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadChat,
  loadPlan,
  loadProfile,
  saveChat,
  savePlan,
} from "@/lib/storage";
import type { ChatMessage, Meal, UserProfile, WeekPlan } from "@/lib/types";

type Tab = "week" | "groceries" | "assistant";

const MEAL_ICONS: Record<Meal["type"], string> = {
  breakfast: "🌅",
  lunch: "🍲",
  dinner: "🌙",
  snack: "🍎",
};

export default function PlanPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [tab, setTab] = useState<Tab>("week");
  const [openMeal, setOpenMeal] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // assistant state
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
  }, [chat, thinking]);

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
      <main className="flex min-h-screen items-center justify-center text-forest-light">
        Loading…
      </main>
    );
  }

  const tabClass = (t: Tab) =>
    `rounded-full px-5 py-2 text-sm font-semibold transition ${
      tab === t ? "bg-forest text-cream" : "bg-white text-forest hover:bg-leaf-soft"
    }`;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Your week 🥗</h1>
          <p className="mt-1 max-w-xl text-sm text-forest-light">{plan.weekSummary}</p>
        </div>
        <Link
          href="/onboarding"
          className="rounded-xl border-2 border-forest px-4 py-2 text-sm font-semibold transition hover:bg-leaf-soft"
        >
          New plan
        </Link>
      </header>

      <nav className="mt-6 flex gap-2">
        <button className={tabClass("week")} onClick={() => setTab("week")}>
          📅 Week
        </button>
        <button className={tabClass("groceries")} onClick={() => setTab("groceries")}>
          🛒 Groceries
        </button>
        <button className={tabClass("assistant")} onClick={() => setTab("assistant")}>
          💬 Assistant
        </button>
      </nav>

      {tab === "week" && (
        <div className="mt-6 space-y-6">
          {plan.days.map((day) => {
            const kcal = day.meals.reduce((s, m) => s + m.calories, 0);
            const protein = day.meals.reduce((s, m) => s + m.proteinGrams, 0);
            return (
              <section key={day.day} className="rounded-2xl bg-white p-5 shadow-sm">
                <div className="flex items-baseline justify-between">
                  <h2 className="font-display text-xl font-bold">{day.day}</h2>
                  <span className="text-sm text-forest-light">
                    {kcal} kcal · {protein} g protein
                  </span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {day.meals.map((meal, i) => {
                    const id = `${day.day}-${i}`;
                    const open = openMeal === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setOpenMeal(open ? null : id)}
                        className={`rounded-xl border-2 p-4 text-left transition ${
                          open ? "border-leaf bg-leaf-soft" : "border-transparent bg-cream hover:border-leaf/40"
                        }`}
                      >
                        <div className="text-xs font-semibold tracking-wide text-forest-light uppercase">
                          {MEAL_ICONS[meal.type]} {meal.type}
                        </div>
                        <div className="mt-1 font-semibold">{meal.name}</div>
                        <div className="mt-1 text-xs text-forest-light">
                          {meal.calories} kcal · P{meal.proteinGrams} C{meal.carbsGrams} F{meal.fatGrams}
                        </div>
                        {open && (
                          <div className="mt-3 space-y-2 text-sm">
                            <p className="text-forest-light">{meal.description}</p>
                            <div>
                              <div className="font-semibold">Ingredients</div>
                              <ul className="mt-1 list-inside list-disc text-forest-light">
                                {meal.ingredients.map((ing) => (
                                  <li key={ing.name}>
                                    {ing.name} — {ing.quantity}
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <div className="font-semibold">Steps</div>
                              <ol className="mt-1 list-inside list-decimal text-forest-light">
                                {meal.steps.map((s, j) => (
                                  <li key={j}>{s}</li>
                                ))}
                              </ol>
                            </div>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {tab === "groceries" && (
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="font-display text-xl font-bold">
            Grocery list <span className="text-sm font-normal text-forest-light">({groceries.length} items, whole week)</span>
          </h2>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {groceries.map((g) => {
              const done = checked.has(g.name);
              return (
                <li key={g.name}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 transition hover:bg-leaf-soft ${done ? "opacity-50" : ""}`}
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
                      className="mt-1 h-4 w-4 accent-forest"
                    />
                    <span className={done ? "line-through" : ""}>
                      <span className="font-medium">{g.name}</span>{" "}
                      <span className="text-sm text-forest-light">
                        ({g.quantities.join(" + ")})
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tab === "assistant" && (
        <div className="mt-6 flex h-[60vh] flex-col rounded-2xl bg-white shadow-sm">
          <div className="flex-1 space-y-4 overflow-y-auto p-6">
            {chat.length === 0 && (
              <div className="text-sm text-forest-light">
                <p className="font-semibold">Ask me to change your plan. Try:</p>
                <ul className="mt-2 list-inside list-disc space-y-1">
                  <li>&ldquo;Make Tuesday vegetarian&rdquo;</li>
                  <li>&ldquo;I don&rsquo;t have an oven — swap the baked meals&rdquo;</li>
                  <li>&ldquo;Make this week cheaper&rdquo;</li>
                  <li>&ldquo;More protein at breakfast&rdquo;</li>
                </ul>
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                    m.role === "user" ? "bg-forest text-cream" : "bg-leaf-soft"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {thinking && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-leaf-soft px-4 py-3 text-sm text-forest-light">
                  Updating your plan… 🍳
                </div>
              </div>
            )}
            {chatError && (
              <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{chatError}</p>
            )}
            <div ref={chatEndRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="flex gap-2 border-t border-cream p-4"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. make Tuesday vegetarian…"
              className="flex-1 rounded-xl border-2 border-transparent bg-cream px-4 py-3 outline-none focus:border-leaf"
            />
            <button
              type="submit"
              disabled={thinking || !input.trim()}
              className="rounded-xl bg-forest px-6 py-3 font-semibold text-cream transition hover:bg-forest-light disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
