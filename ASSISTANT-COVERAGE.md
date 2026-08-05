# Assistant coverage — the spec for "ready for any request"

The goal isn't to fix failures one at a time. It's to enumerate the **whole space** of what a user could
ask a meal-plan assistant, guarantee the engine can do the common ones, and train the model so that
**every** message resolves to one of four honest outcomes — never a faked success:

1. **DO** — map to a supported tool (or several) and let the deterministic engine execute it.
2. **CLARIFY** — ask one question when the request is real but underspecified (`operations: []`).
3. **DECLINE HONESTLY** — say "I can't do that yet" (and name the closest thing I *can* do) when the
   engine has no capability for it. **This is the category the current model fails** — it fakes success.
4. **REFUSE / REDIRECT** — contradictions, impossible constraints, and safety (crisis, unsafe targets).

The training data must contain all four outcomes for every relevant intent, or the model learns to
guess. The "pancakes every day → did Monday, said every day" bug was outcome 1 missing an engine
capability *and* the model never being taught to decline; both are fixed by covering this matrix.

Legend: ✅ engine supports · 🟡 partial / awkward · ❌ gap (build it, or train an honest decline).

---

## A. Global plan settings  → `update_profile` / `compute_targets` / `regenerate_week`
| Intent | Example | Status |
|---|---|---|
| Calories/day | "2000 calories a day" | ✅ `update_profile targetCalories` |
| Protein/carbs/fat/fiber targets | "set protein to 180", "30g fiber" | ✅ `update_profile targetProtein/…` |
| Compute targets from body | "I'm 30, 80kg, 180cm, male, train 4×, cut" | ✅ `compute_targets` |
| Diet | "go vegan", "keto" | ✅ `update_profile diet` |
| Budget | "make it cheaper" | ✅ `update_profile budget` |
| Cook-time cap (week) | "nothing over 20 min" | ✅ `update_profile maxCookTime` |
| Cuisine | "make the week Italian" | ✅ `regenerate_week cuisine` |
| Exclusions / allergies | "no onions", "I'm allergic to peanuts" | ✅ `update_profile excludeFoods` |
| **Meals per day (3↔4)** | "I want 4 meals a day", "add a daily snack" | ❌ **GAP** — `mealsPerDay` not editable via a tool |
| **Ingredient-count cap** | "keep recipes to 5 ingredients" | 🟡 field exists on profile, not in the tool list |

## B. Scope — *which* part of the week
| Intent | Example | Status |
|---|---|---|
| Whole week | "rebuild my week", "make it all vegetarian" | ✅ |
| One day | "make Tuesday vegetarian" | ✅ `regenerate_day` |
| One meal on one day | "swap Monday lunch" | ✅ `swap_meal day+mealType` |
| **One slot every day** | "pancakes for breakfast every day" | ✅ **now** `swap_meal` no-day |
| **A range of days** | "vegetarian Mon–Wed", "lighter Thu-Fri" | ❌ **GAP** — only single day or whole week |
| **Weekdays vs weekend** | "no cooking on weekdays", "treats on weekends" | ❌ **GAP** |
| **"the rest of the week" / "from tomorrow"** | | ❌ **GAP** (needs a today anchor) |

## C. Meal-level edits
| Intent | Example | Status |
|---|---|---|
| Swap a meal for a named dish | "swap Monday breakfast for pancakes" | ✅ `swap_meal` |
| Bigger / smaller portion | "I'm still hungry", "too much food" | ✅ `scale_portions` |
| **Remove / skip a meal** | "skip breakfast", "I don't eat lunch" | ❌ **GAP** — no delete/skip |
| **Add an extra meal / snack** | "add an afternoon snack Tuesday" | ❌ **GAP** |
| Pin / keep a meal | "always oats on Tuesday" | ✅ `lock_meal` |
| Unpin | "you can change Sunday again" | ✅ `unlock_meal` |
| Rate / like / dislike a dish | "the tofu was awful, never again" | ✅ `rate_meal` |
| Dislike an ingredient forever | "I don't like mushrooms" | ✅ `update_profile excludeFoods` |
| **More variety / less repetition** | "stop giving me chicken every day" | 🟡 exclude a protein; no "variety" knob |

## D. Ingredient level
| Intent | Example | Status |
|---|---|---|
| Exclude an ingredient | "no onions" | ✅ |
| Substitute (out of X) | "no greek yogurt, what else?" | ✅ `substitute_ingredient` |
| Use up what I have | "I've got salmon and broccoli" | ✅ `useIngredients` |

## E. Nutrient / health
| Intent | Example | Status |
|---|---|---|
| Boost a nutrient | "I'm low on iron", "more vitamin D" | ✅ `boostNutrient` |
| Symptom → nutrient check | "I'm always tired", "cramps" | ✅ `symptom_check` |
| Hydration | "how much water?" | ✅ `hydration` |
| **Per-slot macro** | "more protein at breakfast specifically" | 🟡 swap to a high-protein dish; no per-slot target |
| Weekly review | "how am I doing?", "hitting my protein?" | ✅ `weekly_report` |
| Explain a choice | "why salmon on Tuesday?" | ✅ `explain_meal` |

## F. Real-life adaptation
| Intent | Example | Status |
|---|---|---|
| Ate something (log) | "I had pizza for lunch" | ✅ `log_meal` |
| Eating out (future) | "restaurant Friday" | ✅ `eating_out` |
| **Cooking for N / household** | "cooking for 2" | 🟡 `scale_portions` is about hunger, not servings |
| **Meal timing / workout** | "I train at 6pm, carbs around it" | ❌ **GAP** (Phase 7) |
| **Fasting window** | "16:8, nothing before noon" | ❌ **GAP** (Phase 7) |
| **Batch cooking** | "cook once, eat twice" | ❌ **GAP** (Phase 7) |
| **Travel** | "travelling Thu–Fri, no cooking" | ❌ **GAP** (Phase 7) |
| **Quick meals today** | "only 15 min tonight" | 🟡 week-wide `maxCookTime`; no per-day |

## G. Import (share-a-reel)
| Paste a recipe page / TikTok / YouTube / IG link | ✅ URL detected in chat → `/api/import` |

## H. Meta / conversational
| Undo | "undo that", "put it back" | ✅ `undo` |
| What can you do | "what can you do?" | ✅ `answer` (must list REAL capabilities) |
| New plan | "give me a new plan" | ✅ `regenerate_week` |
| Greeting / smalltalk | "hi", "thanks" | ✅ `answer` |
| Ambiguous | "change it" | ✅ CLARIFY |

## I. Contradictions / impossible / safety → REFUSE honestly
| Vegan but add chicken · 300g protein vegan on $20/week · unsafe calorie target · crisis/self-harm |
| The model must not silently comply; the engine has allergy/diet guards + crisis override. |

## J. Multi-turn / reference resolution (a dimension over ALL of the above)
"do that" · "only Tuesday" · "make it 1500" · "no, I said *every* day" · "actually never mind" ·
pronouns · corrections · stacked constraints across turns.

---

## Gaps to build, prioritized (by likely frequency × tractability)
1. **Remove / skip a meal** and **add a meal/snack** (C) — very common, and `mealsPerDay` (A).
2. **Day ranges + weekday/weekend** (B) — "vegetarian Mon–Wed", "lighter on weekends".
3. **Per-slot protein / "more protein at breakfast"** (E) — common fitness ask.
4. **Quick-meals-today (per-day cook time)** (B/F).
5. Later (Phase 7): meal timing, fasting, batch, travel, household servings.

For every gap we don't build yet, the model is trained to **DECLINE honestly** and offer the nearest
supported action — never to fake it.

## Data plan (drives `gen-synthetic`)
Every row above becomes many examples: ≥6 phrasings each, in single- and multi-turn form, with the
scope dimension (B) and reference-resolution dimension (J) crossed in, plus the negative outcomes
(clarify / honest-decline / refuse). Target: several thousand, balanced so no tool or outcome is thin.
