import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { selectWeekFromDb, rebalanceWeek } from "./recipeDb";
import {
  AssistantResponseSchema,
  AssistantTurnSchema,
  DEFAULT_TARGETS,
  MEAL_TYPES,
  MealSchema,
  WeekPlanSchema,
  type AssistantResponse,
  type AssistantTurn,
  type ChatMessage,
  type Meal,
  type UserProfile,
  type WeekPlan,
} from "./types";

type MealType = (typeof MEAL_TYPES)[number];

// Fill in target fields for any profile that predates them (older saved profiles)
// or arrives with zeros, so generation always has concrete numbers to hit.
export function withTargetDefaults(profile: UserProfile): UserProfile {
  return {
    ...profile,
    targetCalories: profile.targetCalories || DEFAULT_TARGETS.targetCalories,
    proteinGrams: profile.proteinGrams || DEFAULT_TARGETS.proteinGrams,
    carbsGrams: profile.carbsGrams || DEFAULT_TARGETS.carbsGrams,
    fatGrams: profile.fatGrams || DEFAULT_TARGETS.fatGrams,
    maxCookTime: profile.maxCookTime || DEFAULT_TARGETS.maxCookTime,
    maxIngredients: profile.maxIngredients || DEFAULT_TARGETS.maxIngredients,
  };
}

// How the day's calories are split across meals, so plans come out balanced
// instead of one huge meal next to a near-empty one. Shares sum to 1.
const MEAL_SPLITS: Record<number, { type: MealType; share: number }[]> = {
  3: [
    { type: "breakfast", share: 0.3 },
    { type: "lunch", share: 0.35 },
    { type: "dinner", share: 0.35 },
  ],
  4: [
    { type: "breakfast", share: 0.27 },
    { type: "lunch", share: 0.31 },
    { type: "dinner", share: 0.31 },
    { type: "snack", share: 0.11 },
  ],
};

function mealSplit(profile: UserProfile) {
  return MEAL_SPLITS[profile.mealsPerDay] ?? MEAL_SPLITS[3];
}

// --- Variety: keep the week from collapsing into "chicken every day" ---------

// Heuristic main-protein detection from a meal's name + ingredients. Each day is
// generated independently, so the model defaults to its highest-probability
// protein (chicken) every time; tracking proteins lets us push it to vary.
const PROTEIN_KEYWORDS: [string, RegExp][] = [
  ["chicken", /chicken/i],
  ["turkey", /turkey/i],
  ["beef", /beef|steak|ground meat|mince/i],
  ["pork", /pork|bacon|ham|sausage/i],
  ["lamb", /lamb/i],
  ["salmon", /salmon/i],
  ["tuna", /tuna/i],
  ["white fish", /cod|haddock|tilapia|pollock|sea bass|trout|white fish/i],
  ["shrimp", /shrimp|prawn/i],
  ["eggs", /\beggs?\b|omelette|frittata/i],
  ["tofu", /tofu|tempeh|edamame/i],
  ["legumes", /lentil|chickpea|black beans?|kidney beans?|\bbeans?\b|hummus|falafel/i],
  ["dairy", /greek yogurt|cottage cheese|halloumi|paneer/i],
];

function detectProteins(meal: Meal): string[] {
  const hay = `${meal.name} ${meal.ingredients.map((i) => i.name).join(" ")}`.toLowerCase();
  const found: string[] = [];
  for (const [label, re] of PROTEIN_KEYWORDS) if (re.test(hay)) found.push(label);
  return found;
}

interface VarietyContext {
  proteinDays: Record<string, number>; // days each protein has appeared so far
  usedNames: string[]; // dish names already placed in the week
}

// Prompt guidance derived from what earlier days already used.
function varietyPromptText(v: VarietyContext): string {
  const used = Object.keys(v.proteinDays);
  if (used.length === 0 && v.usedNames.length === 0) return "";
  const overused = Object.entries(v.proteinDays)
    .filter(([, n]) => n >= 2)
    .map(([p]) => p);
  const lines: string[] = [];
  if (used.length) {
    lines.push(
      `Main proteins already used this week: ${used.join(", ")}. Choose a DIFFERENT main protein today for variety${
        overused.length ? ` — do NOT use ${overused.join(" or ")}` : ""
      }.`,
    );
  }
  if (v.usedNames.length) lines.push(`Do not repeat any of these dishes: ${v.usedNames.join("; ")}.`);
  return lines.join("\n");
}

// Cook-time + ingredient-count limits (interim, until recipes come from the DB).
function prefsPromptText(profile: UserProfile): string {
  return `Each meal must be preparable in about ${profile.maxCookTime} minutes or less and use at most ${profile.maxIngredients} ingredients. Keep steps short and easy.`;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Provider resolution
//
// AI_PROVIDER=local  → an OpenAI-compatible local server (LM Studio, Ollama)
// AI_PROVIDER=claude → the Claude API (requires ANTHROPIC_API_KEY)
// unset              → claude if a key exists, otherwise demo mode
// ---------------------------------------------------------------------------

export type Provider = "claude" | "local" | "demo";

export function resolveProvider(): Provider {
  const p = process.env.AI_PROVIDER?.toLowerCase();
  if (p === "local") return "local";
  return process.env.ANTHROPIC_API_KEY ? "claude" : "demo";
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";
const LOCAL_AI_URL = process.env.LOCAL_AI_URL ?? "http://localhost:1234/v1";
const LOCAL_AI_MODEL = process.env.LOCAL_AI_MODEL ?? "local-model";
// Optional: for OpenAI-compatible endpoints that require auth (e.g. OpenRouter)
const LOCAL_AI_API_KEY = process.env.LOCAL_AI_API_KEY;

// ---------------------------------------------------------------------------
// Shared prompts
// ---------------------------------------------------------------------------

function profileDescription(profile: UserProfile): string {
  const goals: Record<UserProfile["goal"], string> = {
    lose_weight: "lose weight (moderate calorie deficit)",
    maintain: "maintain weight and eat healthier",
    build_muscle: "build muscle (calorie surplus, high protein)",
  };
  return [
    `Goal: ${goals[profile.goal]}`,
    `Diet: ${profile.diet === "none" ? "no restrictions" : profile.diet}`,
    `Allergies: ${profile.allergies.trim() || "none"}`,
    `Dislikes: ${profile.dislikes.trim() || "none"}`,
    `Budget: ${profile.budget}`,
    `Meals per day: ${profile.mealsPerDay}`,
  ].join("\n");
}

// Concrete per-meal calorie budget so the model has a number to hit for each
// meal — the single biggest lever against wildly unbalanced days.
function macroTargetText(profile: UserProfile): string {
  const split = mealSplit(profile);
  const perMeal = split
    .map((s) => `  - ${s.type}: ~${Math.round(profile.targetCalories * s.share)} kcal`)
    .join("\n");
  return (
    `Daily targets to hit: ~${profile.targetCalories} kcal, ${profile.proteinGrams} g protein, ` +
    `${profile.carbsGrams} g carbs, ${profile.fatGrams} g fat.\n` +
    `Split the calories across the meals roughly like this (every meal substantial, none near-zero):\n${perMeal}`
  );
}

const PLAN_RULES = `Rules for the plan:
- Cover all 7 days, Monday through Sunday, with exactly the requested number of meals per day.
- Every meal must be a real, complete dish and substantial — NEVER a near-zero-calorie or empty meal, and the day's meals should be balanced (no single meal dominating the whole day).
- Meal "name" must be a real, specific dish name (e.g. "Grilled Chicken & Quinoa Bowl"). Never use placeholders, question marks, ellipses ("..."), or truncated/garbled text.
- Meals must be realistic, tasty, and simple enough for a home cook.
- The meal "type" field must be exactly one of: breakfast, lunch, dinner, snack (lowercase).
- "description" is one short, appetizing sentence.
- "steps" are 3-6 clear, numbered-style instructions a beginner can follow — plain and easy, no jargon.
- Respect all allergies strictly — never include an allergen, even as a trace ingredient.
- Respect the diet type and avoid disliked foods.
- Reuse ingredients across the week where sensible so the grocery list stays affordable.
- Vary the main protein across the week — rotate between poultry, fish/seafood, red meat, eggs, tofu and legumes. Do NOT use the same main protein (e.g. chicken) on most days.
- Keep every meal simple: respect the given cook-time and ingredient limits, and don't pile on ingredients.
- Include a realistic "timeMinutes" for each meal (total prep + cooking time), within the cook-time limit.
- Hit the daily calorie and macro targets as closely as you can, and give honest per-meal calorie/macro estimates that add up to the day's total.
- Ingredient quantities should be concrete (e.g. "200 g", "1 tbsp", "2 pieces").`;

function planSystemPrompt(): string {
  return (
    "You are a professional nutritionist creating personalized weekly meal plans. " +
    PLAN_RULES
  );
}

function planUserPrompt(profile: UserProfile): string {
  return `Create a 7-day meal plan for this person:\n\n${profileDescription(profile)}\n\nIn weekSummary, write 1-2 friendly sentences about the week's plan and its approximate daily calories.`;
}

function assistantSystemPrompt(profile: UserProfile, plan: WeekPlan): string {
  return (
    "You are the meal-plan assistant inside a meal planning app. The user has a current weekly plan and asks you to adjust it (swap meals, make a day vegetarian, make it cheaper, etc.) or asks questions about it.\n" +
    "In changedDays, return ONLY the days you modified, each as a complete day object with ALL of that day's meals (changed and unchanged ones). If the user's message doesn't require changing the plan, return an empty changedDays array and just answer in reply.\n" +
    "Keep reply short and friendly (1-3 sentences). When you change meals, keep them consistent with the user's profile below and recalculate calories/macros honestly.\n" +
    PLAN_RULES +
    `\n\nUser profile:\n${profileDescription(profile)}\n\n${macroTargetText(profile)}\n${prefsPromptText(profile)}\n\nCurrent week plan (JSON):\n${JSON.stringify(plan)}`
  );
}

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

async function claudeGeneratePlan(profile: UserProfile): Promise<WeekPlan> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: planSystemPrompt(),
    messages: [{ role: "user", content: planUserPrompt(profile) }],
    output_config: { format: zodOutputFormat(WeekPlanSchema) },
  });
  const plan = response.parsed_output;
  if (!plan) throw new Error("The AI response could not be parsed into a meal plan.");
  return plan;
}

async function claudeRunAssistant(
  profile: UserProfile,
  plan: WeekPlan,
  history: ChatMessage[],
): Promise<AssistantResponse> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: assistantSystemPrompt(profile, plan),
    messages: history.map((m) => ({ role: m.role, content: m.text })),
    output_config: { format: zodOutputFormat(AssistantResponseSchema) },
  });
  const result = response.parsed_output;
  if (!result) throw new Error("The AI response could not be parsed.");
  return result;
}

// ---------------------------------------------------------------------------
// Local provider (OpenAI-compatible: LM Studio on :1234, Ollama on :11434)
// ---------------------------------------------------------------------------

interface LocalChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Open models sometimes capitalize meal types ("Breakfast") — normalize any
// "type" field whose lowercase form is a valid meal type, wherever it appears.
const MEAL_TYPE_SET = new Set(["breakfast", "lunch", "dinner", "snack"]);

function normalizeMealTypes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeMealTypes(item);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.type === "string" && MEAL_TYPE_SET.has(obj.type.toLowerCase())) {
      obj.type = obj.type.toLowerCase();
    }
    for (const value of Object.values(obj)) normalizeMealTypes(value);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// LOCAL_AI_MODEL may be a comma-separated fallback list; each model is tried
// with retries/backoff on rate limits before moving to the next.
function localModels(): string[] {
  return LOCAL_AI_MODEL.split(",").map((m) => m.trim()).filter(Boolean);
}

async function localStructuredChat<T>(
  schema: z.ZodType<T>,
  schemaName: string,
  messages: LocalChatMessage[],
): Promise<T> {
  let lastError: Error = new Error("No local AI model configured.");
  for (const model of localModels()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await localStructuredChatOnce(schema, schemaName, messages, model);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = /\(429\)|\(5\d\d\)|Could not reach/.test(lastError.message);
        if (!retryable) break; // bad output shape → try the next model instead
        await sleep(2000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function localStructuredChatOnce<T>(
  schema: z.ZodType<T>,
  schemaName: string,
  messages: LocalChatMessage[],
  model: string,
): Promise<T> {
  const jsonSchema = z.toJSONSchema(schema);
  // Belt and suspenders: response_format enforces the schema on providers that
  // support it; the prompt instruction covers providers that silently ignore it.
  const withSchemaHint = messages.map((m, i) =>
    i === 0 && m.role === "system"
      ? {
          ...m,
          content:
            m.content +
            `\n\nRespond with ONLY a valid JSON object matching this JSON schema — no prose, no markdown fences, no explanation:\n${JSON.stringify(jsonSchema)}`,
        }
      : m,
  );
  let res: Response;
  try {
    res = await fetch(`${LOCAL_AI_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LOCAL_AI_API_KEY ? { Authorization: `Bearer ${LOCAL_AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: withSchemaHint,
        // Generous budget: reasoning models spend tokens thinking before the JSON.
        max_tokens: 16000,
        // Strict schema mode works reliably on real local servers (LM Studio,
        // Ollama) but several hosted free routes mishandle it and return empty
        // content — for those (detected by the API key) the prompt instruction
        // plus JSON extraction below does the job.
        ...(LOCAL_AI_API_KEY
          ? {}
          : {
              response_format: {
                type: "json_schema",
                json_schema: { name: schemaName, strict: true, schema: jsonSchema },
              },
            }),
      }),
    });
  } catch {
    throw new Error(
      `Could not reach the local AI server at ${LOCAL_AI_URL}. Is LM Studio (or Ollama) running with its server enabled?`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Local AI server error (${res.status}): ${body.slice(0, 300) || "no details"}`,
    );
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("The local AI returned an empty response.");
  // Models may wrap JSON in markdown fences or preface it with thinking text —
  // extract the outermost JSON object before parsing.
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("The local AI returned invalid JSON. Try a larger model or lower temperature.");
  }
  normalizeMealTypes(parsed);
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      "The local AI's answer didn't match the expected format. A larger model usually fixes this.",
    );
  }
  return validated.data;
}

// Free/hosted open-model routes are slow and unreliable on very long outputs,
// so the local provider generates the week one day per request and assembles
// it. Cuisine themes keep the days varied despite independence.
const DAY_THEMES = [
  "Mediterranean",
  "Asian-inspired",
  "Mexican-inspired",
  "Italian-inspired",
  "Middle Eastern",
  "classic comfort food, lightened up",
  "fresh and light",
] as const;

const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const DayMealsSchema = z.object({ meals: z.array(MealSchema) });

function isCleanName(name: string): boolean {
  const n = name.trim();
  if (n.length < 3 || n.length > 90) return false;
  if (/\?{2,}|\.{3,}/.test(n)) return false; // "??????" or "..."
  return /[a-zA-Z]{3,}/.test(n); // must contain a real word
}

// Deterministic quality gate. The model can't be trusted to self-police, so code
// decides whether a day is acceptable and, if not, states exactly what to fix.
// (See VISION.md: correctness lives in code, not in the model.)
function dayQualityIssues(meals: Meal[], profile: UserProfile): string[] {
  const issues: string[] = [];
  const split = mealSplit(profile);

  if (meals.length !== profile.mealsPerDay) {
    issues.push(
      `Return exactly ${profile.mealsPerDay} meals (${split
        .map((s) => s.type)
        .join(", ")}); you returned ${meals.length}.`,
    );
  }
  for (const s of split) {
    if (!meals.some((m) => m.type === s.type)) issues.push(`Add the missing ${s.type} meal.`);
  }

  const dayTotal = meals.reduce((sum, m) => sum + (m.calories || 0), 0);
  if (dayTotal < profile.targetCalories * 0.8) {
    issues.push(
      `The day totals only ${Math.round(dayTotal)} kcal; it must be near ${profile.targetCalories} kcal — increase portions.`,
    );
  } else if (dayTotal > profile.targetCalories * 1.2) {
    issues.push(
      `The day totals ${Math.round(dayTotal)} kcal; it must be near ${profile.targetCalories} kcal — reduce portions.`,
    );
  }

  for (const m of meals) {
    const share = split.find((s) => s.type === m.type)?.share ?? 1 / profile.mealsPerDay;
    const mealTarget = Math.round(profile.targetCalories * share);
    if ((m.calories || 0) < mealTarget * 0.5) {
      issues.push(
        `"${m.name || m.type}" has only ${Math.round(m.calories || 0)} kcal; a ${m.type} should be around ${mealTarget} kcal.`,
      );
    }
    if (!isCleanName(m.name)) issues.push(`Give the ${m.type} a real dish name (got "${m.name}").`);
    if (m.steps.length < 2) issues.push(`"${m.name || m.type}" needs at least 2 clear steps.`);
    if (m.ingredients.length < 1) issues.push(`"${m.name || m.type}" needs a list of ingredients.`);
    if (m.ingredients.length > profile.maxIngredients + 1) {
      issues.push(
        `"${m.name || m.type}" uses ${m.ingredients.length} ingredients; keep it to about ${profile.maxIngredients}.`,
      );
    }
    if (m.timeMinutes && m.timeMinutes > profile.maxCookTime + 5) {
      issues.push(
        `"${m.name || m.type}" takes ${m.timeMinutes} min; keep it within ${profile.maxCookTime} min (±5).`,
      );
    }
  }
  return issues;
}

// Last-resort safety net if the model still won't balance a day after all
// retries: scale calories/macros proportionally so the UI never shows a broken
// day (e.g. a 10-kcal Friday). Only kicks in when the day is wildly off.
function normalizeDayCalories(meals: Meal[], profile: UserProfile): Meal[] {
  const total = meals.reduce((s, m) => s + (m.calories || 0), 0);
  if (meals.length === 0 || total <= 0) return meals;
  const factor = profile.targetCalories / total;
  if (factor > 0.7 && factor < 1.3) return meals; // close enough — keep honest values
  return meals.map((m) => ({
    ...m,
    calories: Math.round((m.calories || 0) * factor),
    proteinGrams: Math.round((m.proteinGrams || 0) * factor),
    carbsGrams: Math.round((m.carbsGrams || 0) * factor),
    fatGrams: Math.round((m.fatGrams || 0) * factor),
  }));
}

function dayUserPrompt(
  profile: UserProfile,
  day: string,
  theme: string,
  variety: VarietyContext,
): string {
  const types = mealSplit(profile)
    .map((s) => s.type)
    .join(", ");
  return [
    `Plan ${day}'s meals (exactly ${profile.mealsPerDay}: ${types}) for this person:`,
    profileDescription(profile),
    macroTargetText(profile),
    prefsPromptText(profile),
    varietyPromptText(variety),
    `Cuisine inspiration for this day: ${theme}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function localGenerateDay(
  profile: UserProfile,
  day: (typeof DAY_NAMES)[number],
  theme: string,
  variety: VarietyContext,
): Promise<{ day: (typeof DAY_NAMES)[number]; meals: Meal[] }> {
  const basePrompt = dayUserPrompt(profile, day, theme, variety);
  let best: Meal[] = [];
  let bestCount = Infinity;
  let feedback = "";

  for (let attempt = 0; attempt < 4; attempt++) {
    const { meals } = await localStructuredChat(DayMealsSchema, "day_meals", [
      { role: "system", content: planSystemPrompt() },
      { role: "user", content: basePrompt + feedback },
    ]);
    const issues = dayQualityIssues(meals, profile);
    // Cross-day diversity: reject a day that leans only on already-common proteins.
    const proteins = [...new Set(meals.flatMap(detectProteins))];
    const bringsFreshProtein = proteins.some((p) => (variety.proteinDays[p] ?? 0) < 2);
    if (proteins.length > 0 && !bringsFreshProtein) {
      issues.push(
        `This day only reuses proteins already common this week (${proteins.join(", ")}); switch the main protein.`,
      );
    }
    if (issues.length === 0) {
      console.log(`[plan] ${day} generated (${meals.length} meals) OK`);
      return { day, meals };
    }
    if (issues.length < bestCount) {
      best = meals;
      bestCount = issues.length;
    }
    feedback = `\n\nYour previous attempt had these problems — fix ALL of them and return the complete corrected day:\n${issues
      .map((i) => `• ${i}`)
      .join("\n")}`;
    console.log(`[plan] ${day} attempt ${attempt + 1}: ${issues.length} issue(s) — retrying`);
  }

  const meals = normalizeDayCalories(best, profile);
  console.log(
    `[plan] ${day} best-effort after retries (${meals.length} meals, ${bestCount} residual issue(s))`,
  );
  return { day, meals };
}

async function localGeneratePlan(profile: UserProfile): Promise<WeekPlan> {
  // Sequential by design: each day sees which proteins/dishes earlier days used,
  // so the week stays varied instead of collapsing to the model's default pick.
  // Shuffling the cuisine themes also makes "generate again" produce a fresh week.
  const themes = shuffle([...DAY_THEMES]);
  const variety: VarietyContext = { proteinDays: {}, usedNames: [] };
  const days: { day: (typeof DAY_NAMES)[number]; meals: Meal[] }[] = [];

  for (let i = 0; i < DAY_NAMES.length; i++) {
    const result = await localGenerateDay(profile, DAY_NAMES[i], themes[i % themes.length], variety);
    days.push(result);
    // Fold this day into the running variety context for the next day.
    for (const p of new Set(result.meals.flatMap(detectProteins))) {
      variety.proteinDays[p] = (variety.proteinDays[p] ?? 0) + 1;
    }
    for (const m of result.meals) variety.usedNames.push(m.name);
  }

  const totalKcal = days.reduce((s, d) => s + d.meals.reduce((m, x) => m + x.calories, 0), 0);
  const avg = Math.round(totalKcal / days.length);
  return {
    days,
    weekSummary: `A varied week averaging about ${avg.toLocaleString()} kcal per day, tailored to your goals and preferences.`,
  };
}

async function localRunAssistant(
  profile: UserProfile,
  plan: WeekPlan,
  history: ChatMessage[],
): Promise<AssistantResponse> {
  return localStructuredChat(AssistantResponseSchema, "assistant_response", [
    { role: "system", content: assistantSystemPrompt(profile, plan) },
    ...history.map((m) => ({ role: m.role, content: m.text })),
  ]);
}

// ---------------------------------------------------------------------------
// Public API — dispatches to the resolved provider
// ---------------------------------------------------------------------------

export async function generatePlan(profile: UserProfile): Promise<WeekPlan> {
  const p = withTargetDefaults(profile);
  // Opt-in DB engine (Phase A): select from the curated recipe library instead
  // of generating with the LLM. Off unless PLAN_ENGINE=db, so the live path is
  // unchanged. This is the direction the app moves toward (see VISION.md).
  if (process.env.PLAN_ENGINE === "db") return rebalanceWeek(selectWeekFromDb(p), p);
  return resolveProvider() === "local" ? localGeneratePlan(p) : claudeGeneratePlan(p);
}

export async function runAssistant(
  profile: UserProfile,
  plan: WeekPlan,
  history: ChatMessage[],
): Promise<AssistantResponse> {
  const p = withTargetDefaults(profile);
  return resolveProvider() === "local"
    ? localRunAssistant(p, plan, history)
    : claudeRunAssistant(p, plan, history);
}

// ---------------------------------------------------------------------------
// Conversational edits: the LLM only INTERPRETS the message into a structured
// EditIntent; the database (applyEdit in recipeDb) executes it. This keeps
// plans accurate/cheap while letting the user talk naturally.
// ---------------------------------------------------------------------------

export function assistantTurnSystemPrompt(profile: UserProfile, plan: WeekPlan): string {
  const stats = plan.days.map((d) => ({
    day: d.day,
    kcal: d.meals.reduce((s, m) => s + m.calories, 0),
    protein: d.meals.reduce((s, m) => s + m.proteinGrams, 0),
    carbs: d.meals.reduce((s, m) => s + m.carbsGrams, 0),
    fat: d.meals.reduce((s, m) => s + m.fatGrams, 0),
    fiber: d.meals.reduce((s, m) => s + (m.fiberGrams ?? 0), 0),
    meals: d.meals,
  }));
  const n = stats.length || 1;
  const avg = (k: "kcal" | "protein" | "carbs" | "fat" | "fiber") =>
    Math.round(stats.reduce((s, d) => s + d[k], 0) / n);
  const avgKcal = avg("kcal");
  const avgProtein = avg("protein");
  const avgFiber = avg("fiber");
  const planText = stats
    .map((d) => {
      const meals = d.meals
        .map(
          (m) =>
            `${m.type} ${m.name} (${m.calories} kcal, ${m.proteinGrams}g P, ${m.carbsGrams}g C, ${m.fatGrams}g F, ${m.fiberGrams ?? 0}g fiber, ${m.timeMinutes}min)`,
        )
        .join("; ");
      return `${d.day} — day total ${d.kcal} kcal, ${d.protein}g protein, ${d.carbs}g carbs, ${d.fat}g fat, ${d.fiber}g fiber: ${meals}`;
    })
    .join("\n");
  return (
    "You are the meal-plan assistant. Read the user's message and the recent conversation, then output JSON: a natural 'reply' plus a list of 'operations' (tool calls) the app runs in order. Use the conversation to resolve references ('do that', 'only Tuesday', 'make it 1500').\n\n" +
    "TOOLS — each operation has a 'tool' and ONLY the fields that tool actually needs. OMIT every field you are not setting. Never write nulls, and never invent a value for a field the user did not mention.\n" +
    "- update_profile: change a WEEK-WIDE setting and rebuild the week. Fields: diet, budget, excludeFoods, targetCalories, targetProtein, targetCarbs, targetFat, targetFiber, maxCookTime, cuisine. The plan re-solves to hit any macro target you set. Use for 'make it cheaper', 'go vegetarian', 'no onions', 'no oven' (excludeFoods:['bake','roast','oven']), '2000 calories a day', 'set my protein to 180', '30g fiber a day'.\n" +
    "- regenerate_week: rebuild the whole week (optional cuisine, targetFiber, useIngredients, boostNutrient). Use for 'give me a new plan', 'make the week Italian', 'use up the chicken and rice I have' (useIngredients:['chicken','rice']).\n" +
    "- boostNutrient (on update_profile / regenerate_week / regenerate_day): favour foods rich in one nutrient — iron, calcium, magnesium, potassium, zinc, vitD, vitC, folate, b12. Use for 'I'm low on iron', 'I need more vitamin D', 'my doctor said my B12 is low'. The app computes the real amounts from USDA data and reports them; you never state a nutrient number yourself.\n" +
    "- regenerate_day: rebuild ONE day; requires day. Optional diet, targetCalories, cuisine, targetFiber apply to THAT day only (not saved). Use for 'make Tuesday vegetarian', 'change Monday to 1500', 'make Friday Asian'.\n" +
    "- swap_meal: replace one meal with a specific dish; requires day, mealType, dish. Use for 'swap Monday breakfast for cottage cheese pancakes'. By DEFAULT the app keeps that day on the user's macro targets by adjusting the other meals' portions (like a nutritionist fitting a treat in) — you don't ask for that, it's automatic. Set preserveMacros:false ONLY when the user signals they don't care this time ('cheat day', 'treat', 'whatever, I don't care about macros'). You never need to compute macros — the app does the math.\n" +
    "- compute_targets: work out the user's calories/protein/carbs/fat from their body and goal, then rebuild the week. Needs age, heightCm, weightKg, sex (male|female), activity (sedentary|light|moderate|active|very_active) and goal (lose_weight|maintain|build_muscle). Use for 'work out my macros', 'I'm 30, 80kg, 180cm, male, train 4x a week, want to lose fat'. If any fact is missing, ASK for it (operations: []) — never guess someone's weight. The app does the arithmetic and reports the numbers; you never compute them.\n" +
    "- log_meal: the user says what they ACTUALLY ate ('I had pizza for lunch', 'I ate a burger'). Requires day + mealType + dish. The app locks that meal and everything earlier in the day, then re-solves the meals still ahead to keep the day on target. If the food isn't in the library, pass loggedCalories (and loggedProtein if they said it); if they didn't say, the app will ask. Never estimate the calories yourself.\n" +
    "- eating_out: the user will eat a meal OUT, in the future ('I'm going to a restaurant Friday', 'dinner at my parents Saturday', 'work lunch on Tuesday'). Requires day + mealType. Pass estimatedCalories ONLY if they give a number. The app reserves calories for it, lightens the rest of that day, and tells them what to order. Never guess the calories yourself. Contrast with log_meal, which is for a meal ALREADY EATEN.\n" +
    "- weekly_report: the user asks how their week looks overall ('how am I doing?', 'am I hitting my protein?', 'am I missing any vitamins?', 'review my week'). Changes NOTHING. The app computes the averages and the nutrient gaps from the real plan and appends them; your reply just introduces them. Never state a number yourself.\n" +
    "- explain_meal: the user asks WHY a meal is in their plan ('why did you give me salmon on tuesday?', 'why is this here?', 'what's this doing in my plan'). Requires day + mealType. Changes nothing. The app computes the reasons — macros, cook time, cost, ingredient reuse, nutrients — and appends them. Never invent a reason.\n" +
    "- answer: no change; just answering a question.\n\n" +
    "Rules:\n" +
    "- Only a question → operations: []. Put the answer in reply. For facts (calories/protein/fiber/time) use the EXACT numbers below; the AVERAGES line is already per-day, so never sum days for an average and never guess.\n" +
    "- Compound requests → SEVERAL operations, or one update_profile with several fields.\n" +
    "- Use word stems in excludeFoods so 'bake' also matches 'baked'/'baking'.\n" +
    "- Macros are kept on target automatically. Only think about preserveMacros:false when the user explicitly wants to go off-plan for a treat.\n" +
    "- Emit ONLY the fields you mean. 'make Tuesday vegetarian' is exactly {tool:regenerate_day, day:Tuesday, diet:vegetarian} — nothing else.\n" +
    "- reply: natural and friendly — say what you did or answer the question.\n\n" +
    `Weekly AVERAGES per day: ${avgKcal} kcal, ${avgProtein}g protein, ${avgFiber}g fiber.\n` +
    `Current plan:\n${planText}\n\n` +
    `Profile: diet=${profile.diet}, budget=${profile.budget}, ~${profile.targetCalories} kcal/day, dislikes=${profile.dislikes || "none"}.\n\n` +
    "Examples (operations shown):\n" +
    "'make it cheaper and vegetarian, no onions' → [{tool:update_profile, budget:low, diet:vegetarian, excludeFoods:['onions']}]\n" +
    "'make Tuesday vegetarian' → [{tool:regenerate_day, day:Tuesday, diet:vegetarian}]\n" +
    "'change Monday to 1500 calories' → [{tool:regenerate_day, day:Monday, targetCalories:1500}]\n" +
    "'swap Monday breakfast for cottage cheese pancakes' → [{tool:swap_meal, day:Monday, mealType:breakfast, dish:'cottage cheese pancakes'}] (macros kept on target automatically)\n" +
    "'I want pancakes Tuesday but I'm staying lean' → [{tool:swap_meal, day:Tuesday, mealType:breakfast, dish:'protein pancakes'}] (app holds protein/calories; you just pick the dish)\n" +
    "'it's my cheat day — swap Saturday dinner for pizza' → [{tool:swap_meal, day:Saturday, mealType:dinner, dish:'pizza', preserveMacros:false}]\n" +
    "'I have no oven' → [{tool:update_profile, excludeFoods:['bake','roast','oven']}]\n" +
    "'give Friday an Asian theme' → [{tool:regenerate_day, day:Friday, cuisine:'asian'}]\n" +
    "'I want 30g fiber a day' → [{tool:update_profile, targetFiber:30}]\n" +
    "'bump my protein to 180g' → [{tool:update_profile, targetProtein:180}]\n" +
    "'I've got salmon and broccoli to use up' → [{tool:regenerate_week, useIngredients:['salmon','broccoli']}]\n" +
    "'I'm low on iron' → [{tool:update_profile, boostNutrient:'iron'}] (the app reports the actual mg; don't guess a number)\n" +
    "'my doctor says my vitamin D is low' → [{tool:update_profile, boostNutrient:'vitD'}]\n" +
    "'make Monday high protein' → [{tool:regenerate_day, day:Monday, targetProtein:200}]\n" +
    "'what is my average fiber?' → operations:[], reply gives the AVERAGES fiber number."
  );
}

type Turn = { role: "user" | "assistant"; content: string };

async function claudeParseAssistantTurn(profile: UserProfile, plan: WeekPlan, turns: Turn[]) {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: assistantTurnSystemPrompt(profile, plan),
    messages: turns,
    output_config: { format: zodOutputFormat(AssistantTurnSchema) },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The assistant could not understand that.");
  return parsed;
}

export async function parseAssistantTurn(
  profile: UserProfile,
  plan: WeekPlan,
  history: ChatMessage[],
): Promise<AssistantTurn> {
  const p = withTargetDefaults(profile);
  // Feed the recent conversation so follow-ups ("only Tuesday", "do that") resolve.
  const turns: Turn[] = history.slice(-8).map((m) => ({ role: m.role, content: m.text }));
  if (resolveProvider() === "local") {
    return localStructuredChat(AssistantTurnSchema, "assistant_turn", [
      { role: "system", content: assistantTurnSystemPrompt(p, plan) },
      ...turns,
    ]);
  }
  return claudeParseAssistantTurn(p, plan, turns);
}
