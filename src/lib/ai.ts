import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  AssistantResponseSchema,
  WeekPlanSchema,
  type AssistantResponse,
  type ChatMessage,
  type UserProfile,
  type WeekPlan,
} from "./types";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  return new Anthropic();
}

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

export async function generatePlan(profile: UserProfile): Promise<WeekPlan> {
  const client = getClient();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system:
      "You are a professional nutritionist creating personalized weekly meal plans. " +
      PLAN_RULES,
    messages: [
      {
        role: "user",
        content: `Create a 7-day meal plan for this person:\n\n${profileDescription(profile)}\n\nIn weekSummary, write 1-2 friendly sentences about the week's plan and its approximate daily calories.`,
      },
    ],
    output_config: { format: zodOutputFormat(WeekPlanSchema) },
  });
  const plan = response.parsed_output;
  if (!plan) {
    throw new Error("The AI response could not be parsed into a meal plan.");
  }
  return plan;
}

export async function runAssistant(
  profile: UserProfile,
  plan: WeekPlan,
  history: ChatMessage[],
): Promise<AssistantResponse> {
  const client = getClient();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system:
      "You are the meal-plan assistant inside a meal planning app. The user has a current weekly plan and asks you to adjust it (swap meals, make a day vegetarian, make it cheaper, etc.) or asks questions about it.\n" +
      "Always return the FULL updated week plan. If the user's message doesn't require changing the plan, return the plan unchanged and set planChanged to false.\n" +
      "When you change meals, keep them consistent with the user's profile below and recalculate calories/macros honestly.\n" +
      PLAN_RULES +
      `\n\nUser profile:\n${profileDescription(profile)}\n\nCurrent week plan (JSON):\n${JSON.stringify(plan)}`,
    messages: history.map((m) => ({
      role: m.role,
      content: m.text,
    })),
    output_config: {
      format: zodOutputFormat(AssistantResponseSchema),
    },
  });
  const result = response.parsed_output;
  if (!result) {
    throw new Error("The AI response could not be parsed.");
  }
  return result;
}
