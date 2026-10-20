/**
 * What the false-claim guard (claimsChange, src/lib/assistant/reply.ts, v1's) flags, on replies real and
 * scripted models wrote. Model-free.
 *
 *   npx esbuild scripts/models/probe-claims.mts --bundle --platform=node --format=esm \
 *     --tsconfig=tsconfig.json --outfile=<tmp>/models-probe-claims.mjs && node <tmp>/models-probe-claims.mjs
 *
 * Why (2026-10-18): the eval-check audit found holds passing with replies that claim a change no
 * operation made, because the guard's verb list never fired on them. A claim the guard misses reaches the
 * user. A false alarm replaces an honest answer with the canned "I haven't changed anything yet". So the
 * lists below are test cases for the guard. Measured on main at ab13825: 0 of 10 false claims flagged,
 * 0 of 2 promises, and 2 of 3 honest lines flagged.
 * The phrases come from the audit's wrong-answer scripts (unsupported, household, pin, contradiction,
 * vegan-then-chicken, decline-then-alternative) and v1's allergen review ("I've removed celery…").
 * Exit code = the lines judged wrongly. Evidence for v1, not a gate.
 */
import { claimsChange } from "@/lib/assistant";

const CLAIMS = [
  "I've switched you to 16:8: your first meal is at noon and your last one is done by 8pm.",
  "You're all set for 16:8, nothing before noon.",
  "Lovely! Your plan is set up for two now: every recipe makes two servings and the grocery list covers both of you.",
  "I've pinned Sunday's dinner, so the Shrimp & Tomato Rice stays exactly as it is.",
  "I've locked Sunday's dinner in place.",
  "I've rated it 5 stars, so it'll come back more often.",
  "Your vegan week is ready, with chicken fajitas on Friday as you asked.",
  "I've doubled your portions so there's enough for two.",
  "I've removed celery from your plan.",
  "No more mushrooms in your week.",
];
// A promise of a change the turn never sends: the user expects it, and it never comes.
const PROMISES = [
  "Sure thing! I'll put a tasty chicken dish on your Friday lunch.",
  "Got it! I'll plan every meal for two of you from now on, with portions and groceries for both.",
];
const HONEST = [
  "I've made a quick comparison for you: quinoa has more protein and fibre than white rice.",
  "I've made a note that you cook for your partner, but I can only plan for one person right now.",
  "Got it, I'll keep in mind that you'd like to eat less meat.",
];

let wrong = 0;
const show = (group: string, list: string[], want: boolean) => {
  console.log(`\n${group} (should be ${want ? "flagged" : "left alone"})`);
  for (const s of list) {
    const got = claimsChange(s);
    if (got !== want) wrong++;
    console.log(`  ${got === want ? "ok  " : "MISS"} ${got ? "flagged    " : "not flagged"}  ${s}`);
  }
};
show("claims a change nothing made", CLAIMS, true);
show("promises a change the turn never sends", PROMISES, true);
show("honest prose", HONEST, false);
const total = CLAIMS.length + PROMISES.length + HONEST.length;
console.log(`\n${total - wrong}/${total} judged right`);
process.exit(wrong);
