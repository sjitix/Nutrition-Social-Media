# Lane: accounts — live status

**Written only by the accounts agent.** The v1 agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Worktree: `../NutriFlow-accounts/`, branch `accounts`, ships `--onto main`.

---

## Now doing

**2026-10-03 — A1–A4 built and shipped; keys pending.** The account page (`/sage/account`), export /
import / delete-my-data, the sync rules and engine, the SQL schema with RLS, and the Supabase client
(sign-in by email link, sync, sign-out, delete account) are all in. Without keys, the page says
accounts are off and offers the file instead. **Next:** hardening the client, and the two asks below.

## Files I'm editing right now

*(the v1 agent: if you need one of these, message me first)*

- `src/lib/storage.ts`, `src/lib/account/**`, `src/app/sage/account/**`, `scripts/test-account.*`,
  `supabase/**` — all mine; nothing of yours.

## Heads-up for the other lane

- **`storage.ts` changed underneath, NOT in shape.** Every `load*`/`save*` you call is identical. New
  beside them: `STORE_NAMES`, `readStore`/`writeStore`, `onStoreChange`, `loadStoreMeta`,
  `takeBackup`/`restoreBackup`/`loadBackup`/`discardBackup`, `loadSessionRaw`/`saveSessionRaw`. Every
  save now also stamps a write time and notifies listeners — that is how sync sees your edits, with no
  change on your side. **If you add a new persisted thing, add it as a store in `KEYS` in storage.ts
  (message me) so it syncs and exports; a key named anywhere else would be invisible to accounts.**
- **`clearAll()` is now silent** (it no longer notifies), so clearing a browser can never empty an account.
- **`modelFailed` fix landed** (`2fd6f02`, engine 636/0). Those assistant files are yours again.
  Re-run `test:api` with LM Studio up — the `assistant offline` tests should now see 503.
- **`/sage/account` exists** (new folder, no file of yours touched). Not linked from the nav yet — see Asks.
- **A privacy finding in your files, for you and the owner (not changed by me):** both assistant
  routes append every turn — the user's message and the whole agent transcript — to
  `data/edit-log*.jsonl` on the server, unconditionally (best-effort; it likely fails silently on
  Vercel's read-only filesystem, but logs on any writable host). The account page now says the server
  *may* keep a log of each conversation, which is the truth today. Before a public V1 this probably
  wants an owner decision: keep it opt-in, keep it dev-only, or keep it and say so at the chat box.

## Asks of the other lane

1. **Mount `<AccountSync />` once in `src/app/sage/layout.tsx`** (one import + one element, it renders
   nothing): `import { AccountSync } from "./account/AccountSync";` then `<AccountSync />` inside the
   shell. Without it, sync only runs while the account page is open. With no keys it is a no-op.
2. **Add an "Account" entry to the nav** (`SideNav.tsx` `TABS`, and `MobileNav`) pointing at
   `/sage/account`, with an SVG icon (a person outline fits). Or tell me to do it and I will, in one
   small commit, after you say the files are free.

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

| sha | what |
|---|---|
| `301a2a8` | the parallel-lanes protocol, `ship --onto` |
| `2fd6f02` | one-time handoff: the `modelFailed` fix (not accounts work) |
| `eac9bb8` | A1–A4: storage bookkeeping, export/import/delete, sync rules + engine, SQL + RLS, the REST client, `/sage/account` — `node scripts/test-account.mjs` 94/0 |
