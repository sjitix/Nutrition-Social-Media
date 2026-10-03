# Lane: accounts — live status

**Written only by the accounts agent.** The v1 agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Worktree: `../NutriFlow-accounts/`, branch `accounts`, ships `--onto main`.

---

## Now doing

**2026-10-03 — lane set up.** Next: building A1–A3 below (no Supabase keys needed for any of them).

## Files I'm editing right now

*(the v1 agent: if you need one of these, message me first)*

- `scripts/ship.mjs` — adding `--onto` (additive; default behaviour unchanged). Shipping in the setup commit.
- `docs/parallel/**`, `CONTEXT.md` (my block only), `CLAUDE.md` (one rule), `WORKPLAN.md` (RESUME pointer + lesson 48)
- One-time handoff, NOT accounts work: the `modelFailed` fix from a previous session (below).

## Heads-up for the other lane

- **The unshipped `modelFailed` fix is moving through this lane once, then the files are yours again.**
  It was left uncommitted in the main folder by an earlier session and has been moved into this
  worktree so your folder starts clean. It touches `src/lib/agentLoop.ts`,
  `src/app/api/assistant-v2/route.ts`, `src/app/sage/assistant/AssistantChat.tsx`,
  `scripts/test-engine.mts` (+8 loop tests), `ASSISTANT-SCHEMA.md`, `CLAUDE.md`, `CONTEXT.md`,
  `WORKPLAN.md` (lesson 48). What it does: when the model is unreachable, `/api/assistant-v2` answers
  **503 offline** if nothing changed, or **200 + `modelFailed: true`** if the engine already changed
  something. It is very likely why CONTEXT records the `assistant offline` API tests getting 502
  instead of 503 — re-run `test:api` after it lands. **Pull before you touch any of those files.**
- **`storage.ts`'s API will not change shape.** Keep calling `loadPlan`/`savePlan`/etc. exactly as you
  do. Sync is added underneath, so your callers need no edits.

## Asks of the other lane

*(none yet)*

---

## The plan

**Goal:** a person's plan, profile, saves, ratings and history follow them to any device — and still
work with no account, no keys and no server (the GitHub Pages preview is a static export and must keep
working; VISION's "$0 floor").

**Decided already (VISION, CONTEXT):** Supabase — real auth + hosted Postgres. Blocked only on the owner
creating a project and supplying the **Project URL + anon key**. The `service_role` key never comes
near this public repo.

**The design: local-first, the account is a mirror.** localStorage stays the thing every screen reads,
synchronously, exactly as today. When someone is signed in, a sync layer under `storage.ts` mirrors
each key to their row in the database and pulls it back on another device. Consequences, all wanted:

- **Zero call-site changes** — the nine files that call `storage.ts` are untouched, which is what lets
  two lanes work at once.
- **Offline and keyless keep working**, because the local copy is always the working copy.
- **One table, one shape:** `user_state (user_id, key, value jsonb, updated_at)`, one row per storage
  key, RLS `user_id = auth.uid()`. The keys are exactly `storage.ts`'s `KEYS` — the same "one concept,
  one key" rule, now enforced on the server too. Conflict rule: per key, newest `updated_at` wins; on
  the **first** sign-in from a device, local data is uploaded rather than overwritten (losing
  someone's week on sign-in is the failure to design out first).
- **Sign-in by email magic link** — no passwords to store, leak or reset.

### Milestones (each ships green on its own)

| # | Milestone | Needs keys? | Usable on its own when… |
|---|---|---|---|
| A1 | **Your data is yours:** export everything to a file, import it on another device, and **delete all my data** — the V1 D11 fallback, and it is useful forever | no | a plan moves between two browsers via a file, round-trip identical |
| A2 | **The sync seam:** `storage.ts` emits a change for every write; `src/lib/account/sync.ts` (pure merge rules: newest wins, first-sign-in uploads) with `npm run test:account` | no | merge rules proven by tests, including the "don't wipe local on first sign-in" case |
| A3 | **The schema:** `supabase/migrations/*.sql` — `user_state` + RLS, with a written RLS test plan | no (written, not applied) | the SQL is reviewable and RLS denies cross-user reads on paper |
| A4 | **Auth + sync live:** `@supabase/supabase-js`, magic-link sign-in at `/account`, the mirror switched on when keys exist and inert when not | **yes** | sign in on two browsers, edit on one, see it on the other |
| A5 | **The entry points:** an account control in the SidePanel footer, "keep it in your account" after onboarding (v1-owned files — asked first) | yes | a stranger finds sign-in without being told |
| A6 | **Account deletion server-side** and a privacy note that tells the truth about what is stored | yes | "delete my account" removes every row, verified |

## Shipped

*(nothing yet)*
