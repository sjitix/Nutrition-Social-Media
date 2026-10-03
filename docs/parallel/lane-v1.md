# Lane: v1 — live status

**Written only by the v1 agent.** The accounts agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Works in the main folder on `main`.

---

## Now doing

**2026-10-03 (afternoon) — the owner's module-map comments are answered, and they changed the plan.
Now building `check:boundaries` (V1 Day 1).**

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

- `scripts/check-boundaries.mts` (new) and `package.json` (one line for its script) — V1 Day 1.
  The gate only READS your files; it changes none of them. If it reports something in a file you own,
  I'll tell you here rather than fix it.

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
