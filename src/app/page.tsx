"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadPlan } from "@/lib/storage";

export default function LandingPage() {
  const [hasPlan, setHasPlan] = useState(false);

  useEffect(() => {
    setHasPlan(Boolean(loadPlan()));
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
      <p className="mb-4 rounded-full bg-leaf-soft px-4 py-1 text-sm font-medium text-forest-light">
        🥗 NutriFlow — early preview
      </p>
      <h1 className="font-display text-5xl leading-tight font-bold sm:text-6xl">
        Your week of meals,
        <br />
        <span className="italic text-leaf">planned in one minute.</span>
      </h1>
      <p className="mt-6 max-w-xl text-lg text-forest-light">
        Tell us your goal, diet and budget. The AI builds your whole week —
        every meal, every macro, and the full grocery list. Want changes? Just
        text the assistant: <em>&ldquo;make Tuesday vegetarian.&rdquo;</em>
      </p>
      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/onboarding"
          className="rounded-xl bg-forest px-8 py-4 text-lg font-semibold text-cream shadow-lg transition hover:bg-forest-light"
        >
          {hasPlan ? "Create a new plan" : "Plan my week"}
        </Link>
        {hasPlan && (
          <Link
            href="/plan"
            className="rounded-xl border-2 border-forest px-8 py-4 text-lg font-semibold text-forest transition hover:bg-leaf-soft"
          >
            Open my current plan
          </Link>
        )}
      </div>
      <div className="mt-16 grid gap-6 text-left sm:grid-cols-3">
        {[
          ["🧠", "AI-planned week", "7 days of meals matched to your goals, allergies and budget."],
          ["💬", "Chat to adjust", "“Swap the salmon” or “make it cheaper” — the plan updates itself."],
          ["🛒", "Instant groceries", "One shopping list for the whole week, built automatically."],
        ].map(([icon, title, text]) => (
          <div key={title} className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-2xl">{icon}</div>
            <h3 className="mt-2 font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-forest-light">{text}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
