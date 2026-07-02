import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  AssistantResponseSchema,
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
- Meals must be realistic, tasty, and simple enough for a home cook; keep steps short (3-6 steps).
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
    "Always return the FULL updated week plan. If the user's message doesn't require changing the plan, return the plan unchanged and set planChanged to false.\n" +
    "When you change meals, keep them consistent with the user's profile below and recalculate calories/macros honestly.\n" +
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

async function localStructuredChat<T>(
  schema: z.ZodType<T>,
  schemaName: string,
  messages: LocalChatMessage[],
): Promise<T> {
  const jsonSchema = z.toJSONSchema(schema);
  let res: Response;
  try {
    res = await fetch(`${LOCAL_AI_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LOCAL_AI_API_KEY ? { Authorization: `Bearer ${LOCAL_AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: LOCAL_AI_MODEL,
        messages,
        max_tokens: 8000,
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema: jsonSchema },
        },
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The local AI returned invalid JSON. Try a larger model or lower temperature.");
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      "The local AI's answer didn't match the expected format. A larger model usually fixes this.",
    );
  }
  return validated.data;
}

async function localGeneratePlan(profile: UserProfile): Promise<WeekPlan> {
  return localStructuredChat(WeekPlanSchema, "week_plan", [
    { role: "system", content: planSystemPrompt() },
    { role: "user", content: planUserPrompt(profile) },
  ]);
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
