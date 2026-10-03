# Lane: v1 — live status

**Written only by the v1 agent.** The accounts agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Works in the main folder on `main`.

---

## Now doing

**2026-10-03 ~18:30 — D5b done and its review fixed; the false-claim guard landed (`361b2e1`); next the
local-date change, then D5a.** Since the D5b notes below:
- **The allergy parser was reworked after a review** (the commit after `82fe92e`). D5b's first version dropped
  whole clauses as "allowances" ("I can eat anything without gluten" lost the allergy). Now a clause is dropped
  only when it plainly allows one specific food. Allergies are mined for every curated food. DISLIKES are mined
  only for category words, so a dislike blocks less than in D5b and more like before it. **Models lane:**
  allergy rows in your evals may move between `889f667` and this commit, and that is the parser, not the model.
- **Two recipe titles changed:** "Potato & Pepper Tortilla" became "Spanish Potato & Pepper Omelette", and
  "Tortilla & Pepper Scramble" became "Corn Tortilla & Pepper Scramble". **Accounts lane:** a synced plan holding
  the old name keeps it, and the dish simply stops matching the library by name (no error).
- **The false-claim guard:** `claimsChange`, `NOTHING_CHANGED_REPLY` (reply.ts) and `FALSE_CLAIM_NUDGE`
  (agentLoop.ts). `AgentRunResult` gains `falseClaimRetried` / `falseClaimCaught`.
- **`ship.mjs` exits 4 when an autostash came back in conflict** and names the files (`82fe92e`). If you
  use it with `--onto main`, that applies to you too.

**Earlier the same day — D5b done (the maths stated as laws).**
What changed that either of you can see:
- **Allergy parsing (`exclusions.ts`)** reads every clause and blocks far more ways of typing an
  allergy: synonyms, "-free", line breaks, compound foods. `EXCLUSION_CATEGORIES` grew new keys
  (soya, prawn, shrimp, crustacean, mollusc, coeliac, peanut, yogurt…). **Models lane:** expect
  allergen holds to get stricter in your evals. A plan can lose dishes it used to keep, and that is
  the fix working.
- **`compute_targets` / `hydration`** refuse body stats outside 18–100 y, 120–230 cm and 30–300 kg,
  with a note that gives the range. Under 18 it points to a GP or dietitian. Nothing is stored on a
  refusal.
- **`gramsFor`** returns null for a number followed by text that is not a unit (it used to guess
  "count"). Seven library recipes are re-weighed: bell peppers, sweet potato small/large, portobello.
- **`NUTRIENT_TABLE` entries** may carry `filledFrom` and `gaps`. These are additive fields.
- **Accounts lane:** nothing in a stored or synced shape changed.
**Models lane: your false-claim proposal is next on my list.** I will message the sha.

**Earlier — V1 Days 1–3 done. The engine now lives in `src/lib/plan/`** (nine modules +
`index.ts`); `recipeDb.ts` is a 10-line barrel, so **every `@/lib/recipeDb` import of yours still
works unchanged**. If you add engine code, add it in `plan/` — and import from `@/lib/recipeDb` or
`@/lib/plan`, never `@/lib/plan/<file>`: `check:boundaries` now fails a deep import past the index.
**Day 4 (the browser payload boundary) is done for `/sage`:** Week 226 → 129 kB, Explore 212 → 114,
Groceries 123 → 113 (first-load JS). Two shapes changed that could touch you:
`gramsFor` now lives in **`src/lib/units.ts`** (still re-exported from `nutrients.ts`), and the unit
weights are generated into **`src/lib/unitGrams.generated.ts`** by `build:nutrients`; and the feed's
pure half is **`src/lib/feedFilter.ts`** (client-safe) while `feed.ts` builds `FEED_RECIPES` (server
only, re-exports `feedFilter`). A client component must import `feedFilter`, never `feed`.
**C2's crisis pre-scan is done early** (a safety fix, models lane's evidence): `redFlag` in
`src/lib/safety.ts` runs on the raw latest message in both assistant routes before any model and
before demo mode. **Models lane:** a red-flag message now never reaches your model through the
routes; response `{ reply, planChanged: false, plan, profile, safety }`, no `steps`. Your
`distress-crisis` / `symptom-plain` loop rows call `runAgent` directly, not the route, so they still
measure the model's own behaviour — keep them.
**D5 (ingredient identity) is done — and it changes one shared shape, ADDITIVELY.**
**Accounts lane, please read:** `IngredientSchema` in `src/lib/types.ts` gains an **optional**
`slug: string`. A library meal's ingredients now carry it (`{ slug, name, quantity }`); plans stored or
synced BEFORE this have none and still parse (tested). If your sync/merge code compares meals or
ingredients field by field, a slug appearing on a freshly regenerated plan is expected, not a conflict.
Nothing else in the plan shape changed.
**Models lane:** `remember{kind:"allergy"}` is now ENFORCED by the engine; a slot-scoped `constrain`
returns a "nothing changed" note; a day-scoped `constrain` keeps exclude/use/maxCookTime/budget.
Next: D5a (barrels + folders) — I will ask both of you for a date before moving any file you use.

Seven comments the owner left on the module-map board on 2026-09-19 had never been read. One is a
**ruling that affects both of you**: *modularise first, then build on that architecture*. So, from
`558dd15`:

- **Track A is now a gate on all feature work in the v1 lane** — D1 gate → D2/D3 split `recipeDb` →
  D4 payload boundary → D5 ingredient ids → **D5a (A6) every module behind a barrel, in folders** →
  **D5b (A7) the maths proven exact**. My lane does no new features until that is done.
- **A6 will move files into folders** (`core/ data/ nutrition/ plan/ assistant/ providers/
  persistence/ presentation/`). **Nothing of yours moves without your agreement** — see the ask below.
  Every old path keeps a one-line re-export until each lane has rebased past it.
- **C4 (D9a), later: the assistant's vocabulary grows** — every Track E control gets a chat primitive.
  Models lane: that changes the contract you evaluate against, so you get it before it lands.

**Earlier today:** both of the accounts lane's asks done, the test debt paid (details below).

- ✅ **`<AccountSync />` is mounted once** in `src/app/sage/layout.tsx`. Sync now runs on every
  `/sage` screen, not only while the account page is open. I checked before mounting it into every
  route's payload whether it drags the Supabase SDK in — it does not, because you wrote a REST
  client and `@supabase/supabase-js` is not a dependency. Good call; it cost the bundle nothing.
- ✅ **An "Account" nav entry** is in `SideNav.tsx`'s `TABS` with a new SVG `PersonIcon` (no emoji).
  `MobileNav` maps the same array and is a horizontally scrolling row, so the seventh entry extends
  the scroll instead of cramping the bar — the one change covered both halves of your ask.
- ✅ **Your `modelFailed` fix is confirmed from my side:** `test:api` is **60/0** with LM Studio up,
  including the `assistant offline` tests, and the run no longer crashes at the end. Your lesson 48
  was right, and those files are back to being mine.
- ✅ **The test debt is paid:** 24 new engine tests for `previewOperations` / `swapCandidates`
  (engine suite now **660/0**), and a
  new `npm run test:ui` (**51/0**) covering `parseCommand` and `summariseWeek` — the latter was also
  untested, and it is the single copy of the week arithmetic.

**Previously (this session's starting plan):** pay off Track E's test debt, then the asks, then
`check:boundaries`.

Track E (the direct-manipulation layer) shipped H1–H8 yesterday: tap a meal and change it, swap with
the delta shown, a macro dial, drag-and-drop, "I ate something else" re-solving the rest of the day,
a model-free command palette, undo everywhere. Full build log: `docs/v1/05-direct-manipulation.md` §9.

In order this session:

1. **The test debt** — three pure functions are covered only through HTTP and need real unit tests:
   `previewOperations` and `swapCandidates` (both `src/lib/recipeDb.ts`, so they go in
   `scripts/test-engine.mts`) and `parseCommand` (`src/app/sage/commands.ts`). This is the whole
   reason it is first: `parseCommand` was verified yesterday only by a throwaway bundle check, and
   **that check is how both of its bugs surfaced**, so it earned a permanent home.
2. **Your two asks** (below — both are files I own, both are small).
3. **Re-run `test:api`** now that LM Studio is up, to confirm your `modelFailed` fix makes the
   `assistant offline` tests pass.
4. Then V1 **Day 1**: `npm run check:boundaries`.

## Files I'm editing right now

*(the accounts agent: if you need one of these, message me first)*

**Nothing open.** `check:boundaries` shipped (`4e3be01`). Next is V1 Day 2 — `src/lib/recipeDb.ts`
(mine) split into a data module + the engine, behind a barrel so **no importer changes**. Your
imports of `@/lib/recipeDb` keep working untouched.

**`check:boundaries` — what it means for you** (it only READS your files):

- **`ship.mjs` runs it whenever a ship touches `src/`** (~1.3 s, before `test:engine`/`tsc`). A branch
  that predates the script skips it. Run it yourself: `node scripts/check-boundaries.mjs`.
- **Accounts:** your files pass. The first version flagged `"nutriflow-export"` and the download
  filename in `portable.ts` as storage keys; that was the gate's mistake, fixed by matching the key
  convention `nutriflow.<name>`. One listed debt touches your area: `ThemeSwitch.tsx` writes
  `localStorage` itself, and the fix is a `theme` key in `storage.ts`. **That's your file, so I'll
  ask before A6 rather than do it.**
- **Models:** `agentTools.ts → feed.ts` is a listed debt (L4 importing L6). Your diff doesn't need to
  fix it, and it moves in A6.

Shipped this session, so free again: `scripts/test-engine.mts`, `scripts/test-ui.mts` (new),
`src/app/sage/layout.tsx`, `src/app/sage/SideNav.tsx`, `src/components/icons.tsx`, `package.json`
(the `test:ui` line).

## Heads-up for the other lanes

- **`scripts/ship.mjs` changed behaviour (2026-10-03) — all three lanes use it, so read this.** It
  used to `git pull --rebase` BEFORE committing, which cannot work in the normal case: git refuses
  to rebase while the tree has uncommitted changes, and the files you are about to commit ARE
  uncommitted changes. It stopped my push when the models lane landed a commit (safely — nothing was
  lost) and then misreported the refusal as a "conflict". **It now commits first and rebases after**,
  with `--autostash` for any OTHER dirty files, then re-verifies the commit still holds exactly the
  named paths. That is also the stronger guarantee: the work is a commit object, recoverable from the
  reflog, before anything touches the tree. The overlap check (remote changed a file you're
  committing → STOP) still runs first and is unchanged. **Proven on its first real run:** it rebased
  my commit onto `3565e71`, autostashed and re-applied an uncommitted file, and left no stash behind.
  `--onto` is untouched. If it ever misbehaves for you, message me — it's mine to fix.
- **Welcome, models lane.** Read your lane file. `ai.ts`, `agentLoop.ts`, `promptV2.ts` and
  `eval-hardcases.mts` stay mine as the README says; send the over-act prompt fix when it's proven
  and I'll land it. One request back: **please don't change the shape of the agent loop's `ModelFn`
  without asking** — it is the seam that lets the whole loop be tested with no model, and the engine
  suite depends on it.

- **Track E added two engine exports you may see in the map:** `previewOperations(profile, plan, ops)`
  simulates against a `structuredClone` and commits nothing, and `swapCandidates(...)` lists the
  dishes that could take a slot with the delta each would cause. Neither touches persistence.
- **`/api/operation` changed shape, additively:** it now accepts an `operations` **list** as well as a
  single `operation` (a drag-and-drop move is a pair of swaps, so it is one undo), plus
  `preview: true` which simulates and returns no plan. The single-`operation` form is unchanged.
- **`/api/candidates` is new** and read-only.
- **I will add a `test:ui` npm script** (one line). Nothing of yours moves.
- **Noted and NOT acted on: your privacy finding about `data/edit-log*.jsonl`.** You are right that
  both assistant routes append every turn unconditionally. I am not changing it unilaterally, because
  **it is deliberate and load-bearing** — `STATUS.md` records `data/edit-log-v2.jsonl` as the training
  data for the fine-tune, and multi-step transcripts are described there as "what training data for
  the next model looks like". Silently gating it could cost the owner their corpus. **It needs an
  owner decision** (opt-in, dev-only, or keep it and say so at the chat box), and it is now raised in
  `CONTEXT.md` as an owner-gated item rather than left in a lane file. Your account page's wording —
  that the server *may* keep a log — is the honest description of today.

## Asks of the other lanes

- **Models lane — the owner asked you a question, via a board comment (2026-09-19, forwarded
  2026-10-03):** *"What is the maximum AI agent we can run on cloud — just for beta testing, but way
  faster, but still sufficient and intelligent for the task at hand? What about things like 128 GB?"*
  Your round-1 survey (`cc1aadb`) already answers the cloud half, and I quoted it back to the owner
  in the thread. **The open half is the 128 GB machine** (a DGX Spark, a Ryzen AI Max+ 395 box, or a
  Mac Studio, presumably): what it would run (a ~120B MoE such as `gpt-oss-120b` fits in memory) and
  how fast, measured or sourced rather than estimated. The thread stays open on the module-map board
  until there is an answer; tell me here and I'll post it, or the owner can read your survey.
- **Accounts + models lanes — for A6 (later, not this week):** when the module folders land, I'd
  like each of you to either move your own files or approve my moving them, at a time you're between
  commits. Accounts: `storage.ts`, `savedStore.ts`, `account/**` → `persistence/`. Models: nothing of
  yours moves, but `ai.ts`, `promptV2.ts`, `agentLoop.ts` (mine, which you run) go to `providers/` and
  `assistant/`, with re-exports left at the old paths. No action now — I'll ask again with a date.

## Shipped

| sha | what |
|---|---|
| `55b4e50` | Track E H1 — `previewOperations`, `preview: true`, the widened allowlist, `actions.ts` |
| `2e3294b` | Track E H2 — the Meal Sheet, and `Sheet.tsx` extracted as the dialog shell |
| `ee025b0` | Track E H3–H6 — swap with deltas, the macro dial, drag-and-drop, the deviation flow |
| `9ddca92` | Track E H7 — the model-free command palette, keyboard map, undo toast |
| `428f79c`…`f370aa7` | `scripts/ship.mjs` and three fixes found by shipping it with itself |
| `a7df1f4` | the shutdown handoff |
| `24de555` | Track E test debt paid; the accounts lane's two asks done |
| `558dd15` | the owner's seven module-map comments applied — Track A becomes a gate; A6, A7, C4 added |
| `08ee43f` | WORKPLAN lesson 50 — read every board's comments at session start |
| `4e3be01` | **V1 Day 1: `check:boundaries`**, and `ship.mjs` runs it on every `src/` change |
| `b56cbce` | **V1 Day 2: the seeds move to `src/lib/data/seeds.ts`** — `recipeDb.ts` 11,062 → 3,317 lines |
| `6b80350` | `eval:hardcases` reports `actedRightV2` beside v1 |
| `35a1265` | `ship.mjs` fetches again after the gate (stops on overlap, rebases otherwise) |
| `5cab547` | swaps: `keepOtherMeals` / `swap {only}`; the default never replaces silently |
| `658a225` | the record corrected (VISION, lesson 51, owner decision #7) |

## Known issues in v1's files (found by other lanes, queued)

- **The agent loop's read tools are unreachable in production** (models lane, 2026-10-03): the turn
  schema and the prompt never name them. Fix in flight on `models-exp`; I land it on `main`.
- **Nothing tells the model today's date** (models lane): "I ate a burger for lunch today" makes the
  model ask which day it is. After the read-tool fix.
- **FIXED, `5cab547` (test:engine 680/0): a scoped change is not respected** (models lane's loop eval): "swap JUST
  Wednesday's dinner" also replaced breakfast — and often lunch (24 of 24 probe scenarios). **Contract
  change:** `Operation.keepOtherMeals` and primitive `swap {..., only?: boolean}` → resize the other
  meals, never replace them, and OFFER the replacement by name. Default (no flag) is unchanged — it
  may still replace, because that is VISION's written rule — but it now always names what it
  replaced (the whole-week path did it silently). My first version changed the default for everyone
  and the engine gate rightly rejected it (lesson 51). **Models lane adds the prompt line** in
  `models-exp`: *"`only: true` when the user limits the change to that meal ('just', 'only', 'leave
  the rest') — the day's other meals are then resized, never replaced; otherwise the engine may
  replace another meal to keep macros and will say so."* Their `single-slot` row goes back into the
  MODEL's score (pass = the model sends `only:true`).
- **For the beta decision, not a bug to fix today:** `ai.ts` gives up after ~12 s of HTTP 429s, so a
  free hosted tier caps the beta at a few concurrent chats (models lane, measured on NIM).
