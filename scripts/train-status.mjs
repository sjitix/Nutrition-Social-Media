/**
 * A clean readout of a training run's progress.   node scripts/train-status.mjs [logfile]
 *
 * The trainer writes a tqdm progress bar (step/total) and, at the very end, a "Saved LoRA adapter"
 * line. This parses whichever is latest and prints RUNNING (with % + ETA) or DONE.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Default to the MOST RECENTLY WRITTEN train-*.log, not a hardcoded version — otherwise, mid-v9
// run, `npm run train:status` read v8's finished log and cheerfully reported "DONE". An explicit
// path argument still wins.
function latestTrainLog() {
  const logs = readdirSync(process.cwd())
    .filter((f) => /^train-.*\.log$/.test(f))
    .map((f) => ({ f, t: statSync(join(process.cwd(), f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return logs[0] ? join(process.cwd(), logs[0].f) : join(process.cwd(), "train-v8.log");
}
const log = process.argv[2] ?? latestTrainLog();

let text;
try {
  text = readFileSync(log, "utf8");
} catch {
  console.log(`No log yet at ${log} — training may not have started.`);
  process.exit(0);
}

const done = text.includes("Saved LoRA adapter");
// Progress bars are separated by \r; split on both so we see the latest frame.
const frames = text.split(/[\r\n]/);
let last = null;
for (const f of frames) {
  const m = f.match(/(\d+)\/(\d+)\s*\[([\d:]+)<([\d:?]+),\s*([\d.]+)s\/it/);
  if (m) last = m;
}
const skipped = text.match(/skipped (\d+) of (\d+)/);
const loss = [...text.matchAll(/'loss':\s*'([\d.]+)'/g)].pop();

console.log("");
if (skipped) console.log(`examples: ${skipped[2]}  (skipped ${skipped[1]})`);

if (done) {
  console.log("STATUS:  ✅ DONE — the adapter is saved. Ready to merge → GGUF → eval.");
} else if (last) {
  const [, step, total, elapsed, eta, rate] = last;
  const pct = Math.round((Number(step) / Number(total)) * 100);
  const bar = "#".repeat(Math.round(pct / 5)).padEnd(20, "·");
  console.log(`STATUS:  RUNNING   [${bar}] ${pct}%`);
  console.log(`step:    ${step} / ${total}   (${rate}s per step)`);
  console.log(`elapsed: ${elapsed}     remaining: ~${eta}`);
  if (loss) console.log(`loss:    ${loss[1]}  (started ~1.4; lower is better)`);
} else {
  console.log("STATUS:  starting up (loading the base model) — steps haven't begun yet.");
}
console.log("");
