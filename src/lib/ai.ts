import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  AssistantResponseSchema,
  MealSchema,
  WeekPlanSchema,
  type AssistantResponse,
  type ChatMessage,
  type UserProfile,
  type WeekPlan,
} from "./types";

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

const PLAN_RULES = `Rules for the plan:
- Cover all 7 days, Monday through Sunday, with exactly the requested number of meals per day.
- Meals must be realistic, tasty, and simple enough for a home cook.
- The meal "type" field must be exactly one of: breakfast, lunch, dinner, snack (lowercase).
- Keep it concise: description is one short sentence, steps are 2-4 short instructions.
- Respect all allergies strictly — never include an allergen, even as a trace ingredient.
- Respect the diet type and avoid disliked foods.
- Reuse ingredients across the week where sensible so the grocery list stays affordable.
- Give honest calorie and macro estimates per meal.
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
    `\n\nUser profile:\n${profileDescription(profile)}\n\nCurrent week plan (JSON):\n${JSON.stringify(plan)}`
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
// so the local provider generates each day as a small parallel request and
// assembles the week. Cuisine themes keep the days varied despite independence.
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

async function localGeneratePlan(profile: UserProfile): Promise<WeekPlan> {
  // Two at a time: fast enough, and polite to rate-limited free routes.
  const days: { day: (typeof DAY_NAMES)[number]; meals: z.infer<typeof MealSchema>[] }[] = [];
  for (let i = 0; i < DAY_NAMES.length; i += 2) {
    const chunk = await Promise.all(
      DAY_NAMES.slice(i, i + 2).map(async (day, j) => {
        const { meals } = await localStructuredChat(DayMealsSchema, "day_meals", [
          { role: "system", content: planSystemPrompt() },
          {
            role: "user",
            content: `Plan ${day}'s meals (exactly ${profile.mealsPerDay}: breakfast, lunch, dinner${profile.mealsPerDay === 4 ? ", snack" : ""}) for this person:\n\n${profileDescription(profile)}\n\nCuisine inspiration for this day: ${DAY_THEMES[i + j]}.`,
          },
        ]);
        return { day, meals };
      }),
    );
    days.push(...chunk);
  }
  const totalKcal = days.reduce(
    (s, d) => s + d.meals.reduce((m, x) => m + x.calories, 0),
    0,
  );
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
  return resolveProvider() === "local"
    ? localGeneratePlan(profile)
    : claudeGeneratePlan(profile);
}

export async function runAssistant(
  profile: UserProfile,
  plan: WeekPlan,
  history: ChatMessage[],
): Promise<AssistantResponse> {
  return resolveProvider() === "local"
    ? localRunAssistant(profile, plan, history)
    : claudeRunAssistant(profile, plan, history);
}
