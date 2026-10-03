/**
 * LATENCY ANATOMY — where a big model's seconds go on OUR prompt, and which lever would cut them.
 *
 *   LOCAL_AI_URL=... LOCAL_AI_MODEL=... LOCAL_AI_API_KEY=... node <bundle of this file>
 *   (optional) VARIANTS=asis,short-thinking,no-plan,no-reasoning  GAP_MS=8000  REPEAT=1
 *
 * The owner asked how developers make a big model faster. The answers differ by where the time goes:
 *   - time to first token (queue + reading the ~5k-token prompt): fixed by a faster host, a shorter
 *     prompt, or prefix caching;
 *   - hidden reasoning tokens (a reasoning model "thinks" before it writes): fixed by turning reasoning
 *     down or off;
 *   - the visible `thinking` field our schema asks for: fixed by asking for one sentence;
 *   - the reply and operations themselves: the irreducible part.
 * So this streams real calls — the REAL agent system prompt (assistantV2SystemPrompt, agent mode, the
 * loop-eval's fixed week and date) — and splits each one: seconds to first token, seconds generating,
 * reasoning characters, and the characters of thinking / reply / operations in the JSON it returns.
 *
 * Variants (each a change to the REQUEST, never to app code):
 *   asis            — the prompt the app sends today
 *   short-thinking  — one appended line: keep "thinking" to one short sentence
 *   no-plan         — the 7-day plan text swapped for a one-line summary (how much the prefill costs)
 *   no-reasoning    — chat_template_kwargs {enable_thinking:false} + reasoning_effort "low" (ignored
 *                     by hosts that don't support them; the reasoning count says whether it took)
 * Calls run one at a time with a gap, so a free tier's rate limit is not tripped.
 * Writes data/eval-runs/<ts>-anatomy-<model>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantV2SystemPrompt } from "@/lib/promptV2";
import { selectWeekFromDb, rebalanceWeek, withSeed } from "@/lib/recipeDb";
import type { UserProfile, WeekPlan } from "@/lib/types";

const BASE = (process.env.LOCAL_AI_URL ?? "").replace(/\/$/, "");
const MODEL = process.env.LOCAL_AI_MODEL ?? "";
const KEY = process.env.LOCAL_AI_API_KEY ?? "";
const GAP_MS = Number(process.env.GAP_MS ?? 8000);
const REPEAT = Number(process.env.REPEAT ?? 1);
const VARIANTS = (process.env.VARIANTS ?? "asis,short-thinking,no-plan,no-reasoning").split(",").map((s) => s.trim());
if (!BASE || !MODEL) { console.error("set LOCAL_AI_URL and LOCAL_AI_MODEL"); process.exit(1); }

const PROFILE: UserProfile = {
  goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200,
  fatGrams: 65, maxCookTime: 30, maxIngredients: 8,
};
const PLAN: WeekPlan = withSeed(20261003, () => rebalanceWeek(selectWeekFromDb(PROFILE), PROFILE));
const TODAY = "2026-10-05";
const promptFn = assistantV2SystemPrompt as (p: UserProfile, w: WeekPlan, o?: { agent?: boolean; today?: string }) => string;
const SYSTEM = promptFn(PROFILE, PLAN, { agent: true, today: TODAY });

const MESSAGES = [
  "make tuesday vegetarian",
  "i've been feeling really run down and tired lately",
  "add a high-protein snack in the afternoons",
  "what's in thursday's dinner?",
];

function systemFor(variant: string): string {
  if (variant === "short-thinking") return `${SYSTEM}\n\nKeep "thinking" to ONE short sentence.`;
  if (variant === "no-plan") {
    // Replace the per-day plan lines with one line; everything else identical.
    return SYSTEM.replace(/Current plan:\n[\s\S]*?\nProfile:/, "Current plan: 7 days, 3 meals a day (use get_plan to see it).\nProfile:");
  }
  return SYSTEM;
}

interface Row {
  variant: string; message: string; ok: boolean; status: number; error?: string;
  ttft: number | null; total: number; genSeconds: number | null;
  reasoningChars: number; contentChars: number; thinkingChars: number; replyChars: number; opsChars: number;
  promptTokens: number | null; completionTokens: number | null; systemChars: number;
}

async function call(variant: string, message: string): Promise<Row> {
  const system = systemFor(variant);
  const body: Record<string, unknown> = {
    model: MODEL, temperature: 0, max_tokens: 4000, stream: true, stream_options: { include_usage: true },
    messages: [{ role: "system", content: system }, { role: "user", content: message }],
  };
  if (variant === "no-reasoning") { body.chat_template_kwargs = { enable_thinking: false }; body.reasoning_effort = "low"; }
  const t0 = performance.now();
  let ttft: number | null = null, reasoning = "", content = "", status = 0;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    status = res.status;
    if (!res.ok || !res.body) {
      const text = await res.text();
      return { variant, message, ok: false, status, error: text.slice(0, 200), ttft: null, total: (performance.now() - t0) / 1000, genSeconds: null, reasoningChars: 0, contentChars: 0, thinkingChars: 0, replyChars: 0, opsChars: 0, promptTokens: null, completionTokens: null, systemChars: system.length };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          const d = j.choices?.[0]?.delta ?? {};
          const r = d.reasoning_content ?? d.reasoning ?? "";
          const c = d.content ?? "";
          if ((r || c) && ttft === null) ttft = (performance.now() - t0) / 1000;
          reasoning += r;
          content += c;
        } catch { /* keep-alive or partial line */ }
      }
    }
  } catch (e) {
    return { variant, message, ok: false, status, error: (e as Error).message.slice(0, 200), ttft, total: (performance.now() - t0) / 1000, genSeconds: null, reasoningChars: reasoning.length, contentChars: content.length, thinkingChars: 0, replyChars: 0, opsChars: 0, promptTokens: null, completionTokens: null, systemChars: system.length };
  }
  const total = (performance.now() - t0) / 1000;
  // Some hosts inline reasoning as <think>…</think> in content.
  const inline = content.match(/<think>([\s\S]*?)<\/think>/);
  if (inline) { reasoning += inline[1]; content = content.replace(inline[0], ""); }
  let thinkingChars = 0, replyChars = 0, opsChars = 0;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j) { thinkingChars = String(j.thinking ?? "").length; replyChars = String(j.reply ?? "").length; opsChars = JSON.stringify(j.operations ?? []).length; }
  } catch { /* unparseable — still timed */ }
  return {
    variant, message, ok: true, status, ttft, total, genSeconds: ttft === null ? null : total - ttft,
    reasoningChars: reasoning.length, contentChars: content.length, thinkingChars, replyChars, opsChars,
    promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null, systemChars: system.length,
  };
}

const rows: Row[] = [];
console.log(`latency anatomy · ${MODEL} · system prompt ${SYSTEM.length} chars · variants ${VARIANTS.join(", ")}\n`);
for (let rep = 0; rep < REPEAT; rep++) {
  for (const message of MESSAGES) {
    for (const v of VARIANTS) {
      const r = await call(v, message);
      rows.push(r);
      console.log(`${r.ok ? "  " : "!!"} ${v.padEnd(15)} ${r.total.toFixed(1).padStart(6)}s  ttft ${r.ttft?.toFixed(1) ?? "—"}s  gen ${r.genSeconds?.toFixed(1) ?? "—"}s  reasoning ${r.reasoningChars}c  thinking ${r.thinkingChars}c  reply ${r.replyChars}c  ops ${r.opsChars}c  tok ${r.promptTokens ?? "?"}/${r.completionTokens ?? "?"}  "${message.slice(0, 32)}"${r.error ? `  ${r.status} ${r.error}` : ""}`);
      await new Promise((res) => setTimeout(res, GAP_MS));
    }
  }
}

const summary: Record<string, unknown> = {};
for (const v of VARIANTS) {
  const g = rows.filter((r) => r.variant === v && r.ok);
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null; };
  summary[v] = {
    ok: `${g.length}/${rows.filter((r) => r.variant === v).length}`,
    medianTotal: med(g.map((r) => r.total)),
    medianTtft: med(g.map((r) => r.ttft ?? 0)),
    medianGen: med(g.map((r) => r.genSeconds ?? 0)),
    medianReasoningChars: med(g.map((r) => r.reasoningChars)),
    medianThinkingChars: med(g.map((r) => r.thinkingChars)),
    medianCompletionTokens: med(g.map((r) => r.completionTokens ?? 0)),
    medianPromptTokens: med(g.map((r) => r.promptTokens ?? 0)),
  };
}
console.log("\n" + JSON.stringify(summary, null, 1));
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(process.cwd(), "data", "eval-runs");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${ts}-anatomy-${MODEL.replace(/[^a-z0-9.-]+/gi, "-")}.json`);
writeFileSync(out, JSON.stringify({ kind: "latency-anatomy", ranAt: new Date().toISOString(), model: MODEL, endpoint: BASE, systemChars: SYSTEM.length, summary, rows }, null, 2));
console.log(`wrote ${out}`);
