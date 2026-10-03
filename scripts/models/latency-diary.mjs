/**
 * Latency diary — one probe per model every INTERVAL_MIN minutes, for as long as it runs.
 *
 *   LOCAL_AI_API_KEY=... MODELS="a,b,c" node scripts/models/latency-diary.mjs
 *   (optional) BASE_URL=... INTERVAL_MIN=10 TIMEOUT_S=180 OUT=data/eval-runs/latency-diary-<date>.jsonl
 *
 * Why: on a free tier, latency is a property of the queue at that moment, not of the model. A single
 * sweep caught Nemotron-Ultra-550B at 7 s and at 46 s for the same request. "Reliable response time"
 * is a distribution over a day, so this records one call per model per interval and appends a line of
 * JSON each time — append-only, so it survives being killed, and a reader can compute median / p90 /
 * failure rate per hour. The request is the same realistic nutritionist prompt the sweep uses.
 *
 * Output cap 2000, not the sweep's 400: reasoning models (GLM-5.3, Kimi K3) think before they write,
 * and at 400 they came back with empty content — a harness failure that would read as a model one.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const KEY = process.env.LOCAL_AI_API_KEY ?? "";
const MODELS = (process.env.MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN ?? 10);
const TIMEOUT_S = Number(process.env.TIMEOUT_S ?? 180);
const day = new Date().toISOString().slice(0, 10);
const OUT = process.env.OUT ?? join(process.cwd(), "data", "eval-runs", `latency-diary-${day}.jsonl`);

const SYSTEM = "You are NutriFlow's assistant — a warm, sharp personal nutritionist. The user has a weekly meal plan (~2000 kcal, 150 g protein, 3 meals/day). Reply in 2-3 friendly sentences.";
const USER = "i've been really tired lately and i think i want to eat more vegetarian, but i don't want to lose protein. what would you change in my week?";

if (!MODELS.length || !KEY) { console.error("set MODELS and LOCAL_AI_API_KEY"); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });

async function probe(model) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_S * 1000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, temperature: 0.3, max_tokens: 2000, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }] }),
    });
    const text = await res.text();
    const seconds = (performance.now() - t0) / 1000;
    let content = "", outTokens = null;
    try { const j = JSON.parse(text); content = (j.choices?.[0]?.message?.content ?? "").trim(); outTokens = j.usage?.completion_tokens ?? null; } catch { /* non-JSON error body */ }
    return { ok: res.ok && content.length > 0, status: res.status, seconds: +seconds.toFixed(2), outTokens, err: res.ok ? (content ? undefined : "empty") : text.slice(0, 120) };
  } catch (e) {
    return { ok: false, status: 0, seconds: +((performance.now() - t0) / 1000).toFixed(2), err: e.name === "AbortError" ? `timeout ${TIMEOUT_S}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`latency diary → ${OUT}\n${MODELS.length} models every ${INTERVAL_MIN} min\n`);
for (;;) {
  const at = new Date().toISOString();
  // Probe the models concurrently — one call each — so a round takes as long as its slowest model.
  const results = await Promise.all(MODELS.map(async (m) => ({ at, model: m, ...(await probe(m)) })));
  for (const r of results) {
    appendFileSync(OUT, JSON.stringify(r) + "\n");
    console.log(`${at.slice(11, 19)} ${r.ok ? "ok " : "-- "} ${r.model.padEnd(40)} ${String(r.seconds).padStart(7)}s ${r.ok ? "" : r.err ?? r.status}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60 * 1000));
}
