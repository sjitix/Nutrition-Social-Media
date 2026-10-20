/**
 * WHICH EVAL MESSAGES DOES THE PROMPT QUOTE? A scenario whose words the system prompt already holds as an
 * example measures recall of that example, not judgement, so it needs a held-out paraphrase beside it
 * (ground rule: test a wording fix on phrasings it does not quote). No model, no network, no key.
 *
 *   node scripts/models/probe-quotes.mjs                                      # this checkout's prompt
 *   node scripts/models/probe-quotes.mjs --code ../NutriFlow-models-wording   # another branch's prompt
 *   node scripts/models/probe-quotes.mjs --prompt-file draft.txt              # a draft, before it lands
 *   node scripts/models/probe-quotes.mjs --all                                # every message from 50% up
 *   node scripts/models/probe-quotes.mjs --self-test                          # proves the probe can fail
 *
 * Two tests, either one makes a NEAR-QUOTE:
 * - one prompt line holds at least 75% of a message's content words (stop words dropped, plurals folded),
 *   and at least three: `contradiction` shares only "the whole week" verbatim with the prompt's example,
 *   but four of its five content words;
 * - a user example in the prompt holds a run of the message, verbatim or with one word of the message left
 *   out, of at least three words, two of them content words: "save some room for it" is a small share of
 *   a long message, and "lighter meals on the weekend" holds the example "lighter on the weekend".
 * The scenarios always come from THIS checkout (the harness); `--code` only picks whose prompt is read.
 * Exit code = the number of near-quotes with no held-out (a scenario's `heldOutOf`, or the same message
 * held out elsewhere), plus every held-out message the prompt has come to quote itself.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEval } from "./bundle.mjs";

const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const code = resolve(flag("--code", HARNESS));
const promptFile = flag("--prompt-file", "");
const all = argv.includes("--all");
const MIN_SHARE = 0.75, MIN_HITS = 3, MIN_RUN = 3;

const STOP = new Set(("a an the and or but so to of in on for at by with from is are was were be been am i i'm im me my you " +
  "your it it's its this that these those can could would should will just now then please some any all every each do does " +
  "did have has had not no yes ok okay up out about than too very really also make made get give put go want").split(" "));
const fold = (w) => w.replace(/'s$/, "").replace(/(?<=\w{3})s$/, "");
const contentWords = (s) => [...new Set((s.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9:']+/g) ?? [])
  .filter((w) => !STOP.has(w)).map(fold).filter((w) => !STOP.has(w) && w.length > 1))];
const tokens = (s) => s.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9:']+/g) ?? [];

/** The prompt as the model receives it: loop-eval's bundle, built against `code`, prints it and stops
 *  (PRINT_PROMPT). Reading promptV2.ts as text would count its code comments, which the model never sees. */
async function renderPrompt() {
  const tmp = mkdtempSync(join(tmpdir(), "nutriflow-probe-quotes-"));
  try {
    const bundle = await bundleEval({ entry: join(HARNESS, "scripts", "models", "loop-eval.mts"), code, outfile: join(tmp, "probe-quotes-loop.mjs") });
    // The eval will not start without a model, so it gets the do-nothing script; it stops before any call.
    writeFileSync(join(tmp, "do-nothing.json"), "{}");
    const env = { ...process.env, PRINT_PROMPT: "1", MODEL_SCRIPT: join(tmp, "do-nothing.json") };
    for (const k of ["AI_PROVIDER", "LOCAL_AI_URL", "LOCAL_AI_MODEL", "LOCAL_AI_API_KEY"]) delete env[k];
    const printed = spawnSync(process.execPath, [bundle], { cwd: tmp, env, encoding: "utf8" });
    const text = /<<<PROMPT\n([\s\S]*)\nPROMPT>>>/.exec(printed.stdout ?? "")?.[1];
    if (!text) throw new Error(`the bundle printed no prompt (${(printed.stderr ?? "").trim().split("\n").slice(-2).join(" / ")})`);
    return text;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── the eval's messages ──────────────────────────────────────────────────────────────────────────────
const msgs = [];
// Split on \r?\n: a Windows checkout has CRLF endings, and a `$` after a line's last field never matches.
const loop = readFileSync(join(HARNESS, "scripts", "models", "loop-eval.mts"), "utf8").split(/\r?\n/);
const loopIds = [];
for (let i = 0; i < loop.length; i++) {
  const id = /^\s*id: "([^"]+)", want: "\w+"(.*)$/.exec(loop[i]);
  if (!id) continue;
  loopIds.push(id[1]);
  const held = /heldOutOf: "([^"]+)"/.exec(id[2])?.[1] ?? null;
  // The message, and any earlier user turns in `history` (the model reads those words too), within the
  // next few lines: `expectRead`, `history` or a comment can sit between the id and the message.
  for (let j = i + 1; j < Math.min(i + 10, loop.length); j++) {
    for (const h of loop[j].matchAll(/\{ user: "([^"]+)"/g)) msgs.push({ eval: "loop", id: id[1], heldOutOf: held, msg: h[1] });
    const m = /^\s*message: "([^"]+)"/.exec(loop[j]);
    if (m) { msgs.push({ eval: "loop", id: id[1], heldOutOf: held, msg: m[1] }); break; }
  }
}
// A scenario the parser skipped would pass unseen, so a miss stops the probe (it once skipped four).
const unread = loopIds.filter((x) => !msgs.some((m) => m.id === x));
if (!loopIds.length || unread.length) { console.error(`probe-quotes: could not read the message of ${unread.join(", ") || "any loop scenario"}`); process.exit(255); }
const convo = readFileSync(join(HARNESS, "scripts", "models", "convo-eval.mts"), "utf8");
let cid = "?", cheld = null;
for (const line of convo.split(/\r?\n/)) {
  const id = /^\s*id: "([^"]+)"(?:.*?heldOutOf: "([^"]+)")?/.exec(line);
  if (id) { cid = id[1]; cheld = id[2] ?? null; }
  const u = /\{ user: "([^"]+)"/.exec(line);
  if (u) msgs.push({ eval: "convo", id: cid, heldOutOf: cheld, msg: u[1] });
}
const convoIds = convo.split(/\r?\n/).filter((l) => /^\s*id: "/.test(l)).length;
const convoTurns = (convo.match(/\{ user: "/g) ?? []).length;
if (!convoIds || msgs.filter((m) => m.eval === "convo").length !== convoTurns) { console.error("probe-quotes: could not read convo-eval's turns"); process.exit(255); }
const heldOut = new Set(msgs.filter((m) => m.heldOutOf).map((m) => m.heldOutOf));
const heldOutFor = (r) => msgs.find((m) => m.heldOutOf && (m.heldOutOf === r.id || msgs.some((o) => o.id === m.heldOutOf && o.msg === r.msg)))?.id ?? null;

/** Every message graded against one prompt text. */
function scan(prompt) {
  const lines = prompt.split(/\n|(?<=[.!?"])\s+(?=[A-Z"])/)
    .map((l) => ({ text: l.trim(), words: new Set(contentWords(l)) })).filter((l) => l.words.size);
  // What the prompt shows a USER saying: its quoted spans (`User: "..."`, `("lighter on the weekend", ...)`),
  // minus JSON keys and values. Those are the model's side of a worked example and state what the app can
  // do ("plans run on 3 or 4 meals a day"), not a request. Instruction prose ("...or the whole week?") is no
  // example either.
  const examples = prompt.split("\n").flatMap((line) => [...line.matchAll(/"([^"]{3,300})"/g)]
    .filter((m) => line[m.index - 1] !== ":" && line[m.index + m[0].length] !== ":")
    .map((m) => ` ${tokens(m[1]).join(" ")} `));
  const inExample = (ws) => ws.length >= MIN_RUN && contentWords(ws.join(" ")).length >= 2 && examples.some((e) => e.includes(` ${ws.join(" ")} `));
  const phrase = (msg) => {
    const w = tokens(msg);
    let best = [];
    for (let i = 0; i < w.length; i++) {
      for (let j = i + MIN_RUN; j <= w.length; j++) {
        const run = w.slice(i, j);
        const hit = [run, ...run.slice(1, -1).map((_, k) => run.filter((__, x) => x !== k + 1))].find(inExample);
        if (hit && hit.length > best.length) best = hit;
      }
    }
    return best;
  };
  const rows = msgs.map((m) => {
    const w = contentWords(m.msg);
    let best = { share: 0, hit: [], line: "" };
    for (const l of lines) {
      const hit = w.filter((x) => l.words.has(x));
      const share = w.length ? hit.length / w.length : 0;
      if (share > best.share || (share === best.share && hit.length > best.hit.length)) best = { share, hit, line: l.text };
    }
    const r = { ...m, n: w.length, ...best, phrase: phrase(m.msg) };
    r.near = (r.share >= MIN_SHARE && r.hit.length >= MIN_HITS) || r.phrase.length >= MIN_RUN;
    // A held-out the prompt quotes holds nothing out any more: it counts like a quote with none.
    r.heldOutBy = r.near && !r.heldOutOf ? heldOutFor(r) : null;
    r.uncovered = r.near && !r.heldOutBy;
    return r;
  }).sort((a, b) => b.share - a.share || b.hit.length - a.hit.length);
  return { rows, uncovered: rows.filter((r) => r.uncovered).length };
}

function report({ rows, uncovered }, source) {
  console.log(`probe-quotes: the eval messages the prompt quotes (prompt from ${source})`);
  for (const r of rows.filter((r) => r.near || (all && (r.share >= 0.5 || r.phrase.length)))) {
    const verdict = !r.near ? "" : r.heldOutOf ? `A HELD-OUT, QUOTED (of ${r.heldOutOf})` : r.heldOutBy ? `held out: ${r.heldOutBy}` : "NO HELD-OUT";
    console.log(`${r.near ? "NEAR " : "     "}${(r.share * 100).toFixed(0).padStart(3)}% ${r.hit.length}/${r.n} ${r.eval.padEnd(5)} ${r.id.padEnd(24)} ${verdict}`);
    console.log(`        msg:    ${r.msg}${r.phrase.length ? `\n        phrase: "${r.phrase.join(" ")}"` : ""}\n        line:   ${r.line.slice(0, 160)}${r.line.length > 160 ? "…" : ""}`);
  }
  const nHeld = rows.filter((r) => r.heldOutOf).length;
  console.log(`\n${rows.filter((r) => r.near && !r.heldOutOf).length} near-quote(s) of ${rows.length - nHeld} messages, ${uncovered} without a held-out` +
    ` (or a held-out quoted itself; ${nHeld} held-out messages checked)${heldOut.size ? `; held out today: ${[...heldOut].sort().join(", ")}` : ""}`);
}

let prompt;
try {
  prompt = promptFile ? readFileSync(promptFile, "utf8") : await renderPrompt();
} catch (e) {
  console.error(`probe-quotes: ${e.message}`);
  process.exit(255);
}

if (argv.includes("--self-test")) {
  // Each case plants one line in the real prompt. A quote of a held-out, and a quote of a scenario that has
  // none, must each raise the count; an unrelated example must not.
  const base = scan(prompt).uncovered;
  const pick = (id) => msgs.find((m) => m.id === id)?.msg;
  const cases = [
    ["a held-out's message, quoted", `User: "${pick("vague-goal-heldout")}" → ask what they want`, (n) => n > base],
    ["a held-out's key phrase, quoted", `- A DIRECTION is enough ("go easy on the portions", "cheaper")`, (n) => n > base],
    ["a scenario with no held-out, quoted", `User: "${pick("iron-veg")}" → constrain`, (n) => n > base],
    ["an unrelated example", `User: "what's the weather like on mars" → answer`, (n) => n === base],
  ];
  let failed = 0;
  for (const [name, line, ok] of cases) {
    const n = scan(`${prompt}\n${line}`).uncovered;
    if (!ok(n)) failed++;
    console.log(`${ok(n) ? "ok    " : "FAILED"} ${name.padEnd(38)} ${base} -> ${n}`);
  }
  console.log(`\nprobe-quotes self-test: ${cases.length - failed}/${cases.length}`);
  process.exit(failed);
}

const result = scan(prompt);
report(result, promptFile || code);
process.exit(Math.min(result.uncovered, 255));
