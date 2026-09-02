/**
 * Condition / deficiency → micronutrient bias for meal generation.
 *
 * The action-bearing analogue of the read-only SYMPTOMS table: when a user's durable profile
 * carries a relevant condition ("on my period", "pregnant", "low on iron"), a freshly generated
 * week should be GUARANTEED to favour the micronutrients that condition calls for — reusing the
 * existing boost machinery (selectWeekFromDb boost -> guaranteeBoost -> upgradeForNutrient), with
 * macros still the hard invariant. This module only DERIVES the nutrients to favour from the
 * profile; the wiring into generation and the ask-vs-auto-apply UX live elsewhere (see
 * CONDITION-AWARE-GEN.md). Nothing imports this yet — it is inert until that wiring lands.
 *
 * Only the 9 real MicroKeys can ever be biased. Conditions that clinically want nutrients the
 * engine has no key for (pregnancy: iodine, choline, DHA; etc.) are noted but cannot be promised —
 * a disclosure built on this must never imply completeness.
 */
import { MICRO_KEYS, MICRO_LABEL, type MicroKey } from "./nutrients";
import type { UserProfile, UserFact } from "./types";

/** A durable condition → the micronutrients a fresh plan should favour. First key is PRIMARY. */
export interface ConditionMap {
  key: string;
  /** Whole-word phrases matched against a lowercased UserFact.fact. */
  triggers: string[];
  /** MicroKeys to favour, primary first (the primary drives the single-key selection bias). */
  nutrients: MicroKey[];
  /** How the condition is named back to the user in the disclosure note. */
  label: string;
  /** Days after `since` the condition is assumed to have passed. 0 = durable, never ages. */
  ttlDays: number;
}

export const CONDITIONS: ConditionMap[] = [
  { key: "period", triggers: ["period", "menstruating", "menstruation", "time of the month"],
    nutrients: ["iron", "magnesium"], label: "your period", ttlDays: 7 },
  { key: "pregnancy", triggers: ["pregnant", "pregnancy", "expecting"],
    nutrients: ["folate", "iron", "calcium"], label: "pregnancy", ttlDays: 0 },
  { key: "ttc", triggers: ["trying to conceive", "ttc", "preconception"],
    nutrients: ["folate"], label: "trying to conceive", ttlDays: 0 },
  { key: "breastfeeding", triggers: ["breastfeeding", "nursing", "lactating"],
    nutrients: ["calcium", "b12", "vitD"], label: "breastfeeding", ttlDays: 0 },
  { key: "menopause", triggers: ["menopause", "menopausal", "perimenopause"],
    nutrients: ["calcium", "vitD", "magnesium"], label: "menopause", ttlDays: 0 },
  { key: "osteoporosis", triggers: ["osteoporosis", "osteopenia", "weak bones", "low bone density"],
    nutrients: ["calcium", "vitD", "magnesium"], label: "your bone health", ttlDays: 0 },
  { key: "anemia", triggers: ["anemia", "anaemia", "iron deficiency", "iron deficient"],
    nutrients: ["iron", "b12", "folate"], label: "iron-deficiency anaemia", ttlDays: 0 },
  { key: "b12def", triggers: ["pernicious anemia", "b12 deficiency", "b12 deficient"],
    nutrients: ["b12", "folate"], label: "low B12", ttlDays: 0 },
  { key: "vitDdef", triggers: ["vitamin d deficiency", "low vitamin d", "low on vitamin d"],
    nutrients: ["vitD"], label: "low vitamin D", ttlDays: 0 },
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word test so "period" doesn't fire inside "periodically". Phrases may contain spaces. */
const hasWord = (text: string, phrase: string): boolean => new RegExp(`\\b${esc(phrase)}\\b`).test(text);

/** A time-bound fact is live if it has no ttl, no `since`, or `since` is within ttl days of today. */
function isLive(f: UserFact, ttlDays: number, today: Date): boolean {
  if (ttlDays <= 0 || !f.since) return true; // durable, or undated → assume live
  const noted = new Date(f.since);
  if (Number.isNaN(noted.getTime())) return true; // unparseable → don't silently drop it
  return (today.getTime() - noted.getTime()) / 86_400_000 <= ttlDays;
}

/**
 * The micronutrients a freshly generated week should be guaranteed to favour, derived purely from
 * durable profile state. Primary first (drives the selection bias); the rest are secured by
 * sequential guaranteeBoost. Empty array = no condition bias (default behaviour, unchanged).
 *
 * Matches on the fact TEXT, not on `kind`: `kind` is frequently unset and memoryContext never even
 * shows it to the model, so it is at best a hint. `today` is injectable for deterministic tests.
 */
export function conditionBoosts(p: UserProfile, today: Date = new Date()): MicroKey[] {
  const out: MicroKey[] = [];
  const push = (k: MicroKey) => {
    if (!out.includes(k)) out.push(k);
  };
  for (const f of p.memory ?? []) {
    const text = f.fact.toLowerCase();
    // (a) the condition table, honouring time-bound aging
    for (const c of CONDITIONS)
      if (c.triggers.some((t) => hasWord(text, t)) && isLive(f, c.ttlDays, today)) c.nutrients.forEach(push);
    // (b) a directly stated deficiency: "low on iron", "vitamin D deficiency". The nutrient must sit
    // ADJACENT to the cue, not merely co-occur in the sentence — otherwise "low on time, want
    // calcium-free meals" would boost calcium — and a leading negation ("not deficient in iron") is
    // skipped. This is a heuristic, not NLP: it errs toward NOT firing on ambiguous phrasing.
    for (const k of MICRO_KEYS) {
      const lbl = esc(MICRO_LABEL[k].toLowerCase());
      const cue = new RegExp(`\\b(?:low on|lacking|short on|need more|deficient in) ${lbl}\\b|\\b${lbl} deficien(?:cy|t)\\b`);
      const hit = cue.exec(text);
      if (hit && !/\b(?:not|no|without)\s+\S*\s*$/.test(text.slice(0, hit.index))) push(k);
    }
  }
  return out;
}
