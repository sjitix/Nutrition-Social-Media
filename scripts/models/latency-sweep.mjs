/**
 * Latency sweep — every chat model reachable on an OpenAI-compatible endpoint, measured live.
 *
 *   LOCAL_AI_API_KEY=nvapi-... node scripts/models/latency-sweep.mjs
 *   (optional) BASE_URL=... PROBES=2 CONCURRENCY=3 TIMEOUT_S=90 ONLY=regex
 *
 * Why it exists: latency on a free tier is a property of WHERE a model is hosted and how deep its
 * queue is, not of the model. K3 answered in ~1 s of compute after ~250 s of queue; the models named
 * "flash" timed out. So the only honest latency number is one measured against the real endpoint.
 *
 * Each model gets PROBES calls with a realistic nutritionist request. Recorded per call: HTTP status,
 * time to first byte of the response, total seconds, output tokens, and whether the reply is usable
 * (non-empty content). Writes data/eval-runs/<ts>-latency-sweep.json. A model whose calls all failed
 * is reported as unreachable, never averaged in.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const KEY = process.env.LOCAL_AI_API_KEY ?? "";
const PROBES = Number(process.env.PROBES ?? 2);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const TIMEOUT_S = Number(process.env.TIMEOUT_S ?? 90);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
// Keyless public endpoints (OVHcloud AI Endpoints' anonymous tier) must get NO Authorization header.
const AUTH = KEY ? { Authorization: `Bearer ${KEY}` } : {};
// Space the probes of one model at least this far apart (OVH anonymous: 2 req/min per model per IP).
const GAP_MS = Number(process.env.GAP_MS ?? 1500);

// Not chat models, or not useful as an assistant brain.
const EXCLUDE = /embed|guard|safety|reward|parse|translate|retriever|vision|vlm|omni|code|coder|codestral|codegemma|diffusion|recurrentgemma|chatqa|topic-control|content-safety|gemma-2b|sea-lion|zamba|minitron|granite-3\.0-3b/i;

const SYSTEM = `You are NutriFlow's assistant — a warm, sharp personal nutritionist. The user has a weekly meal plan (~2000 kcal, 150 g protein, 3 meals/day). Reply in 2-3 friendly sentences.`;
const USER = `i've been really tired lately and i think i want to eat more vegetarian, but i don't want to lose protein. what would you change in my week?`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listModels() {
  const r = await fetch(`${BASE_URL}/models`, { headers: AUTH });
  if (!r.ok) throw new Error(`models list ${r.status}`);
  const j = await r.json();
  return (j.data ?? []).map((m) => m.id).sort();
}

async function probe(model) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_S * 1000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 400,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
      }),
    });
    const ttfb = (performance.now() - t0) / 1000;
    const text = await res.text();
    const total = (performance.now() - t0) / 1000;
    if (!res.ok) return { ok: false, status: res.status, ttfb, total, err: text.slice(0, 140) };
    let j; try { j = JSON.parse(text); } catch { return { ok: false, status: res.status, ttfb, total, err: "bad json" }; }
    const msg = j.choices?.[0]?.message ?? {};
    const content = (msg.content ?? "").trim();
    return {
      ok: content.length > 0, status: res.status, ttfb, total,
      outTokens: j.usage?.completion_tokens ?? null,
      reasoning: Boolean(msg.reasoning_content || msg.reasoning),
      sample: content.replace(/\s+/g, " ").slice(0, 220),
      err: content.length ? undefined : "empty content",
    };
  } catch (e) {
    return { ok: false, status: 0, total: (performance.now() - t0) / 1000, err: e.name === "AbortError" ? `timeout ${TIMEOUT_S}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const all = await listModels();
const models = all.filter((m) => !EXCLUDE.test(m) && (!ONLY || ONLY.test(m)));
console.log(`endpoint ${BASE_URL}\n${all.length} models listed, ${models.length} chat candidates, ${PROBES} probes each, concurrency ${CONCURRENCY}\n`);

const results = [];
let next = 0;
async function worker() {
  for (let i = next++; i < models.length; i = next++) {
    const model = models[i];
    const calls = [];
    for (let p = 0; p < PROBES; p++) {
      calls.push(await probe(model));
      if (calls[0].status === 404 || calls[0].status === 410) break; // not provisioned / EOL — don't retry
      await sleep(GAP_MS);
    }
    const good = calls.filter((c) => c.ok);
    const row = {
      model,
      reachable: good.length > 0,
      okCalls: good.length, calls: calls.length,
      medianTotalS: median(good.map((c) => c.total)),
      bestTotalS: good.length ? Math.min(...good.map((c) => c.total)) : null,
      medianOutTokens: median(good.map((c) => c.outTokens).filter((x) => x != null)),
      reasoning: good.some((c) => c.reasoning),
      lastError: calls.find((c) => !c.ok)?.err ?? null,
      lastStatus: calls[calls.length - 1]?.status ?? null,
      sample: good[0]?.sample ?? null,
    };
    results.push(row);
    console.log(`${row.reachable ? "OK " : "-- "} ${model.padEnd(52)} ${row.reachable ? `${row.medianTotalS.toFixed(1)}s median (best ${row.bestTotalS.toFixed(1)}s, ${row.okCalls}/${row.calls})` : `${row.lastStatus} ${row.lastError ?? ""}`.slice(0, 60)}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length) }, worker));

results.sort((a, b) => (b.reachable - a.reachable) || ((a.medianTotalS ?? 1e9) - (b.medianTotalS ?? 1e9)));
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(process.cwd(), "data", "eval-runs");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${ts}-latency-sweep.json`);
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), endpoint: BASE_URL, probes: PROBES, timeoutS: TIMEOUT_S, system: SYSTEM, user: USER, results }, null, 2));
console.log(`\nreachable: ${results.filter((r) => r.reachable).length}/${results.length}\nwrote ${out}`);
