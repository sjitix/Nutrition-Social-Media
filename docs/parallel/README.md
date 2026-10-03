# Two agents, one repo — how the parallel lanes work

**Since 2026-10-03 two Claude agents work on this repo at the same time**, on different dimensions of
the product. This file is the protocol. Both agents read it at the start of every session, and it
changes only when the owner changes the arrangement.

| lane | agent | works in | owns |
|---|---|---|---|
| **v1** | the V1 agent — continues the V1 schedule (`docs/v1/`), Track E follow-ups, the test debt, `check:boundaries`, the `recipeDb` split | the main folder `Nutrition-Social-Media-main/`, branch `main` | everything not listed under accounts |
| **accounts** | the accounts agent — real accounts, a hosted database, sync, export/import, delete-my-data (V1 milestone B3/D11, dimensions #13 and #14) | its own **git worktree** `../NutriFlow-accounts/`, branch `accounts`, shipping onto `main` | the files listed below |

Live status of each lane: **`lane-v1.md`** and **`lane-accounts.md`** in this folder. **Each agent writes
ONLY its own lane file**, so those two never conflict.

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

- `src/lib/storage.ts`, `src/lib/savedStore.ts` — the persistence seam
- `src/lib/account/**` (new), `src/app/account/**` (new), `supabase/**` (new — SQL schema, RLS)
- `scripts/test-account.mts` (new) and its `npm run test:account` script
- `.env.local.example` — only the account-related lines
- `docs/parallel/lane-accounts.md`, `docs/worklog/*-accounts.md`

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

Both lanes ship with `scripts/ship.mjs` (never `git add` + wait + `git commit`):

```bash
# v1 lane, in the main folder:
node scripts/ship.mjs --message-file msg.txt -- <paths>
# accounts lane, in its worktree:
node scripts/ship.mjs --onto main --message-file msg.txt -- <paths>
```

`ship` fetches first and **stops if the remote has changed a file you are about to commit** — that is
the conflict detector, and it fires most often on the shared docs. When it does: `git pull --rebase`
(accounts lane: `git rebase origin/main`), re-read the other agent's change, re-apply yours by hand,
ship again. **Never force-push, never resolve a conflict by taking one side wholesale.**

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
2. Read `CONTEXT.md`, then **both** lane files, then this one if it changed.
3. `ListAgents` — is the other lane running? If so, message it what you are starting on.
4. Update your lane file's "Now doing" and "Files I'm editing right now", ship it (`--no-gate`).
