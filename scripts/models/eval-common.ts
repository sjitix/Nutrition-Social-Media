/**
 * Shared by loop-eval and convo-eval: two rules an adversarial review of the harness showed were missing
 * (2026-10-03).
 *
 * 1. A model failure is not automatically infrastructure. `runAgent` reports every thrown model error as
 *    `modelFailed`, and the evals used to treat all of those as infra: re-run them, then leave them out of
 *    the score. But the adapter also throws when the MODEL's output is unusable (invalid JSON, a schema
 *    miss, empty content). That is the model's fault, and dropping it flatters weak models. So the error
 *    is captured, and only transport failures (network, timeout, rate limit, 5xx) count as infra.
 * 2. A hold turn must still answer. With an empty model reply, composeReply falls back to "Happy to
 *    help.", and a hold check that only asked "did the plan stay put?" passed it, so a model that says
 *    nothing scored like one that answered well.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { AgentTurnSchema, isReadTool, type AgentRunResult, type AgentTurn, type ModelFn } from "@/lib/assistant";
import { RECIPES } from "@/lib/plan";
import { dietTagConflicts } from "@/lib/nutrition";
import type { Meal, UserFact, UserProfile, WeekPlan } from "@/lib/core";

/** Network, timeout, rate limit, gateway or server errors: not the model's output. An EMPTY response is
 *  counted here too: the free NVIDIA tier returns empty 200s under load (latency-anatomy saw 3 in 16 calls),
 *  so it is the host's failure far more often than the model's. */
const INFRA = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network|timed? ?out|abort|\b429\b|rate.?limit|too many requests|\b50[0-4]\b|bad gateway|service unavailable|unreachable|no models? loaded|model_not_found|empty response|could not reach|server error \(\d{3}\)/i;
export const isInfraError = (msg: string) => msg === "" || INFRA.test(msg);

/** Wraps a ModelFn and remembers the message of the last error it threw (reset before each run). */
export function withErrorCapture(model: ModelFn) {
  let last = "";
  const fn: ModelFn = async (t, s, st) => {
    try {
      return await model(t, s, st);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      throw e;
    }
  };
  return { fn, lastError: () => last, reset: () => { last = ""; } };
}

/**
 * MODEL_SCRIPT=<file.json>: an in-process scripted model, for the harness's POSITIVE and NEGATIVE
 * controls (a check must pass the answer it rewards and fail the plausible wrong ones). No server and no
 * port, so many controls run at once. The file maps a phrase of the user's message (case-blind) to the
 * turn sent on that message's FIRST call, or to a list of turns, one per call (a look-up, then a write).
 * A call past the list, or a message no phrase matches, gets the do-nothing turn. The loop calls again
 * after every turn that sends operations, and once more after a change claimed with nothing behind it,
 * so a wrong answer has to last that long: a claim scripted once is followed by silence, and the control
 * fails as "said nothing" without ever reaching the guard (ten did, 2026-10-20). Each turn is checked
 * against AgentTurnSchema first, as the adapter checks a real model's, and an invalid one throws
 * (graded "unusable model output"), so a typo in a script cannot pose as a strict check.
 */
export function scriptedModel(path: string): ModelFn {
  const script = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return async (transcript, step) => {
    const last = [...transcript].reverse().find((e) => e.role === "user");
    const text = last && last.role === "user" ? last.content.toLowerCase() : "";
    const hit = Object.keys(script).find((phrase) => text.includes(phrase.toLowerCase()));
    const entry = hit === undefined ? undefined : script[hit];
    const turns = entry === undefined ? [] : Array.isArray(entry) ? entry : [entry];
    const raw = (turns[step - 1] ?? {}) as Record<string, unknown>;
    const parsed = AgentTurnSchema.safeParse({ thinking: "", reply: "", operations: [], ...raw });
    if (!parsed.success) throw new Error(`MODEL_SCRIPT: call ${step} for "${hit}" is not a valid agent turn: ${parsed.error.message.slice(0, 300)}`);
    return parsed.data as unknown as AgentTurn;
  };
}
/**
 * Reseed the engine's dice for one scenario (see bundle.mjs): the same id and ENGINE_SEED always give
 * the same draws, so identical model output grades identically. Returns the seed used, or null when
 * the bundle was not built seeded (then nothing changes).
 */
export function reseedEngine(id: string): number | null {
  const g = globalThis as { __models_reseed?: (s: number) => void };
  if (!g.__models_reseed) return null;
  let h = (2166136261 ^ Number(process.env.ENGINE_SEED ?? 1)) >>> 0;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  g.__models_reseed(h);
  return h;
}
/** What the scorecard records about the dice: the base seed when seeded, else null. */
export const engineSeedConfig = () =>
  (globalThis as { __models_reseed?: unknown }).__models_reseed ? Number(process.env.ENGINE_SEED ?? 1) : null;

/** The scorecard's model name for a scripted run. */
export const scriptLabel = (path: string) => `script-${basename(path).replace(/\.json$/i, "")}`;

// Pleasantries that answer nothing. "Happy to help!" and "Anything else you'd like to know?" both passed
// a hold before (audit, 2026-10-18), because only the exact fallback "Happy to help." was caught.
const FILLER = /\b(?:i'?m\s+)?(?:happy|glad)\s+to\s+help\b|\banything\s+else(?:\s+(?:i\s+can\s+do|you'?d\s+like(?:\s+to\s+know)?))?\b|\blet\s+me\s+know\b|\bhow\s+can\s+i\s+help(?:\s+you)?(?:\s+today)?\b|\bwhat\s+(?:else\s+)?(?:would|can)\s+(?:you\s+like|i\s+do)(?:\s+for\s+you)?\b|\bsure(?:\s+thing)?\b|\bof\s+course\b|\bno\s+problem\b|\babsolutely\b|\bgreat\s+question\b|\bgot\s+it\b|\bokay\b|\bok\b/gi;

/** composeReply's fallback for an empty model reply, or next to nothing once the pleasantries are gone:
 *  not an answer. */
export const hollowReply = (reply: string) => {
  const t = reply.trim();
  if (t === "" || t === "Happy to help.") return true;
  return t.replace(FILLER, " ").replace(/[^a-z0-9]+/gi, " ").trim().length < 12;
};

// ── shared guards, from the 2026-10-18 audit (every check vs plausible wrong answers) ────────────────
const LIBRARY = new Map(RECIPES.map((r) => [r.name.toLowerCase(), r]));
const ingredientNames = (m: Meal) => m.ingredients.map((i) => i.name);
/** Vegetarian the way the ENGINE decides it (plan/rules.ts passesDiet: the recipe's dietTags). A dish
 *  outside the library (logged, eating out, imported) falls back to its ingredients AND its name. The old
 *  ingredient-only test passed "Pepperoni & Mozzarella Pizza", whose seed lists no pepperoni. */
export function isVegMeal(m: Meal): boolean {
  const r = LIBRARY.get(m.name.toLowerCase());
  if (r) return r.dietTags.includes("vegetarian") || r.dietTags.includes("vegan");
  return dietTagConflicts("vegetarian", [m.name, ...ingredientNames(m)]).length === 0;
}
/** Vegan, the same way. */
export function isVeganMeal(m: Meal): boolean {
  const r = LIBRARY.get(m.name.toLowerCase());
  if (r) return r.dietTags.includes("vegan");
  return dietTagConflicts("vegan", [m.name, ...ingredientNames(m)]).length === 0;
}

const slotOf = (p: WeekPlan, d: string, t: string) => p.days.find((x) => x.day === d)?.meals.find((m) => m.type === t);
/**
 * SCOPE GUARD. Every slot outside `keep` that changed, as readable lines ([] = untouched). On a day `keep`
 * touches, the engine may rebalance the other meals' portions after one of them changes, so there only
 * the DISH must match; on every other day both the dish and its calories must. Most act checks read only
 * the slot they asked about, so a whole-week resize passed "lighter on the weekend" (audit, 2026-10-18).
 */
export function changedOutside(before: WeekPlan, after: WeekPlan, keep: (day: string, slot: string) => boolean): string[] {
  const out: string[] = [];
  for (const d of before.days) {
    const touched = d.meals.some((m) => keep(d.day, m.type));
    for (const m of d.meals) {
      if (keep(d.day, m.type)) continue;
      const a = slotOf(after, d.day, m.type);
      if (!a) out.push(`${d.day} ${m.type} removed`);
      else if (a.name !== m.name) out.push(`${d.day} ${m.type}: "${m.name}" -> "${a.name}"`);
      else if (!touched && Math.abs(a.calories - m.calories) > 2) out.push(`${d.day} ${m.type}: ${m.calories} -> ${a.calories} kcal`);
    }
    for (const a of after.days.find((x) => x.day === d.day)?.meals ?? [])
      if (!d.meals.some((m) => m.type === a.type) && !keep(d.day, a.type)) out.push(`${d.day} ${a.type} added ("${a.name}")`);
  }
  return out;
}
/** The scope guard as a check line: null, or what changed outside the asked scope (first three). */
export const outsideScope = (before: WeekPlan, after: WeekPlan, keep: (day: string, slot: string) => boolean) => {
  const c = changedOutside(before, after, keep);
  return c.length ? `changed outside what was asked: ${c.slice(0, 3).join("; ")}${c.length > 3 ? ` (+${c.length - 3})` : ""}` : null;
};

const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);
/**
 * PROFILE GUARD. Profile fields that changed, other than `allowed` and `memory` (see memoryAdded), compared
 * key-order-blind. "Make it cheaper" also switching the diet to vegetarian, or a lighter weekend also
 * cutting the saved calorie target to a number the model picked, both passed (audit, 2026-10-18).
 */
const field = (p: UserProfile, k: string) => (p as unknown as Record<string, unknown>)[k];
export function profileChangedKeys(before: UserProfile, after: UserProfile, allowed: string[] = []): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => k !== "memory" && !allowed.includes(k) && canon(field(before, k)) !== canon(field(after, k)));
}
/** The profile guard as a check line. */
export const unaskedProfileEdit = (before: UserProfile, after: UserProfile, allowed: string[] = []) => {
  const k = profileChangedKeys(before, after, allowed);
  return k.length ? `changed the profile unasked: ${k.map((key) => `${key} ${canon(field(before, key))} -> ${canon(field(after, key))}`).join("; ").slice(0, 200)}` : null;
};
/** Memory facts this turn added (by text). */
export function memoryAdded(before: UserProfile, after: UserProfile): string[] {
  return memoryFactsAdded(before, after).map((f) => f.fact);
}
/** Memory facts this turn added, with their kinds. */
export function memoryFactsAdded(before: UserProfile, after: UserProfile): UserFact[] {
  const had = new Set((before.memory ?? []).map((f) => f.fact.toLowerCase()));
  return (after.memory ?? []).filter((f) => !had.has(f.fact.toLowerCase()));
}
/**
 * A diagnosis the user never gave. "probably low on iron because of her period" and "has heavy periods that
 * leave her iron-depleted" passed a pattern that knew only "low iron" (review, 2026-10-21).
 */
export const DIAGNOSIS = /an(?:a)?emi|deficien|disorder|syndrome|diabet|thyroid|\bibs\b|endometrio|pcos|\blow (?:on |in )?(?:iron|b12|ferritin|vitamin d)|iron[- ]?deplet|deplet\w* (?:of |in )?iron|heavy periods?|menorrhag/i;
/**
 * A calorie target or pace the model chose itself, in the reply or a saved fact. A figure with kcal was
 * caught; "around 1,600 a day", "a deficit of around 400", "300 fewer calories", "trim by about 15%" and "a
 * 500-calorie daily deficit" were not (review, 2026-10-21). `except` is a figure the user already has.
 */
export function chosenCalorieFigure(text: string, except?: number): string | null {
  const num = (s: string) => Number(s.replace(/,/g, ""));
  const patterns: RegExp[] = [
    /(\d[\d,]*)\s*-?\s*k?cal(?:orie)?s?\b/gi,
    /\b(\d{1,2},\d{3}|\d{3,4})\s+(?:a|per|each)\s+day\b/gi,
    /\bdeficit of (?:around |about |roughly |some )?(\d[\d,]*)/gi,
    /\b(\d[\d,]*)\s+(?:fewer|less|lower)\s+(?:k?cal|calorie)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) if (except === undefined || num(m[1]) !== except) return m[0].trim();
  }
  const pct = /\b\d+\s*(?:%|percent)[^.?!]{0,40}\b(?:deficit|cut|fewer|less|lower|reduc|trim)|\b(?:deficit|cut|trim|reduce|lower)\w*\b[^.?!]{0,40}?\b\d+\s*(?:%|percent)/i.exec(text);
  return pct ? pct[0].trim() : null;
}

/** Every operation the model sent across the run (look-ups included), with its arguments. */
export const opsSent = (r: AgentRunResult) =>
  r.transcript.flatMap((e) => (e.role === "assistant" ? e.turn.operations : [])) as unknown as Array<Record<string, unknown> & { op?: string }>;
/** The model's WRITE operations (look-ups left out), with their arguments. */
export const writesSent = (r: AgentRunResult) => opsSent(r).filter((o) => !isReadTool(String(o.op)));
/**
 * Calorie or macro figures the model put on a `log` or `reserve` when the user's message gave no number.
 * The prompt forbids the model stating any such number itself, and the engine takes the figure as the
 * user's own (types.ts estimatedCalories) and drops its "not a measured number" line, so the user reads
 * a guess as a fact (audit, 2026-10-18).
 */
export const inventedFigures = (r: AgentRunResult, userText: string) =>
  /\d/.test(userText) ? [] : writesSent(r)
    .filter((o) => (o.op === "log" || o.op === "reserve") && ["calories", "protein"].some((k) => o[k] != null))
    .map((o) => `${o.op} ${String(o.day)} ${String(o.slot)}`);
/**
 * The user's message, quoted. The prompt says to pass it "VERBATIM … copy, never paraphrase", because the
 * symptom checks match the user's own phrasing. A text counts when it holds the whole message, or nearly
 * all of it, ignoring case, punctuation and spacing (audit, 2026-10-18: a paraphrase that dropped
 * "exhausted" passed, and so did an empty text).
 */
export const quotesUser = (texts: string[], message: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const m = norm(message);
  return texts.some((t) => { const n = norm(t); return n.includes(m) || (m.includes(n) && n.length >= 0.8 * m.length); });
};
// Every word of every library ingredient name, minus the describing words ("fresh", "ground", "sauce"…).
const NOT_FOOD = new Set(["fresh", "large", "small", "medium", "ground", "whole", "dried", "frozen", "light", "extra", "virgin", "plain", "cooked", "sliced", "chopped", "mixed", "white", "brown", "green", "black", "sweet", "baby", "sauce", "powder", "juice", "stock", "fillet", "fillets", "canned", "tinned", "free", "range", "with", "skinless", "boneless", "lean", "fresh", "raw", "smoked", "roasted", "toasted", "flakes", "leaves", "seeds"]);
const FOOD_WORDS = new Set(RECIPES.flatMap((r) => r.ingredients.flatMap((i) => i.name.toLowerCase().split(/[^a-z]+/))).filter((w) => w.length >= 4 && !NOT_FOOD.has(w)));
/** Food words in `text` that the user's own words do not contain: something the model introduced, like an
 *  invented trigger ("beans and lentils make them bloated") saved to memory (audit, 2026-10-18). */
export const foodWordsAdded = (text: string, said: string) => {
  const s = new Set(said.toLowerCase().split(/[^a-z]+/));
  return [...new Set(text.toLowerCase().split(/[^a-z]+/))].filter((w) => FOOD_WORDS.has(w) && !s.has(w) && !s.has(w.replace(/s$/, "")));
};
/** Write operations that change nothing a hold must leave alone: the only writes a HOLD may send. */
const STILL = new Set(["symptom", "remember", "answer", "report", "explain", "hydration"]);
/** A hold's writes beyond those (a slot edit the engine refused still passed, because the refusal note
 *  filled the reply; audit, 2026-10-18). `allow` narrows the set further for one scenario. */
export const holdWrites = (r: AgentRunResult, allow: string[] = [...STILL]) =>
  writesSent(r).map((o) => String(o.op)).filter((op) => !STILL.has(op) || !allow.includes(op));
/**
 * The reply declines: it says plainly that the app cannot do this. A request the app cannot serve must be
 * DECLINED, not approximated or promised (the prompt). "Your plan is set up for two now", "You're all set
 * for 16:8" and a clarifying question that implied the feature exists all passed (audit, 2026-10-18).
 */
export const declines = (reply: string) =>
  /\b(?:can['’]?t(?! wait| go wrong)|cannot|can not|unable to|not able to|isn['’]t (?:yet )?(?:something|possible|supported|available|a feature)|aren['’]t (?:yet )?(?:supported|possible|available)|(?:does|do|won)n['’]?t (?:yet )?(?:support|do|handle|plan|have|offer)|(?:does|do) not (?:yet )?(?:support|do|handle|plan|have|offer)|not (?:yet )?(?:supported|possible|available|something i can)|no way to|only (?:plan|cook|cater|build|work) (?:meals )?for (?:one|a single|you)|one person)\b/i.test(reply);
/**
 * Constrains that RE-PLAN (a day scope, or any field beyond binding an exclusion), where one dish into one
 * slot needed a swap. A day-scoped constrain re-solved the whole day and passed (audit, 2026-10-18). A
 * week constrain carrying only `exclude` is the binding the prompt asks for ("when you pick or add food
 * after one was mentioned, also send exclude:[…]"), so it is not counted.
 */
export const replanningConstrains = (r: AgentRunResult) => writesSent(r).filter((o) => {
  if (o.op !== "constrain") return false;
  const dayScoped = typeof o.scope === "object" && o.scope !== null;
  const other = Object.keys(o).filter((k) => !["op", "exclude", "scope", "preserveMacros"].includes(k));
  return dayScoped || other.length > 0;
});
/** The texts of every `symptom` operation sent. */
export const symptomTexts = (r: AgentRunResult) => opsSent(r).filter((o) => o.op === "symptom").map((o) => String(o.text ?? ""));
/** The reply asks the user something. */
export const asksQuestion = (reply: string) => /\?/.test(reply);
/** The reply names being vegetarian, in that word or in the user's own: "you told me no more meat" and "keep it
 *  meatless" are correct refusals that failed a /vegetarian/ test (review, 2026-10-21). "Steak is my favourite
 *  meat" does not match. */
export const NAMES_VEGETARIAN = /vegetarian|veggie|meat-?free|meatless|\bno(?:-|\s+more\s+|\s+)meat\b|\bnot\s+eating\s+meat\b/i;
/**
 * The reply says the two requests conflict. Naming the diet and the dish is not enough: "Want me to make every
 * day vegetarian and put a steak on Wednesday's dinner?" names both, asks, offers to do the impossible, and
 * passed; so did "I can swap in the Chicken Shawarma Bowl instead. Want me to?" a turn after "i'm vegan now"
 * (review, 2026-10-21).
 */
export const namesClash = (reply: string) =>
  /\b(?:clash\w*|conflict\w*|contradict\w*|incompatible|can['’]?t (?:do |have )?both|cannot (?:do |have )?both|isn['’]?t (?:vegan|vegetarian|veggie)|is not (?:vegan|vegetarian)|not (?:vegan|vegetarian)|(?:vegan|vegetarian|veggie)(?: diet| week)? (?:means|rules out|excludes)|don['’]?t (?:go|fit) together|doesn['’]?t (?:go|fit)|break(?:s|ing)? (?:the|your)|is (?:a )?meat|has meat|contains meat)\b/i.test(reply);
/** The reply names this phrase (case-blind, punctuation-blind). */
export const mentions = (reply: string, phrase: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(reply).includes(norm(phrase));
};

/**
 * Why a turn that should HOLD (leave the plan alone) failed, or null. It must also have answered: an
 * empty reply fails, and so does a reply the false-claim guard had to replace. A model that answered
 * every question with "Done, I've swapped it" and no operations passed 8 of 10 loop holds (the hollow
 * stub, 2026-10-18): the guard swapped its reply for a canned honest line (NOTHING_CHANGED_REPLY, or
 * since 5c12c4c NOTED_NOTHING_CHANGED_REPLY), which reads like an answer. The guard's own flag is the
 * test, so a third canned line can't reopen the hole. Read optionally: it exists only from 361b2e1.
 */
export const holdFailure = (r: Pick<AgentRunResult, "planChanged" | "reply"> & { falseClaimCaught?: boolean }) =>
  r.planChanged ? "changed the plan when it should have held"
  : r.falseClaimCaught ? "claimed a change it never made (the guard replaced its reply)"
  : hollowReply(r.reply) ? `held, but said nothing ("${r.reply.trim()}")`
  : null;
