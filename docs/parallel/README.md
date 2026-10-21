# Three agents, one repo — how the parallel lanes work

**Since 2026-10-03 Claude agents work on this repo at the same time** (two at first; a third, the
models lane, joined the same day), on different dimensions of the product. This file is the protocol.
Every agent reads it at the start of every session, and it changes only when the owner changes the
arrangement.

| lane | agent | works in | owns |
|---|---|---|---|
| **v1** | the V1 agent — continues the V1 schedule (`docs/v1/`), Track E follow-ups, the test debt, `check:boundaries`, the `recipeDb` split | the main folder `Nutrition-Social-Media-main/`, branch `main` | everything not listed under accounts |
| **accounts** | the accounts agent — real accounts, a hosted database, sync, export/import, delete-my-data (V1 milestone B3/D11, dimensions #13 and #14) | its own **git worktree** `../NutriFlow-accounts/`, branch `accounts`, shipping onto `main` | the files listed below |
| **models** *(added 2026-10-03)* | the models agent — model enhancement: surveys high-parameter LLMs for quality AND latency, the loop-level eval, the assistant-brain choice | its own **git worktree** `../NutriFlow-models/`, branch `models`, shipping onto `main` | the files listed below |

Live status of each lane: **`lane-v1.md`**, **`lane-accounts.md`** and **`lane-models.md`** in this
folder. **Each agent writes ONLY its own lane file**, so those never conflict. Where this file says "the
other lane", read "the other lanes" — the rules apply pairwise between all three.

**Where each lane runs (checked 2026-10-18):** all three on the laptop: v1 in the main folder, accounts in `../NutriFlow-accounts/`, models in
`../NutriFlow-models/` and `../NutriFlow-models-exp/` (created 2026-10-18). The laptop also has **no `.env.local`**, so
anything that needs the NVIDIA key or LM Studio runs where those are, or the owner recreates the file.

---

## 0. The owner's standing rules — every lane, every session (2026-10-18)

Given by the owner for all agents. They sit above everything else in this file.

1. **Keep everything current, constantly.** Your lane file, your block in `CONTEXT.md`, your worklog
   for the day, and `VISION.md` / `WORKPLAN.md` / `CLAUDE.md` / `ASSISTANT-SCHEMA.md` whenever what they
   say stops being true. Update them **as the work happens**, not at the end: a session can be cut
   short, and an unwritten state is a lost state.
2. **Pull constantly.** `git fetch` and rebase at session start, before editing any shared document,
   before every ship, and after any long wait (a gate, a review, an eval run). Never build on a stale
   tree.
3. **Push constantly.** Every significant step is shipped with `ship.mjs` and pushed at once;
   `git log origin/main..HEAD` reads empty at the end of every step.
4. **Keep the other agents informed, constantly.** At session start, and after every ship another lane
   could notice, run `ListAgents` and `SendMessage` every running lane: the sha and one line on what it
   means for them. A lane that is not running gets the same news in your lane file's "Heads-up". Say
   which lane you are in the first line.
5. **The owner's decisions doc is where the owner answers.**
   https://claude.ai/code/artifact/a3290f96-fc25-43a6-932d-9982a46bb70f lists every decision waiting on
   the owner, in plain language, with options and a recommendation. Read its comment threads at session
   start, the same way as the boards (WORKPLAN lesson 50). An answered decision is acted on by the lane
   that owns it. A lane that needs a NEW owner decision adds it there in the same plain form and tells
   the v1 lane, which keeps the doc tidy.

---

## 1. Why separate folders, not just separate files

Two agents in one working directory share the **index** and each other's **half-finished edits**.
WORKPLAN lesson 47 is the scar: staged work sat in `.git/index` during a 25-minute gate and a commit
made from the same directory swept it up under someone else's message. A second agent in the same
folder would also run its gate against the other's unfinished code, so a red `test:engine` would have
two candidate causes (lesson 2, lesson 44).

So the accounts agent has its own worktree. It is the same repository (`git worktree list` shows
both), but a separate folder, index and checkout. **Neither agent ever edits a file in the other's
folder.** Each one's work reaches the other only through `origin/main`.

## 2. File ownership

**The accounts lane owns** (the v1 agent does not edit these; ask instead):

- `src/lib/persistence/**` (`storage.ts`, moved there 2026-10-18; the old path is a re-export) — the persistence seam. `savedStore.ts` moved into `account/` and is covered by the next line
- `src/lib/account/**` (new), `src/app/sage/account/**` (new — the account page, inside the /sage shell), `supabase/**` (new — SQL schema, RLS)
- `scripts/test-account.mts` + `scripts/test-account-tabs.mts` + `scripts/account-tab.mts` + `scripts/account-fakes.ts` + the runner `scripts/test-account.mjs` (run with `node scripts/test-account.mjs`; no package.json change needed), `scripts/mutate-account.mjs` (the guards' mutation check), and `scripts/test-account-sql.mjs` (the migrations in real Postgres)
- `.env.local.example` — only the account-related lines
- `docs/parallel/lane-accounts.md`, `docs/worklog/*-accounts.md`

**The models lane owns** (the other lanes do not edit these; ask instead):

- `docs/models/**` (new — model research, benchmarks, decisions, the owner to-do)
- `scripts/models/**` (new — model-eval tooling: latency sweeps, the loop-level eval)
- `data/eval-runs/**` — primary writer; every scorecard is timestamped, so a v1 run of
  `eval:hardcases` landing a file there never collides
- `docs/parallel/lane-models.md`, `docs/worklog/*-models.md`

It **runs but does not edit** `scripts/eval-hardcases.mts`, `src/lib/promptV2.ts`, `src/lib/ai.ts` and
`src/lib/agentLoop.ts` (v1's), and asks the v1 agent before any change to them lands on `main`.

**Shared — announce before touching, keep the edit tiny, ship it at once:**

- `package.json` / `package-lock.json` (the accounts lane adds `@supabase/supabase-js` and one script)
- `src/app/sage/SidePanel.tsx` (an account entry point in the footer), `src/app/onboarding/page.tsx`
  (a "keep it in your account" step) — the v1 lane owns these files; the accounts lane asks first
- `src/lib/types.ts` — only if a profile field is genuinely needed; optional fields only
- `CONTEXT.md`, `CLAUDE.md`, `WORKPLAN.md`, `VISION.md`, `ASSISTANT-SCHEMA.md`, `docs/worklog/README.md`

**The v1 lane owns everything else**, including the engine (`recipeDb.ts` and friends), every
`/sage` screen, `actions.ts`, `commands.ts`, the API routes, `scripts/test-engine.mts`, `docs/v1/**`
and **the three visual boards** (`docs/v1/boards/*` — the accounts lane never republishes a board; it
asks the v1 agent to).

**The design that keeps this split clean:** accounts sit *behind* `storage.ts`. Its synchronous API
(`loadPlan`, `savePlan`, …) does not change shape, so the nine files that call it are untouched and the
v1 agent never has to wait on the accounts agent. Sync happens underneath.

## 3. Shipping

Every lane ships with `scripts/ship.mjs` (never `git add` + wait + `git commit`):

```bash
# v1 lane, in the main folder:
node scripts/ship.mjs --message-file msg.txt -- <paths>
# a lane in its own worktree:
node scripts/ship.mjs --onto main --message-file msg.txt -- <paths>
# a ship that exited 3 (committed locally, not pushed), once the reason is fixed:
node scripts/ship.mjs --resume [--onto main]
```

`ship` fetches first and **stops if the remote has changed a file you are about to commit** — that is
the conflict detector, and it fires most often on the shared docs. It checks again after the gate.
When it fires, nothing is committed, and it prints the way through: copy your versions aside,
`git checkout -- <them>`, `git merge --ff-only origin/main`, re-read the other agent's change,
re-apply yours by hand, then ship again. **Never force-push, and never resolve a conflict by taking one
side wholesale.**

Since 2026-10-18 (v2, `node scripts/test-ship.mjs` replays all 43 scenarios), it also **refuses**:
- unpushed commits it did not make (`--resume` pushes the single one a failed ship left);
- `--no-gate` for any file a gate reads;
- a gated ship while other uncommitted work that gate reads sits in your tree. Name that work in
  the ship, or copy it aside.

Its exit code says what is true: 0 pushed; 1 nothing committed (an error, or the gate went red);
2 nothing committed (stopped on purpose); **3 committed locally, not pushed: run `--resume`**;
4 pushed, but your folder could not catch up without touching local edits (it prints the two
commands that finish it).

**Never `git stash` by hand in any lane.** The stash stack belongs to the repository, not to a
worktree: a stash pushed in one worktree is `stash@{0}` in every other, so the next lane to run
`git stash pop` applies YOUR work to ITS tree. To get uncommitted work out of the way (a fast-forward,
say), copy the changed files aside, check the copies byte for byte, and copy them back afterwards.
`ship` itself no longer stashes or pulls at all: when the remote moved, it rebuilds the commit on top
in a private index.

## 4. The shared documents

`CONTEXT.md` and friends are edited by both lanes, so:

1. **Fetch and rebase immediately before editing one.** An edit made against a stale copy is the
   conflict.
2. **Each lane edits only its own block** in `CONTEXT.md`'s "Where it left off": the v1 block, and the
   block headed `PARALLEL LANE — accounts`. Neither rewrites the other's.
3. **Keep it short and ship it at once** — a shared doc should never sit edited-but-unshipped while a
   gate runs. Ship docs with `--no-gate` the moment they are written.
4. **WORKPLAN lessons are numbered at ship time.** Fetch, take the next free number, ship. If `ship`
   stops because the other lane just added one, renumber yours.
5. **The worklog is per lane per day:** the v1 lane keeps `docs/worklog/YYYY-MM-DD.md`, the accounts
   lane writes `docs/worklog/YYYY-MM-DD-accounts.md`. Both add their row to the README index.

## 5. Talking to each other

Two channels, for two different jobs:

- **The lane files are the record.** Anything the other agent must know to avoid a conflict goes in
  your lane file under "Heads-up for the other lane", and is shipped. This survives sessions ending.
- **Direct messages are the doorbell.** Both agents run on the owner's machine and can message each
  other: `ListAgents` shows who is running and their names, `SendMessage` delivers. Use it to say
  "I just shipped X, re-read my lane file", or "I need to touch your file Y — OK?". A message is not a
  record; if it matters, it is also in the lane file.

**Send a message when:** you are about to touch a shared or other-owned file; you shipped something the
other lane's code calls or depends on; you changed a contract (a type, a storage key, a route shape);
or `ship` stopped on a file the other lane changed. **Wait for an answer before editing a file the
other lane owns.** If the other agent isn't running, write the ask in your lane file under "Asks" and
leave the file alone.

## 6. Start-of-session checklist (both lanes)

1. `git fetch` and rebase onto `origin/main`.
2. Read `CONTEXT.md`, then **every** lane file, then this one if it changed.
3. Read the comment threads on the owner's decisions doc and the three boards (§0 rule 5).
4. `ListAgents` — which lanes are running? Message each what you are starting on (§0 rule 4).
5. Update your lane file's "Now doing" and "Files I'm editing right now", ship it (`--no-gate`).
