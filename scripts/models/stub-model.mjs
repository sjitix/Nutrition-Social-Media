/**
 * A fake OpenAI-compatible model server for checking the HARNESS, not a model. No network, no key.
 *
 *   node scripts/models/stub-model.mjs [--mode nothing|hollow|garbage] [--port 4011]
 *   then run an eval with AI_PROVIDER=local LOCAL_AI_URL=http://127.0.0.1:4011/v1 LOCAL_AI_MODEL=stub-<mode>
 *
 * Modes:
 * - nothing — every turn is `{ thinking: "", reply: "", operations: [] }`. A do-nothing model. It must
 *   score 0 on every act check and 0 on every hold check (a hold has to say something). If a new check
 *   passes it, the check is grading the fixed start week, not the model (the rule from 2026-10-03,
 *   when three act checks and the hold checks were found passing this exact model).
 * - hollow — no operations, but a reply that CLAIMS a change ("Done, I've swapped it."). It must
 *   score 0 on act checks, and the false-claim guard should catch it.
 * - garbage — content that is not JSON. Must be graded as the model's miss ("unusable model output"),
 *   never as infra, or a weak model's failures are dropped from its score.
 * - script — `--script file.json`, an object mapping a phrase of the user's message to the turn to send
 *   (`{ "go easy on the portions": { "reply": "...", "operations": [ ... ] } }`). The first call of a
 *   message gets the matching turn; any call that follows a tool result gets an empty finish turn; a
 *   message no phrase matches gets the do-nothing turn. This is the POSITIVE control: a new check must
 *   pass the answer it was written to reward, as well as fail the do-nothing one.
 *
 * Written 2026-10-18: the 2026-10-03 stubs were throwaway, so the methodology rule had no command.
 * Requests are counted and the count is printed on exit (Ctrl+C), so a run that never reached the
 * stub is visible.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const mode = arg("--mode", "nothing");
const port = Number(arg("--port", "4011"));

const NOTHING = JSON.stringify({ thinking: "", reply: "", operations: [] });
const CONTENT = {
  nothing: NOTHING,
  hollow: JSON.stringify({ thinking: "", reply: "Done, I've swapped it and updated your week.", operations: [] }),
  garbage: "Sure! Here is what I would do: swap the dinner.",
  script: null,
};
if (!(mode in CONTENT)) {
  console.error(`stub-model: unknown --mode ${mode} (use ${Object.keys(CONTENT).join(", ")})`);
  process.exit(2);
}
const script = mode === "script" ? JSON.parse(readFileSync(arg("--script", ""), "utf8")) : {};
/** The script's answer to one request: the matching turn for a message's first call, else a finish. */
function scripted(body) {
  const messages = JSON.parse(body || "{}").messages ?? [];
  const last = String(messages.at(-1)?.content ?? "");
  if (last.startsWith("[tool result:")) return NOTHING;
  const hit = Object.keys(script).find((phrase) => last.toLowerCase().includes(phrase.toLowerCase()));
  return hit ? JSON.stringify({ thinking: "", reply: "", operations: [], ...script[hit] }) : NOTHING;
}

let requests = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: `stub-${mode}` }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    requests++;
    const content = mode === "script" ? scripted(body) : CONTENT[mode];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`stub-model: mode=${mode} on http://127.0.0.1:${port}/v1`));
const stop = () => {
  console.log(`stub-model: ${requests} chat request(s) served`);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
