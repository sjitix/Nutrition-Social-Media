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
 *   node scripts/models/probe-quotes.mjs --hard-cases                         # eval:hardcases' set, vs its prompt
 *
 * --hard-cases adds the user turns of data/hard-cases.json (v1's single-turn set, read only) and scans the
 * single-turn prompt that eval sends (no agent section, no date line). That set has no held-outs, so this
 * mode exits non-zero while the prompt quotes any of it: on 2026-10-21, 11 of its 45 cases.
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
const hardCases = argv.includes("--hard-cases");
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
    const env = { ...process.env, PRINT_PROMPT: hardCases ? "single" : "1", MODEL_SCRIPT: join(tmp, "do-nothing.json") };
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
  // Every `id:` line is a scenario (the file holds no other). Matching on the id alone, not on "id, want" on
  // one line, so a scenario laid out differently is counted, and then caught below if it cannot be read.
  const id = /^\s*id: "([^"]+)"/.exec(loop[i]);
  if (!id) continue;
  loopIds.push(id[1]);
  // heldOutOf, the message, and any earlier user turns in `history` (the model reads those words too), on
  // the id line or the next few: `want`, `expectRead`, `history` or a comment can sit between.
  let held = null;
  for (let j = i; j < Math.min(i + 10, loop.length); j++) {
    if (j > i && /^\s*id: "/.test(loop[j])) break;
    held = held ?? /heldOutOf: "([^"]+)"/.exec(loop[j])?.[1] ?? null;
    for (const h of loop[j].matchAll(/\{ user: "([^"]+)"/g)) msgs.push({ eval: "loop", id: id[1], heldOutOf: held, msg: h[1] });
    const m = /\bmessage: "([^"]+)"/.exec(loop[j]);
    if (m) { msgs.push({ eval: "loop", id: id[1], heldOutOf: held, msg: m[1] }); break; }
  }
}
// A scenario the parser skipped would pass unseen, so a miss stops the probe (it once skipped four).
const unread = loopIds.filter((x) => !msgs.some((m) => m.id === x && m.msg));
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
if (hardCases) {
  const set = JSON.parse(readFileSync(join(HARNESS, "data", "hard-cases.json"), "utf8"));
  for (const c of set.cases) for (const t of c.turns) if (t.role === "user") msgs.push({ eval: "hard", id: c.id, heldOutOf: null, msg: t.text });
}
const heldOut = new Set(msgs.filter((m) => m.heldOutOf).map((m) => m.heldOutOf));
const heldOutFor = (r) => msgs.find((m) => m.heldOutOf && (m.heldOutOf === r.id || msgs.some((o) => o.id === m.heldOutOf && o.msg === r.msg)))?.id ?? null;

/** Every message graded against one prompt text. */
function scan(prompt) {
  prompt = prompt.replace(/\r\n/g, "\n").replace(/[“”]/g, '"');
  // The week itself ("Monday — 1995kcal, 159gP: breakfast ...") is data, not an example: a steak on Wednesday
  // in the fixed week is no quote of "a steak for wednesday dinner" (review, 2026-10-21).
  const PLAN_LINE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) — \d+kcal/;
  const lines = prompt.split("\n").filter((l) => !PLAN_LINE.test(l)).join("\n").split(/\n|(?<=[.!?"])\s+(?=[A-Z"])/)
    .map((l) => ({ text: l.trim(), words: new Set(contentWords(l)) })).filter((l) => l.words.size);
  // What the prompt shows a USER saying: its quoted spans (`User: "..."`, `("lighter on the weekend", ...)`),
  // minus JSON keys and values. Those are the model's side of a worked example and state what the app can
  // do ("plans run on 3 or 4 meals a day"), not a request. Instruction prose ("...or the whole week?") is no
  // example either. A line whose quotes do not pair up is joined to the next, so an example wrapped over two
  // lines is still read; curly quotes count as straight; a JSON colon may have spaces around it.
  const logical = [];
  for (const l of prompt.split("\n")) {
    const open = logical.length && ((logical[logical.length - 1].match(/"/g) ?? []).length % 2 === 1);
    if (open) logical[logical.length - 1] += ` ${l}`; else logical.push(l);
  }
  // Day names are interchangeable in an example: "make wednesday vegetarian" teaches "make tuesday vegetarian".
  const days = (s) => s.replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, "dayname");
  const examples = logical.flatMap((line) => [...line.matchAll(/"([^"]{3,300})"/g)]
    // A JSON value follows `"key":` (a closing quote, then the colon); `User: "` does not.
    .filter((m) => !/"\s*:\s*$/.test(line.slice(0, m.index)) && !/^\s*:/.test(line.slice(m.index + m[0].length)))
    .map((m) => days(` ${tokens(m[1]).join(" ")} `)));
  const inExample = (ws) => ws.length >= MIN_RUN && contentWords(ws.join(" ")).length >= 2 && examples.some((e) => e.includes(days(` ${ws.join(" ")} `)));
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
  // Five words from the middle of a held-out's own message, so rewording it cannot disarm this case (a
  // hard-coded phrase did, 2026-10-21).
  const phraseOf = (id) => (pick(id) ?? "").split(/\s+/).slice(2, 7).join(" ");
  // Short phrases from long messages: their share of a message's content words stays under the line test's
  // bar, so only the phrase test can see them, and each case turns on the one rule it names.
  const pinWords = (pick("pin") ?? "").split(/\s+/);
  const pinTail = pinWords.slice(-6);
  const dayVeg = (pick("day-vegetarian") ?? "").split(/\s+/).slice(0, 3).join(" ").replace(/,$/, "");
  // A five-word window of the message holding two content words, or the phrase test could never flag it and
  // the JSON cases would pass with the filter switched off (they did, 2026-10-21).
  const windowOf = (id) => {
    const w = (pick(id) ?? "").replace(/[,.?!]/g, "").split(/\s+/);
    for (let i = w.length - 5; i >= 0; i--) if (contentWords(w.slice(i, i + 5).join(" ")).length >= 2) return w.slice(i, i + 5).join(" ");
    return "";
  };
  const portions = windowOf("household");
  const cases = [
    ["a held-out's message, quoted", `User: "${pick("vague-goal-heldout")}" → ask what they want`, (n) => n > base],
    ["a held-out's key phrase, quoted", `- A DIRECTION is enough ("${phraseOf("days-lighter-heldout")}", "cheaper")`, (n) => n > base],
    ["a scenario with no held-out, quoted", `User: "${pick("iron-veg")}" → constrain`, (n) => n > base],
    ["a phrase in curly quotes", `- e.g. (“${phraseOf("iron-veg")}”)`, (n) => n > base],
    ["a phrase wrapped over two lines", `- e.g. ("${pinTail.slice(0, 2).join(" ")}\n${pinTail.slice(2).join(" ")}")`, (n) => n > base],
    ["a phrase with another day in it", `- One day: "${dayVeg.replace(/tuesday/g, "wednesday")}" → constrain`, (n) => n > base],
    ["the phrase in the model's JSON reply", `User: "hi" → {"thinking":"x","reply":"I can ${portions} soon.","operations":[]}`, (n) => n === base],
    ["the same, as pretty JSON", `User: "hi" → {"thinking": "x", "reply": "I can ${portions} soon.", "operations": []}`, (n) => n === base],
    ["a plan line holding a held-out's words", `Wednesday — 2000kcal, 150gP: breakfast Oats (400kcal); lunch Salad (600kcal); dinner Steak & Chips (800kcal)`, (n) => n === base],
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
