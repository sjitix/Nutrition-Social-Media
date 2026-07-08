// Turn the assistant's request log into a fine-tuning dataset.
//
//   node scripts/prep-finetune.mjs
//
// Reads   data/edit-log.jsonl   (one complete example per line, written by the
//         assistant route: { systemPrompt, history, completion })
// Writes  data/finetune.jsonl   (chat format: { "messages": [ ... ] } per line)
//
// The output is tool-agnostic ChatML — usable by Unsloth, Axolotl, LLaMA-Factory,
// etc. Each example teaches the model: given the system prompt + conversation,
// output the tool-call JSON. No dependencies; plain Node.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "data", "finetune.jsonl");

// Real usage log + synthetic seed (same record shape); either may be absent.
const INPUTS = ["edit-log.jsonl", "synthetic-log.jsonl"]
  .map((f) => join(root, "data", f))
  .filter((f) => existsSync(f));

if (INPUTS.length === 0) {
  console.error(
    "No data found. Use the assistant chat (data/edit-log.jsonl) and/or run" +
      " scripts/gen-synthetic.mjs (data/synthetic-log.jsonl) first.",
  );
  process.exit(1);
}

const lines = INPUTS.flatMap((f) => readFileSync(f, "utf8").split("\n")).filter((l) => l.trim());
const seen = new Set();
const out = [];
let skipped = 0;

for (const line of lines) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    skipped++;
    continue;
  }
  // Older log lines predate full-context logging — skip (can't reconstruct input).
  if (!rec.systemPrompt || !Array.isArray(rec.history) || !rec.completion) {
    skipped++;
    continue;
  }
  const messages = [
    { role: "system", content: rec.systemPrompt },
    ...rec.history.map((h) => ({ role: h.role, content: h.text })),
    { role: "assistant", content: JSON.stringify(rec.completion) },
  ];
  const key = JSON.stringify(messages);
  if (seen.has(key)) continue; // drop exact duplicates
  seen.add(key);
  out.push(JSON.stringify({ messages }));
}

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out.join("\n") + (out.length ? "\n" : ""), "utf8");

console.log(`Read ${lines.length} log lines`);
console.log(`Wrote ${out.length} unique training examples -> ${OUT}`);
if (skipped) console.log(`Skipped ${skipped} (old format or unparseable)`);
if (out.length < 200) {
  console.log(
    `\nHeads-up: ${out.length} examples is thin. Aim for a few hundred to a few` +
      ` thousand before fine-tuning (see scripts/FINETUNE.md).`,
  );
}
