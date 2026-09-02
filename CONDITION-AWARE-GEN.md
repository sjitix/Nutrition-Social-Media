# Condition / deficiency-aware initial meal generation — implementation plan

> Design spec produced 2026-09-02 (a read-only pass over the live source; verified line numbers).
> Not yet implemented — the local toolchain was timing out, so this was designed to be mechanical
> to apply + validate once builds work again. Reuses the existing boost → `guaranteeBoost` →
> `upgradeForNutrient` → `rebalanceWeek` machinery. **No new hard-coded generation tools; macros stay
> the hard invariant; micros are the guaranteed-but-honest layer on top.**

## 1. Condition → nutrient mapping

Only 9 real `MicroKey`s exist (`nutrients.ts:16-18`): `iron, calcium, magnesium, potassium, zinc,
vitD, vitC, folate, b12`. First key is **primary** (drives the single-key selection bias in
`selectWeekFromDb`); the rest are secured sequentially by `guaranteeBoost`.

| Condition / deficiency signal (matched in `fact` text) | MicroKey(s), primary first | Notes / gaps |
|---|---|---|
| period / menstruating / time of the month | `iron`, `magnesium` | iron for loss; magnesium for cramps |
| pregnant / pregnancy / expecting | `folate`, `iron`, `calcium` | **GAP:** iodine, choline, DHA, vitB6 wanted but no MicroKey exists |
| trying to conceive / ttc / preconception | `folate` | — |
| breastfeeding / nursing / lactating | `calcium`, `b12`, `vitD` | **GAP:** iodine, DHA absent |
| menopause / perimenopause | `calcium`, `vitD`, `magnesium` | **GAP:** omega-3 absent |
| osteoporosis / osteopenia / weak bones | `calcium`, `vitD`, `magnesium` | mirrors `SYMPTOMS.bones` |
| anemia / iron deficiency | `iron`, `b12`, `folate` | mirrors `SYMPTOMS.pallor` |
| pernicious anemia / b12 deficiency | `b12`, `folate` | — |
| vitamin d deficiency / low vitamin d | `vitD` | — |
| Generic "low on X" / "X deficient" where X ∈ `MICRO_LABEL` | that one key | direct parse (§2) |

- **Vegan/vegetarian excluded here** — that's `profile.diet`, not a `memory` condition; mapping it
  here would fire forever. If wanted later, key `vegan → b12, iron, zinc` off `diet`, not a fact.
- **Cycle-phase (Phase 3) out of scope** — `BodyStats` has no cycle field (`types.ts:257-263`).

Encode as a table beside `SYMPTOMS`, in a new `src/lib/conditions.ts`:

```ts
import type { MicroKey } from "./nutrients";

/** A durable condition → micronutrients a fresh plan should favour. First key is PRIMARY. */
export interface ConditionMap {
  key: string;
  triggers: string[];   // whole-word matched against a lowercased UserFact.fact
  nutrients: MicroKey[]; // primary first
  label: string;         // how we name it back in the disclosure note
  ttlDays: number;       // days after `since` the condition is assumed passed. 0 = never ages
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
```

## 2. Detection — `conditionBoosts(profile)` (also in `src/lib/conditions.ts`)

Reads `memory[]` (`types.ts:223`, `UserFact {fact, kind?, since?}` at `227-232`). Match on `fact`
TEXT, not `kind` — `kind` is often unset and `memoryContext` (`primitives.ts:194-198`) never shows it
to the model, so treat `kind:"condition"` as a confidence bump, never a requirement.

```ts
import { MICRO_KEYS, MICRO_LABEL, type MicroKey } from "./nutrients";
import type { UserProfile, UserFact } from "./types";
import { CONDITIONS } from "./conditions";

const hasWord = (text: string, phrase: string) =>
  new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);

function isLive(f: UserFact, ttlDays: number, today: Date): boolean {
  if (ttlDays <= 0 || !f.since) return true;         // durable, or undated → assume live
  const noted = new Date(f.since);
  if (Number.isNaN(noted.getTime())) return true;    // unparseable → don't silently drop it
  return (today.getTime() - noted.getTime()) / 86_400_000 <= ttlDays;
}

/** Micronutrients a fresh week should be guaranteed to favour. Primary first. Empty = no bias. */
export function conditionBoosts(p: UserProfile, today = new Date()): MicroKey[] {
  const out: MicroKey[] = [];
  const push = (k: MicroKey) => { if (!out.includes(k)) out.push(k); };
  for (const f of p.memory ?? []) {
    const text = f.fact.toLowerCase();
    for (const c of CONDITIONS)
      if (c.triggers.some((t) => hasWord(text, t)) && isLive(f, c.ttlDays, today)) c.nutrients.forEach(push);
    if (/\b(low on|deficient|deficiency)\b/.test(text))
      for (const k of MICRO_KEYS) if (hasWord(text, MICRO_LABEL[k].toLowerCase())) push(k);
  }
  return out;
}
```

`today` is injectable so tests are deterministic; the live call uses `new Date()`. NOTE: `since` is
the day the fact was *noted*, not the physiological start (`primitives.ts:94-100`); a `period`
(`ttlDays:7`) is honoured only within 7 days. 7 is a guess — see §6.

## 3. Injection — reuse `guaranteeBoost`, single primary + sequential secure

**Where:** `generatePlan` in `ai.ts:626`, the DB-engine line
`if (process.env.PLAN_ENGINE === "db") return rebalanceWeek(selectWeekFromDb(p), p);` — the only
first-plan path with no boost. The explicit `op.boostNutrient` path (`recipeDb.ts:9812/9831`) stays
byte-for-byte unchanged.

Everything downstream is single-key (`selectWeekFromDb` 5th arg `boost?: MicroKey` at `8263-8270`,
`ctx.boost`, `chooseRecipe` score, `guaranteeBoost`/`upgradeForNutrient`/`weekMicroAverage`/
`microNote`). Do NOT generalise all of that to `MicroKey[]` (large). Instead: **one primary key biases
selection; remaining keys are secured by sequential `guaranteeBoost`** (each ends in `rebalanceWeek`,
so macros re-hold every pass). Guard against a later pass clawing an earlier nutrient below baseline.

```ts
import { conditionBoosts } from "./conditions";

export function selectConditionAwareWeek(
  profile: UserProfile,
  report?: SelectionReport,
): { plan: WeekPlan; notes: string[] } {
  const wanted = conditionBoosts(profile).filter((k) => nutrientReachable(profile, k)); // ~9442
  const baseline = rebalanceWeek(selectWeekFromDb(profile, undefined, false, undefined, undefined, report), profile);
  if (!wanted.length) return { plan: baseline, notes: [] };

  const primary = wanted[0];
  let plan = rebalanceWeek(selectWeekFromDb(profile, undefined, false, undefined, primary, report), profile);

  const secured: MicroKey[] = [];
  const EPS = 1e-6;
  for (const key of wanted) {
    const candidate = guaranteeBoost(profile, baseline, plan, key).plan; // ~9317, never below baseline[key]
    const ok = secured.every(
      (s) => weekMicroAverage(candidate, s).amount >= weekMicroAverage(plan, s).amount - EPS, // ~8740
    );
    if (ok) { plan = candidate; secured.push(key); }
  }

  const notes: string[] = [];
  const raised = secured.filter(
    (k) => weekMicroAverage(plan, k).amount > weekMicroAverage(baseline, k).amount + EPS,
  );
  if (raised.length) notes.push(conditionDisclosure(profile, raised)); // §4
  for (const k of raised) notes.push(microNote(plan, k)); // ~9718, coverage-gated
  return { plan, notes };
}
```

**Macro-hold is free and unchanged:** boost never edits portions to chase a nutrient — it only changes
*which* dish sits in a slot, then `rebalanceWeek` → `rebalanceDay` → `scaleToTargets` re-solves macros.
`nutrientReachable` drops keys the library can't meaningfully close, so we never promise what food
can't carry.

**⚠️ Notes channel caveat (must resolve):** `WeekPlan` has **no `notes` field**, so
`selectConditionAwareWeek(p).plan` would DROP the disclosure — a silent adjustment, which violates the
honesty rule. Either (i) add `notes?: string[]` to `WeekPlan` (`types.ts`) + surface on
`plan/page.tsx`, or (ii) route condition-bias through the assistant ASK flow (which already carries
notes). See §4/§6.

## 4. Honesty / UX — ASK before adjusting (VISION), and the wording

VISION is explicit: **ask before adjusting** (`assistant-7b-vision.md:24-29`; constraint hierarchy
`VISION.md:416-434`; "never fake the numbers" `339-341`). Split by provenance:

- **Unconfirmed mention** ("I'm on my period"): the assistant must **CLARIFY** (four-outcome seam,
  `promptV2.ts:35-36`, `operations:[]`, ask ONE question). On "yes", the model emits the existing
  `constrain(boostNutrient: iron)` op → the already-guaranteed path (`recipeDb.ts:9812+`). No new tool.
- **Durable, already-confirmed condition** (onboarding / confirmed earlier): a *fresh* first build may
  auto-bias, **but only with disclosure** (option (i) above). Silent auto-apply is not allowed.

**Recommended ship order:** `conditions.ts` (table + `conditionBoosts`) + the assistant CLARIFY→
`constrain(boostNutrient)` wiring first (small, VISION-safe, reuses everything). Make `generatePlan`
auto-apply a follow-up gated on adding `WeekPlan.notes`.

```ts
function conditionDisclosure(p: UserProfile, keys: MicroKey[]): string {
  const labels = keys.map((k) => MICRO_LABEL[k]);
  const list = labels.length === 1 ? labels[0]
    : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
  return `Because you mentioned a condition that calls for more ${list}, I've favoured meals richer in ` +
    `${list} while keeping your calories and protein on target. This is food guidance, not medical ` +
    `advice — check anything health-related with your doctor.`;
}
```

Mirrors `symptomNote`'s doctor-pointing rule (`symptoms.ts:13-15`) and `microNote`'s honesty (never
claims a number below 60% coverage).

## 5. Tests (`scripts/test-engine.mts`) — mirror the iron block at ~327-343

- **A period profile's fresh week has MORE iron** than the same profile without the condition, with
  calories/protein still on target (multi-trial; recompute iron independently via the test's own
  `weekMicroAverage2`).
- **Detection:** fresh period → `iron` primary; a period `since` >7 days ago → empty (aged out);
  pregnancy → `folate` primary + `iron` + `calcium`.
- **The promise (multi-nutrient):** no secured nutrient ends BELOW the unbiased baseline. Use a fixed
  `today` so the baseline is genuinely unbiased.
- **Honesty:** a real condition returns a disclosure note mentioning the nutrient and the word
  "doctor".

## 6. Risks / open questions / effort

Decisions for a human:
1. **Ask vs auto-apply on first build** — VISION says ASK. Ship CLARIFY→`constrain(boostNutrient)`
   first; gate `generatePlan` auto-bias behind a notes channel so it's never silent.
2. **Notes channel** — `WeekPlan` has no `notes`. Add one (+ surface in `plan/page.tsx`) or keep
   condition-bias in the op/assistant path only.
3. **Period TTL = 7 days is a guess** — no cycle field on `BodyStats`; `since` = day noted, not cycle
   start. Accept a coarse window or build a real cycle model (Phase 3).
4. **Multi-nutrient is best-effort** — sequential securing can SKIP (never regress) a later nutrient;
   the disclosure only claims nutrients actually raised. Acceptable, or invest in the full `MicroKey[]`
   generalisation (much larger)?
5. **`kind` is unreliable** — detection matches `fact` text, risking a false positive ("my friend is
   pregnant"). The ASK flow mitigates this; auto-apply amplifies it — another reason to prefer ASK.
6. **Mapping gaps** — pregnancy/breastfeeding/menopause clinically want iodine, choline, DHA/omega-3,
   vitB6, vitK — none are `MicroKey`s or in the USDA table. The disclosure must not imply completeness;
   adding those keys is a separate data track.

**Effort (once the toolchain is back):** `conditions.ts` ~1–1.5 h; `selectConditionAwareWeek` +
`conditionDisclosure` + `ai.ts:626` swap ~1.5–2 h; notes channel OR assistant CLARIFY wiring ~1–2 h;
tests ~1–1.5 h. **Total ~5–7 h** for the ASK-first, single-primary + sequential-secure design. The
full `MicroKey[]` generalisation is a separate ~1–2 day change and is NOT required.

**Confirm before paste:** `weekMicroAverage`'s exact return (`recipeDb.ts:~8740`, believed
`{amount, coverage}` — sketches assume `.amount`); whether `selectConditionAwareWeek` should also emit
`reportNotes(rep, p)` diagnostics for the first build.

**Files:** `src/lib/conditions.ts` (new); `src/lib/recipeDb.ts` (+`selectConditionAwareWeek`,
`conditionDisclosure`); `src/lib/ai.ts:626`; optionally `src/lib/types.ts` (`WeekPlan.notes`) +
`src/app/plan/page.tsx`; `scripts/test-engine.mts`. Explicit boost path (`recipeDb.ts:9812/9831`)
unchanged.
