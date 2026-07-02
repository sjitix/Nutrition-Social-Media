"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/icons";
import { loadPlan } from "@/lib/storage";

const FEATURES: [string, string][] = [
  [
    "AI-planned week",
    "Seven days of meals matched to your goals, allergies and budget — generated in under a minute.",
  ],
  [
    "Chat to adjust",
    "“Swap the salmon” or “make it cheaper” — the assistant rewrites your actual plan, not just its reply.",
  ],
  [
    "Groceries, done",
    "One consolidated shopping list for the whole week, built automatically from your meals.",
  ],
];

export default function LandingPage() {
  const [hasPlan, setHasPlan] = useState(false);

  useEffect(() => {
    setHasPlan(Boolean(loadPlan()));
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-6 pb-24">
      <nav className="flex items-center justify-between py-6">
        <Wordmark />
        {hasPlan && (
          <Link
            href="/plan"
            className="rounded-full bg-plum px-5 py-2 text-sm font-semibold text-white transition hover:bg-plum-mid"
          >
            Open my plan
          </Link>
        )}
      </nav>

      <section className="mt-10 grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="text-xs font-bold tracking-widest text-vio-deep uppercase">
            Early preview
          </p>
          <h1 className="font-display mt-3 text-5xl leading-tight font-bold tracking-tight">
            Your week of meals, planned in one minute.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-mut">
            Tell us your goal, diet and budget. The AI builds your whole week —
            every meal, every macro, the full grocery list. Want changes? Just
            tell the assistant.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/onboarding"
              className="rounded-full bg-vio px-8 py-4 text-base font-semibold text-white shadow-lg shadow-vio/30 transition hover:bg-vio-deep"
            >
              {hasPlan ? "Create a new plan" : "Plan my week"}
            </Link>
          </div>
        </div>
        <div className="relative hidden lg:block">
          <div
            className="h-105 rounded-3xl bg-cover bg-center card-shadow"
            style={{ backgroundImage: "url(/food/bowl1.jpg)" }}
          />
          <div className="absolute -bottom-6 -left-6 rounded-2xl bg-white p-4 card-shadow">
            <p className="text-xs font-bold tracking-wider text-mut uppercase">
              Tonight
            </p>
            <p className="mt-1 font-semibold">Seared Salmon over Greens</p>
            <p className="mt-0.5 text-sm text-mut">590 kcal · 38 g protein</p>
          </div>
        </div>
      </section>

      <section className="mt-24 grid gap-6 sm:grid-cols-3">
        {FEATURES.map(([title, text]) => (
          <div key={title} className="rounded-2xl bg-white p-6 card-shadow">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-mut">{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
