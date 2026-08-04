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
  ExternalLinkIcon,
  HeartIcon,
  HomeIcon,
  SearchIcon,
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
import { FEED_RECIPES, filterFeed, sortFeed, type FeedFilter, type FeedDiet, type FeedSort } from "@/lib/feed";
import { groupByAisle } from "@/lib/grocery";
import { currentStreak, isoDay } from "@/lib/streak";
import { importedToMeal, type ImportedRecipe } from "@/lib/import";
import {
  loadChat,
  loadGroceriesChecked,
  loadImports,
  loadPlan,
  loadProfile,
  loadSaved,
  recordVisit,
  rememberImport,
  saveChat,
  saveGroceriesChecked,
  savePlan,
  saveProfile,
  toggleSaved,
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
  // Phase 2 — import a recipe from a pasted link.
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportedRecipe | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importDay, setImportDay] = useState<(typeof DAYS)[number]>(todayName());
  // A recipe imported by pasting a link INTO THE CHAT (not the Explore panel). Rendered as a card
  // under the conversation with the same add-to-slot buttons.
  const [chatImport, setChatImport] = useState<ImportedRecipe | null>(null);
  // History of link-imported recipes (newest first), so they can be re-added without re-fetching.
  const [importHistory, setImportHistory] = useState<ImportedRecipe[]>([]);
  const [streak, setStreak] = useState(0); // consecutive days the app was opened

  useEffect(() => {
    const todayIso = isoDay(new Date());
    setStreak(currentStreak(recordVisit(todayIso), todayIso));
  }, []);
  // Phase 3 — the feed's filter facets, search, sort, favourites, and paging.
  const [feedMealType, setFeedMealType] = useState<FeedFilter["mealType"]>("all");
  const [feedDiet, setFeedDiet] = useState<FeedDiet>("all");
  const [feedHighProtein, setFeedHighProtein] = useState(false);
  const [feedQuick, setFeedQuick] = useState(false); // <= 20 min
  const [feedQuery, setFeedQuery] = useState("");
  const [feedSort, setFeedSort] = useState<FeedSort>("default");
  const [feedSavedOnly, setFeedSavedOnly] = useState(false);
  const [feedLimit, setFeedLimit] = useState(24); // paginate: render a slice, "load more" grows it
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

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
    setImportHistory(loadImports());
    setSaved(new Set(loadSaved()));
    setChecked(new Set(loadGroceriesChecked()));
    // Start the feed on the user's own diet — the most relevant view — with "All" still one tap away.
    if (p.diet && p.diet !== "none") setFeedDiet(p.diet as FeedDiet);
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
    const map = new Map<string, { key: string; name: string; quantities: string[] }>();
    for (const day of plan.days) {
      for (const meal of day.meals) {
        for (const ing of meal.ingredients) {
          const key = ing.name.trim().toLowerCase();
          const entry = map.get(key) ?? { key, name: ing.name, quantities: [] };
          if (ing.quantity) entry.quantities.push(ing.quantity);
          map.set(key, entry);
        }
      }
    }
    return [...map.values()]
      .map((e) => ({ ...e, price: estimatePrice(e.name, e.quantities.length || 1) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [plan]);

  // Aisle-grouped view of the same list, for shopping in one walk instead of criss-crossing.
  const groceryAisles = useMemo(() => groupByAisle(groceries), [groceries]);

  // Which dish names are in the plan RIGHT NOW — so a feed card's "In your plan" badge is derived
  // from truth (survives reload, updates the moment you add or remove a meal) instead of a transient
  // "I clicked add" flag that reset on refresh.
  const planMealNames = useMemo(
    () => new Set((plan?.days ?? []).flatMap((d) => d.meals.map((m) => m.name.toLowerCase()))),
    [plan],
  );

  // When the plan changes the shopping list, keep the ticks for items that are STILL on it and drop
  // only the ones that left — a plan edit shouldn't wipe a shop in progress. Persisted so a reload
  // keeps them too.
  //
  // The `!plan` guard is load-bearing: on first mount this effect and the loader effect both run in
  // the same flush, and `groceries` is still [] here (plan hasn't been applied yet). Without the
  // guard, this functional updater runs AFTER the loader set `checked` to the persisted keys and
  // prunes them against an empty list — wiping every tick AND overwriting localStorage with []. Once
  // the plan is applied, `groceries` is real and this prunes correctly.
  useEffect(() => {
    if (!plan) return;
    const keys = new Set(groceries.map((g) => g.key));
    setChecked((prev) => {
      const pruned = new Set([...prev].filter((k) => keys.has(k)));
      if (pruned.size !== prev.size) saveGroceriesChecked([...pruned]);
      return pruned;
    });
  }, [groceries, plan]);

  function toggleChecked(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveGroceriesChecked([...next]);
      return next;
    });
  }

  const groceriesTotal = useMemo(
    () => groceries.reduce((s, g) => s + g.price, 0),
    [groceries],
  );

  const feed = useMemo(() => {
    let items = filterFeed(FEED_RECIPES, {
      mealType: feedMealType,
      diet: feedDiet,
      highProtein: feedHighProtein,
      maxTime: feedQuick ? 20 : null,
      query: feedQuery,
    });
    if (feedSavedOnly) items = items.filter((it) => saved.has(it.meal.name));
    return sortFeed(items, feedSort);
  }, [feedMealType, feedDiet, feedHighProtein, feedQuick, feedQuery, feedSort, feedSavedOnly, saved]);

  // Any filter change resets paging back to the first page.
  useEffect(() => {
    setFeedLimit(24);
  }, [feedMealType, feedDiet, feedHighProtein, feedQuick, feedQuery, feedSort, feedSavedOnly]);

  function toggleSave(name: string) {
    const next = new Set(toggleSaved(name));
    setSaved(next);
    setToast(next.has(name) ? `Saved "${name}"` : `Removed "${name}" from saved`);
  }

  // Share by copying to the clipboard — no backend, works offline, and is the fastest way to send a
  // recipe or a shopping list to someone.
  async function copyText(text: string, ok: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast(ok);
    } catch {
      setToast("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  function shareRecipe(meal: Meal) {
    const lines = [
      meal.name,
      "",
      "Ingredients:",
      ...meal.ingredients.map((i) => `- ${[i.quantity, i.name].filter(Boolean).join(" ")}`),
      "",
      "Method:",
      ...meal.steps.map((s, i) => `${i + 1}. ${s}`),
    ];
    if (meal.sourceUrl) lines.push("", `Source: ${meal.sourceUrl}`);
    void copyText(lines.join("\n"), `Copied "${meal.name}" to your clipboard`);
  }

  function copyGroceries() {
    const lines: string[] = ["Shopping list"];
    for (const group of groceryAisles) {
      lines.push("", group.aisle.toUpperCase());
      for (const g of group.items) {
        lines.push(`- ${g.name}${g.quantities.length ? ` (${g.quantities.join(" + ")})` : ""}`);
      }
    }
    lines.push("", `Estimated total: $${groceriesTotal.toFixed(2)}`);
    void copyText(lines.join("\n"), "Grocery list copied to your clipboard");
  }

  // Add a feed recipe to the plan, with an honest toast — the card used to change silently and, if
  // the target day weren't present, fail without a word.
  function addFeedRecipe(meal: Meal) {
    if (planMealNames.has(meal.name.toLowerCase())) return;
    if (addRecipeToDay(importDay, meal)) {
      const when = importDay === todayName() ? "today" : importDay;
      setToast(`Added "${meal.name}" to ${when}'s ${meal.type}.`);
    } else {
      setToast(`Couldn't add that — ${importDay} isn't in your plan.`);
    }
  }

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

  function addRecipeToDay(day: (typeof DAYS)[number], meal: Meal): boolean {
    if (!plan || !profile) return false;
    const target = plan.days.find((d) => d.day === day);
    if (!target) return false; // that day isn't in the plan — don't claim a change we didn't make
    // REPLACE the existing meal in that slot rather than appending. Appending left the day with two
    // breakfasts and double-counted its calories, and broke every `.find(m => m.type === …)` (the
    // drawer refresh, the Tonight hero) that assumes one meal per slot. "Make this my lunch" means
    // exactly one lunch.
    const replacing = target.meals.some((m) => m.type === meal.type);
    const next: WeekPlan = {
      ...plan,
      days: plan.days.map((d) =>
        d.day === day
          ? {
              ...d,
              meals: replacing
                ? d.meals.map((m) => (m.type === meal.type ? meal : m))
                : [...d.meals, meal],
            }
          : d,
      ),
    };
    // Every path that changes the plan owes `undo` a snapshot. Without this, adding a recipe here
    // and then saying "undo" in chat restores whatever the last CHAT change was — a plan the user
    // never asked to come back.
    setPrevious({
      plan,
      profile,
      label: replacing ? `replaced ${day}'s ${meal.type} with ${meal.name}` : `added ${meal.name} to ${day}`,
    });
    setPlan(next);
    savePlan(next);
    return true;
  }

  // Phase 2 — paste a recipe link, get a plan-ready meal. Deterministic (reads the page's
  // schema.org/Recipe), no model, so it works regardless of the assistant's state.
  async function importRecipe() {
    const url = importUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    setImportError(null);
    setImported(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't import that link.");
      const recipe = data.recipe as ImportedRecipe;
      setImported(recipe);
      setImportHistory(rememberImport(recipe));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Couldn't import that link.");
    } finally {
      setImporting(false);
    }
  }

  // Shared by BOTH import entry points (the Explore panel and the chat). Places the recipe in the
  // chosen day/slot and reports honestly — including the pin-collision disclosure.
  function placeImported(recipe: ImportedRecipe, type: Meal["type"]): boolean {
    const meal = importedToMeal(recipe, type);
    const when = importDay === todayName() ? "today" : importDay;
    if (!addRecipeToDay(importDay, meal)) {
      setToast(`Couldn't add that — ${importDay} isn't in your plan.`);
      return false;
    }
    // Honesty: pins survive a regenerate, so importing over a slot pinned to another dish will be
    // quietly reverted next rebuild. Say so instead of letting it surprise them.
    const pin = profile?.lockedMeals?.find((l) => l.day === importDay && l.mealType === type);
    const pinNote =
      pin && pin.name !== meal.name
        ? ` Heads up — ${importDay}'s ${type} is pinned to ${pin.name}, so regenerating the week will bring it back; unpin it to keep this.`
        : "";
    setToast(`Added ${meal.name} to ${when}'s ${type}.${pinNote}`);
    return true;
  }

  function addImportedTo(type: Meal["type"]) {
    if (!imported) return;
    if (placeImported(imported, type)) {
      setImported(null);
      setImportUrl("");
    }
  }

  function addChatImportedTo(type: Meal["type"]) {
    if (!chatImport) return;
    if (placeImported(chatImport, type)) setChatImport(null);
  }

  // Paste a recipe LINK into the chat and it imports deterministically — no model, no matter the
  // assistant's state. This is the "share a reel" gesture where people actually paste links.
  async function importFromChat(url: string, userText: string) {
    const history: ChatMessage[] = [...chat, { role: "user", text: userText }];
    setChat(history);
    saveChat(history);
    setInput("");
    setThinking(true);
    setChatImport(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        const c: ChatMessage[] = [...history, { role: "assistant", text: data.error ?? "I couldn't import that link." }];
        setChat(c);
        saveChat(c);
        return;
      }
      const r = data.recipe as ImportedRecipe;
      setChatImport(r);
      setImportHistory(rememberImport(r));
      const host = new URL(r.sourceUrl).hostname.replace(/^www\./, "");
      const macros =
        r.macrosSource === "site"
          ? ` About ${r.calories} kcal per serving.`
          : " The page didn't list nutrition, so it comes in without macros.";
      const c: ChatMessage[] = [
        ...history,
        { role: "assistant", text: `I pulled in "${r.name}" from ${host}.${macros} Pick a slot below to drop it into your plan.` },
      ];
      setChat(c);
      saveChat(c);
    } catch {
      const c: ChatMessage[] = [...history, { role: "assistant", text: "I couldn't reach that link — try again, or paste a different recipe." }];
      setChat(c);
      saveChat(c);
    } finally {
      setThinking(false);
    }
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

  // Make the meal drawer a proper modal: Escape closes it, the page behind it can't scroll, and
  // focus moves into it on open (and the whole thing is announced as a dialog — see the aside below).
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);
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
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Couldn't regenerate the plan.");
    } finally {
      setRegenerating(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || thinking || !profile || !plan) return;
    // A pasted link is an import gesture, not a question — route it to the deterministic importer
    // instead of the model. (If the link isn't a recipe, the importer says so gracefully.)
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      void importFromChat(urlMatch[0], text);
      return;
    }
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
      <main className="min-h-screen p-6 md:ml-56">
        <div className="mx-auto max-w-[1800px] animate-pulse">
          <div className="h-8 w-56 rounded-lg bg-lav" />
          <div className="mt-3 h-4 w-80 max-w-full rounded bg-lav" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-40 rounded-2xl bg-lav" />
            ))}
          </div>
        </div>
        <span className="sr-only">Loading your plan…</span>
      </main>
    );
  }

  const today = plan.days.find((d) => d.day === todayName()) ?? plan.days[0];
  const tonight =
    today?.meals.find((m) => m.type === "dinner") ?? today?.meals[0] ?? null;
  const todayKcal = today?.meals.reduce((s, m) => s + m.calories, 0) ?? 0;
  const targetKcal = profile.targetCalories || 2000;

  const NAV: { key: View; label: string; short: string; icon: React.ReactNode }[] = [
    { key: "home", label: "Home", short: "Home", icon: <HomeIcon /> },
    { key: "week", label: "My week", short: "Week", icon: <CalendarIcon /> },
    { key: "explore", label: "Explore", short: "Explore", icon: <CompassIcon /> },
    { key: "groceries", label: "Groceries", short: "Shop", icon: <CartIcon /> },
    { key: "assistant", label: "Assistant", short: "Chat", icon: <ChatIcon /> },
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
              aria-current={view === n.key ? "page" : undefined}
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

      {/* Mobile bottom nav — full-width, ≥44px touch targets, safe-area aware. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => setView(n.key)}
            aria-current={view === n.key ? "page" : undefined}
            className={`flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition ${
              view === n.key ? "text-vio-deep" : "text-mut"
            }`}
          >
            {n.icon}
            {n.short}
          </button>
        ))}
      </nav>

      {/* ===== Main ===== */}
      <main className="flex min-h-screen w-full flex-col pb-20 md:ml-56 md:pb-0">
        <div className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col px-6 py-8">
          {/* ---------- HOME ---------- */}
          {view === "home" && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-display text-3xl font-bold tracking-tight">
                  {greeting()}{profile.name ? `, ${profile.name}` : ""}
                </h1>
                {streak >= 2 && (
                  <span
                    className="flex items-center gap-1.5 rounded-full bg-lav px-3 py-1 text-xs font-bold text-vio-deep"
                    title={`You've opened NutriFlow ${streak} days in a row`}
                  >
                    <ZapIcon className="h-3.5 w-3.5" /> {streak}-day streak
                  </span>
                )}
              </div>
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
                            <p className="text-[11px] font-bold tracking-wider text-vio-deep uppercase">
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
                {/* Mobile: a vertical day-by-day stack. The 900px timetable below is unusable on a
                    phone (it becomes a sideways-drag table), so it's desktop-only. */}
                <div className="space-y-3 lg:hidden">
                  {plan.days.map((day) => {
                    const kcal = day.meals.reduce((s, m) => s + m.calories, 0);
                    const isToday = day.day === todayName();
                    return (
                      <div key={day.day} className="rounded-2xl bg-white p-4 card-shadow">
                        <div className="flex items-baseline justify-between">
                          <h3 className={`font-bold ${isToday ? "text-vio-deep" : ""}`}>
                            {day.day}
                            {isToday && <span className="ml-2 text-xs font-semibold text-vio">Today</span>}
                          </h3>
                          <span className="text-xs text-mut tabular-nums">{kcal.toLocaleString()} kcal</span>
                        </div>
                        <div className="mt-1 divide-y divide-line">
                          {day.meals.map((meal) => (
                            <button
                              key={meal.type + meal.name}
                              onClick={() => openMeal(meal, day.day)}
                              className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
                            >
                              <div className="min-w-0">
                                <p className="text-[11px] font-bold tracking-wide text-mut uppercase">{meal.type}</p>
                                <p className="truncate text-sm font-semibold leading-snug">{meal.name}</p>
                              </div>
                              <span className="flex-none text-xs text-mut tabular-nums">
                                <span className="font-bold text-vio-deep">{meal.calories}</span> kcal
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Desktop timetable — fills space; scrolls when narrow */}
                <div className="hidden min-h-0 flex-1 overflow-x-auto overflow-y-hidden lg:block">
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
                Browse the whole library — filter it, then drop any recipe onto a day.
              </p>

              {/* Phase 2 — import a recipe from a link. */}
              <div className="mt-6 rounded-2xl bg-white p-5 card-shadow">
                <h2 className="font-semibold">Import a recipe</h2>
                <p className="mt-1 text-sm text-mut">
                  Paste a recipe page, or a TikTok / YouTube / Instagram link, and I&rsquo;ll pull the
                  ingredients and method into your plan.
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void importRecipe()}
                    placeholder="https://…"
                    className="flex-1 rounded-xl border-2 border-transparent bg-bgsoft px-4 py-2.5 text-sm outline-none focus:border-vio"
                  />
                  <button
                    onClick={() => void importRecipe()}
                    disabled={importing || !importUrl.trim()}
                    className="rounded-xl bg-vio px-4 py-2.5 text-sm font-bold text-white transition hover:bg-vio-deep disabled:opacity-50"
                  >
                    {importing ? "Reading…" : "Import"}
                  </button>
                </div>
                {importError && <p className="mt-2 text-xs text-red-600">{importError}</p>}

                {/* Recently imported — re-open any past import instantly, no re-fetch. */}
                {importHistory.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] font-semibold text-mut uppercase tracking-wide">Recently imported</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {importHistory.slice(0, 8).map((r) => (
                        <button
                          key={r.sourceUrl}
                          onClick={() => { setImported(r); setImportUrl(r.sourceUrl); setImportError(null); }}
                          title={r.sourceUrl}
                          className="max-w-[14rem] truncate rounded-full bg-lav px-3 py-1 text-xs font-semibold text-vio-deep transition hover:bg-vio hover:text-white"
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {imported && (
                  <div className="mt-4 rounded-xl bg-bgsoft p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold leading-snug">{imported.name}</p>
                        <p className="mt-0.5 text-[11px] text-mut">
                          {new URL(imported.sourceUrl).hostname.replace(/^www\./, "")} ·{" "}
                          {imported.ingredients.length} ingredients
                          {imported.servings > 1 ? ` · makes ${imported.servings}` : ""}
                        </p>
                      </div>
                      <button
                        onClick={() => { setImported(null); setImportUrl(""); }}
                        className="flex-none rounded-full p-1 text-mut hover:text-plum"
                        aria-label="Dismiss"
                      >
                        <XIcon />
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-mut">
                      {imported.macrosSource === "site"
                        ? `Per serving: ${imported.calories} kcal · P${imported.proteinGrams ?? "—"} · C${imported.carbsGrams ?? "—"} · F${imported.fatGrams ?? "—"}`
                        : "The page didn't list its nutrition, so this comes in without macros — you can still add it."}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-mut">Add to</span>
                      <select
                        value={importDay}
                        onChange={(e) => setImportDay(e.target.value as (typeof DAYS)[number])}
                        className="rounded-full bg-white px-2.5 py-1.5 text-xs font-bold text-vio-deep outline-none ring-1 ring-line focus:ring-vio"
                      >
                        {DAYS.map((d) => (
                          <option key={d} value={d}>
                            {d === todayName() ? `${d} (today)` : d}
                          </option>
                        ))}
                      </select>
                      {(["breakfast", "lunch", "dinner"] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => addImportedTo(t)}
                          className="rounded-full bg-vio px-3 py-1.5 text-xs font-bold text-white transition hover:bg-vio-deep"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Filter bar (Phase 3). All deterministic — filtering a fixed, macro-validated list. */}
              <div className="mt-6 space-y-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[12rem] flex-1">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mut" />
                    <input
                      value={feedQuery}
                      onChange={(e) => setFeedQuery(e.target.value)}
                      placeholder="Search recipes or ingredients…"
                      aria-label="Search recipes"
                      className="w-full rounded-full bg-white py-2 pr-3 pl-9 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-vio"
                    />
                    {feedQuery && (
                      <button
                        onClick={() => setFeedQuery("")}
                        aria-label="Clear search"
                        className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-mut hover:text-plum"
                      >
                        <XIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <select
                    value={feedSort}
                    onChange={(e) => setFeedSort(e.target.value as FeedSort)}
                    aria-label="Sort recipes"
                    className="rounded-full bg-white px-3 py-2 text-xs font-bold text-plum ring-1 ring-line outline-none focus:ring-vio"
                  >
                    <option value="default">Featured</option>
                    <option value="protein">Most protein</option>
                    <option value="calories-low">Fewest calories</option>
                    <option value="time">Quickest</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {([
                    ["all", "All"],
                    ["breakfast", "Breakfast"],
                    ["lunch", "Lunch"],
                    ["dinner", "Dinner"],
                    ["snack", "Snack"],
                  ] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setFeedMealType(v)}
                      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${feedMealType === v ? "bg-vio text-white" : "bg-white text-plum ring-1 ring-line hover:ring-vio"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {([
                    ["all", "Any diet"],
                    ["vegetarian", "Vegetarian"],
                    ["vegan", "Vegan"],
                    ["keto", "Keto"],
                    ["mediterranean", "Mediterranean"],
                    ["gluten_free", "Gluten-free"],
                  ] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setFeedDiet(v)}
                      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${feedDiet === v ? "bg-vio text-white" : "bg-white text-plum ring-1 ring-line hover:ring-vio"}`}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="mx-1 h-4 w-px bg-line" />
                  <button
                    onClick={() => setFeedHighProtein((v) => !v)}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${feedHighProtein ? "bg-vio text-white" : "bg-white text-plum ring-1 ring-line hover:ring-vio"}`}
                  >
                    High protein
                  </button>
                  <button
                    onClick={() => setFeedQuick((v) => !v)}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${feedQuick ? "bg-vio text-white" : "bg-white text-plum ring-1 ring-line hover:ring-vio"}`}
                  >
                    Under 20 min
                  </button>
                  <button
                    onClick={() => setFeedSavedOnly((v) => !v)}
                    className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold transition ${feedSavedOnly ? "bg-vio text-white" : "bg-white text-plum ring-1 ring-line hover:ring-vio"}`}
                  >
                    <HeartIcon className="h-3.5 w-3.5" filled={feedSavedOnly} /> Saved{saved.size ? ` (${saved.size})` : ""}
                  </button>
                </div>
                <div className="flex items-center gap-2 pt-0.5 text-xs text-mut">
                  <span>
                    {feed.length} recipe{feed.length === 1 ? "" : "s"} · adding to
                  </span>
                  <select
                    value={importDay}
                    onChange={(e) => setImportDay(e.target.value as (typeof DAYS)[number])}
                    className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-vio-deep outline-none ring-1 ring-line focus:ring-vio"
                  >
                    {DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d === todayName() ? `${d} (today)` : d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {feed.length === 0 ? (
                <p className="mt-8 text-sm text-mut">
                  {feedSavedOnly && saved.size === 0
                    ? "You haven't saved any recipes yet — tap the heart on a recipe to keep it here."
                    : "No recipes match those filters — loosen one, or clear the search."}
                </p>
              ) : (
                <>
                  <div className="mt-4 columns-2 gap-4 lg:columns-3">
                    {feed.slice(0, feedLimit).map((r) => {
                      const isAdded = planMealNames.has(r.meal.name.toLowerCase());
                      const isSaved = saved.has(r.meal.name);
                      // Deterministic masonry height from the name, so the wall varies but is stable.
                      const h = 130 + (Math.abs([...r.meal.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)) % 80);
                      return (
                        <div
                          key={r.meal.name}
                          className="mb-4 break-inside-avoid overflow-hidden rounded-2xl bg-white card-shadow"
                        >
                          <div className="relative">
                            <button
                              onClick={() => openMeal(r.meal)}
                              aria-label={`View ${r.meal.name}`}
                              className="block w-full"
                            >
                              <div
                                className="w-full bg-cover bg-center"
                                style={{ height: h, ...(r.image ? { backgroundImage: `url(${r.image})` } : { background: r.gradient }) }}
                              />
                            </button>
                            <button
                              onClick={() => toggleSave(r.meal.name)}
                              aria-label={isSaved ? `Remove ${r.meal.name} from saved` : `Save ${r.meal.name}`}
                              aria-pressed={isSaved}
                              className={`absolute top-2 right-2 rounded-full p-2 shadow-sm backdrop-blur transition ${isSaved ? "bg-white text-vio" : "bg-black/35 text-white hover:bg-black/55"}`}
                            >
                              <HeartIcon className="h-4 w-4" filled={isSaved} />
                            </button>
                          </div>
                          <div className="p-3">
                            <p className="text-sm font-bold">{r.meal.name}</p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-lav px-2 py-0.5 text-[10px] font-bold text-vio-deep">
                                {r.meal.calories} kcal
                              </span>
                              <span className="rounded-full bg-lav px-2 py-0.5 text-[10px] font-bold text-vio-deep">
                                {r.meal.proteinGrams} g protein
                              </span>
                              {r.dietTags.includes("vegan") ? (
                                <span className="rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold text-mint">vegan</span>
                              ) : r.dietTags.includes("vegetarian") ? (
                                <span className="rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold text-mint">veg</span>
                              ) : null}
                              {ratingFor(r.meal.name) > 0 && (
                                <span className="flex items-center gap-0.5 rounded-full bg-lav px-2 py-0.5 text-[10px] font-bold text-vio-deep">
                                  <StarIcon className="h-3 w-3" filled /> {ratingFor(r.meal.name)}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => addFeedRecipe(r.meal)}
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
                  {feed.length > feedLimit && (
                    <div className="mt-2 flex justify-center">
                      <button
                        onClick={() => setFeedLimit((n) => n + 24)}
                        className="rounded-full bg-white px-6 py-2.5 text-sm font-bold text-vio-deep ring-1 ring-line transition hover:ring-vio"
                      >
                        Load more ({feed.length - feedLimit} left)
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ---------- GROCERIES ---------- */}
          {view === "groceries" && (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h1 className="font-display text-3xl font-bold tracking-tight">Groceries</h1>
                  <p className="mt-1 text-sm text-mut">
                    {checked.size} of {groceries.length} ticked · whole week, aggregated by aisle
                  </p>
                </div>
                {groceries.length > 0 && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={copyGroceries}
                      className="rounded-full bg-white px-3.5 py-2 text-xs font-bold text-vio-deep ring-1 ring-line transition hover:ring-vio"
                    >
                      Copy list
                    </button>
                    <div className="text-right">
                      <p className="font-display text-2xl font-bold text-vio-deep tabular-nums">
                        ${groceriesTotal.toFixed(2)}
                      </p>
                      <p className="text-[11px] text-mut">estimated total</p>
                    </div>
                  </div>
                )}
              </div>

              {groceries.length === 0 ? (
                <div className="mt-8 rounded-2xl bg-white p-10 text-center card-shadow">
                  <CartIcon className="mx-auto h-8 w-8 text-mut" />
                  <p className="mt-3 text-sm text-mut">Your shopping list fills up once you have a plan.</p>
                </div>
              ) : (
                <>
                  {/* Progress bar across the whole list. */}
                  <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-lav">
                    <div
                      className="h-full rounded-full bg-vio transition-all"
                      style={{ width: `${groceries.length ? (checked.size / groceries.length) * 100 : 0}%` }}
                    />
                  </div>

                  <div className="mt-4 space-y-4">
                    {groceryAisles.map((group) => (
                      <div key={group.aisle} className="rounded-2xl bg-white p-4 card-shadow sm:p-5">
                        <h2 className="text-xs font-bold tracking-widest text-vio-deep uppercase">
                          {group.aisle}
                          <span className="ml-2 font-semibold text-mut">{group.items.length}</span>
                        </h2>
                        <ul className="mt-2 grid gap-0.5 sm:grid-cols-2">
                          {group.items.map((g) => {
                            const done = checked.has(g.key);
                            return (
                              <li key={g.key}>
                                <label
                                  className={`flex cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2 transition hover:bg-lav ${done ? "opacity-45" : ""}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={done}
                                    onChange={() => toggleChecked(g.key)}
                                    className="mt-0.5 h-4 w-4 flex-none accent-vio"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className={`text-sm font-medium ${done ? "line-through" : ""}`}>{g.name}</span>
                                    {g.quantities.length > 0 && (
                                      <span className="ml-1 text-xs text-mut">({g.quantities.join(" + ")})</span>
                                    )}
                                  </span>
                                  <span className="flex-none text-xs text-mut tabular-nums">${g.price.toFixed(2)}</span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                </>
              )}
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
                  {/* A recipe imported from a link pasted in the chat — add it to a slot from here. */}
                  {chatImport && (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white p-4 ring-1 ring-line">
                        <p className="font-semibold leading-snug">{chatImport.name}</p>
                        <p className="mt-0.5 text-[11px] text-mut">
                          {new URL(chatImport.sourceUrl).hostname.replace(/^www\./, "")} ·{" "}
                          {chatImport.ingredients.length} ingredients
                          {chatImport.macrosSource === "site"
                            ? ` · ${chatImport.calories} kcal/serving`
                            : " · no macros listed"}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-mut">Add to</span>
                          <select
                            value={importDay}
                            onChange={(e) => setImportDay(e.target.value as (typeof DAYS)[number])}
                            className="rounded-full bg-bgsoft px-2.5 py-1.5 text-xs font-bold text-vio-deep outline-none ring-1 ring-line focus:ring-vio"
                          >
                            {DAYS.map((d) => (
                              <option key={d} value={d}>
                                {d === todayName() ? `${d} (today)` : d}
                              </option>
                            ))}
                          </select>
                          {(["breakfast", "lunch", "dinner"] as const).map((t) => (
                            <button
                              key={t}
                              onClick={() => addChatImportedTo(t)}
                              className="rounded-full bg-vio px-3 py-1.5 text-xs font-bold text-white transition hover:bg-vio-deep"
                            >
                              {t}
                            </button>
                          ))}
                          <button
                            onClick={() => setChatImport(null)}
                            className="rounded-full p-1 text-mut hover:text-plum"
                            aria-label="Dismiss"
                          >
                            <XIcon className="h-4 w-4" />
                          </button>
                        </div>
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
                    placeholder="Change anything, or paste a recipe link to import…"
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
          className="fixed bottom-20 left-6 z-50 flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-plum shadow-lg ring-1 ring-line transition hover:bg-bgsoft md:bottom-6"
          title={`Undo: ${previous.label}`}
        >
          <RefreshIcon className="h-3.5 w-3.5 -scale-x-100" />
          Undo {previous.label}
        </button>
      )}

      {/* A brief confirmation after a direct action (rating, undo). */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 z-50 max-w-[92vw] -translate-x-1/2 rounded-full bg-plum px-5 py-2.5 text-center text-sm font-medium text-white shadow-lg md:bottom-6">
          {toast}
        </div>
      )}

      {/* ===== Meal detail drawer ===== */}
      {detail && (
        <>
          <div
            className="fixed inset-0 z-30 bg-plum/40"
            onClick={closeDetail}
            aria-hidden="true"
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={detail.name}
            tabIndex={-1}
            className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto bg-white shadow-2xl outline-none"
          >
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
              {/* Imported meals link back to where they came from — the macros are the source's own,
                  and the ingredient list is deliberately simplified, so "view original" matters. */}
              {detail.sourceUrl && (
                <a
                  href={detail.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-vio hover:text-vio-deep"
                >
                  <ExternalLinkIcon className="h-3.5 w-3.5" /> View original recipe
                </a>
              )}
              {/* Save / favourite + share (works for library and imported recipes). */}
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => toggleSave(detail.name)}
                  aria-pressed={saved.has(detail.name)}
                  className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${saved.has(detail.name) ? "bg-vio text-white" : "bg-bgsoft text-plum hover:bg-lav"}`}
                >
                  <HeartIcon className="h-3.5 w-3.5" filled={saved.has(detail.name)} />
                  {saved.has(detail.name) ? "Saved" : "Save"}
                </button>
                <button
                  onClick={() => shareRecipe(detail)}
                  className="flex items-center gap-1.5 rounded-full bg-bgsoft px-3.5 py-1.5 text-xs font-bold text-plum transition hover:bg-lav"
                >
                  <ExternalLinkIcon className="h-3.5 w-3.5" /> Share
                </button>
              </div>
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
              {/* The coach move for an imported meal: keep THIS dish, rescale the day's other meals'
                  portions to hold your targets around it. Only offered when the import has macros —
                  with no numbers there's nothing to balance against. */}
              {detailDay && detail.sourceUrl && detail.calories > 0 && (
                <button
                  onClick={() => runOperation({ tool: "rebalance_day", day: detailDay } as Operation)}
                  className="mt-3 flex items-center gap-1.5 rounded-full bg-bgsoft px-3.5 py-1.5 text-xs font-bold text-plum transition hover:bg-lav"
                >
                  <RefreshIcon className="h-3.5 w-3.5" /> Balance {detailDay} around this
                </button>
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
              {/* Honesty: an imported meal whose source listed no nutrition sits at 0 kcal — say so
                  rather than let a blank meal quietly pull the day's totals down. We never guess. */}
              {detail.sourceUrl && detail.calories === 0 && (
                <p className="mt-2 text-xs text-mut">
                  The source didn&rsquo;t list nutrition, so this meal has no macros — it won&rsquo;t
                  count toward your day&rsquo;s totals.
                </p>
              )}
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
