/**
 * Pace proxy — makes a rate-limited, keyless endpoint measurable.
 *
 *   node scripts/models/pace-proxy.mjs          (UPSTREAM, PORT, GAP_MS, MAX_TRIES, LOG optional)
 *   then point any OpenAI-compatible client at http://localhost:8787/v1
 *
 * Why: OVHcloud AI Endpoints serves big open models (Qwen3.5-397B, gpt-oss-120b, Llama-3.3-70B)
 * keyless — but at 2 requests/minute per IP per model, and it reports the limit as HTTP 200 with a
 * `{"message":"API rate limit exceeded"}` body. Both evals would grade that as the MODEL returning
 * garbage (a schema failure), not as infrastructure — WORKPLAN lesson 44 in a new disguise.
 *
 * So this sits between the evals (and the app's own adapter) and the upstream:
 *   - ONE upstream request in flight at a time, starts at least GAP_MS apart;
 *   - a rate-limit answer (429, or 200 with that body) is never passed on: it waits and retries,
 *     widening the gap each time, and only gives up (as a real 429) after MAX_TRIES;
 *   - it keeps a running total of PURE upstream seconds — time the model actually spent — exposed at
 *     GET /stats, so the loop eval can subtract the pacing it added and report honest latency;
 *   - every request is appended to LOG as a JSON line.
 * Nothing else is altered: the body goes up untouched (unless INJECT is set, below) and the answer comes
 * back untouched.
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const UPSTREAM = (process.env.UPSTREAM ?? "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 8787);
let gapMs = Number(process.env.GAP_MS ?? 35000);
const MAX_TRIES = Number(process.env.MAX_TRIES ?? 8);
const LOG = process.env.LOG ?? join(process.cwd(), "data", "eval-runs", `pace-proxy-${new Date().toISOString().slice(0, 10)}.jsonl`);
mkdirSync(dirname(LOG), { recursive: true });
// INJECT='{"chat_template_kwargs":{"enable_thinking":false}}' merges fields into every chat request, so
// a REQUEST-level setting (reasoning off, a reasoning effort) can be measured through the app's own
// adapter and both evals before any app code changes. Added 2026-10-03: reasoning off cut a 550B call
// on our prompt from 27 s to 4 s, and whether it costs quality has to be measured, not assumed.
const INJECT = process.env.INJECT ? JSON.parse(process.env.INJECT) : null;

const stats = { requests: 0, upstreamCalls: 0, rateLimited: 0, failed: 0, upstreamSeconds: 0 };
let lastStart = 0;
let chain = Promise.resolve(); // serialises upstream calls
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRateLimited = (status, text) =>
  status === 429 || (status === 200 && /rate limit exceeded/i.test(text) && !/"choices"\s*:/.test(text));

async function forward(method, path, headers, body) {
  let last = { status: 502, text: '{"error":"no attempt"}', contentType: "application/json" };
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const wait = Math.max(0, lastStart + gapMs - Date.now());
    if (wait) await sleep(wait);
    lastStart = Date.now();
    const t0 = performance.now();
    let status = 0, text = "", contentType = "application/json";
    try {
      const res = await fetch(`${UPSTREAM}${path}`, { method, headers, body });
      status = res.status; text = await res.text(); contentType = res.headers.get("content-type") ?? contentType;
    } catch (e) {
      status = 599; text = JSON.stringify({ error: `transport: ${e.message}` });
    }
    const seconds = (performance.now() - t0) / 1000;
    stats.upstreamCalls++;
    const limited = isRateLimited(status, text);
    let model = null; try { model = JSON.parse(body ?? "{}").model ?? null; } catch { /* GET */ }
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), model, path, attempt, status, seconds: +seconds.toFixed(2), limited, gapMs }) + "\n");
    if (limited) {
      stats.rateLimited++;
      gapMs = Math.min(gapMs + 10000, 120000); // the upstream told us we were too fast — believe it
      await sleep(30000 * attempt);
      last = { status: 429, text: JSON.stringify({ error: "rate limited upstream", attempts: attempt }), contentType: "application/json" };
      continue;
    }
    if (status !== 200) stats.failed++;
    else stats.upstreamSeconds += seconds; // only real answers count as model time
    return { status, text, contentType, seconds };
  }
  stats.failed++;
  return last;
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...stats, upstreamSeconds: +stats.upstreamSeconds.toFixed(2), gapMs }));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
  const path = (req.url ?? "/").replace(/^\/v1/, "");
  if (INJECT && body && path.startsWith("/chat/completions")) {
    try { body = JSON.stringify({ ...JSON.parse(body), ...INJECT }); } catch { /* not JSON — forward untouched */ }
  }
  const headers = { "content-type": "application/json" };
  if (req.headers.authorization && process.env.PASS_AUTH === "1") headers.authorization = req.headers.authorization; // keyless by default
  stats.requests++;
  const job = chain.then(() => forward(req.method ?? "GET", path, headers, body));
  chain = job.catch(() => {});
  const out = await job;
  res.writeHead(out.status, { "content-type": out.contentType, "x-upstream-seconds": String(out.seconds ?? "") });
  res.end(out.text);
}).listen(PORT, () => console.log(`pace proxy :${PORT} -> ${UPSTREAM}  gap ${gapMs} ms, ${MAX_TRIES} tries  log ${LOG}${INJECT ? `  inject ${JSON.stringify(INJECT)}` : ""}`));
