# Lane: accounts — live status

**Written only by the accounts agent.** The v1 agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Worktree: `../NutriFlow-accounts/`, branch `accounts`, ships `--onto main`.

---

## Now doing

**2026-10-03: accounts reviewed and hardened, and the SQL executed; keys still pending.** A five-lens
review (data loss, security, the real Supabase API, React/UI, integration; every finding checked by two
skeptics) found real bugs in the A1–A4 code. All are fixed and shipped as `8190c2b`:
- PKCE sign-in and the account-switch guard;
- key-order-blind sync;
- conditional server writes (migration 0002);
- restore without deletions, and targeted backups;
- an honest privacy note.

Then the SQL ran for the first time, in PGlite with Supabase's default grants. It found that signed-in
users still held TRUNCATE, which is now closed in 0001. The store-size cap now counts UTF-8 bytes, as
the server does.

**Clock skew between devices lost edits silently, and is fixed (lesson 57).** A phone 2 h slow had
its post-sync edit pulled back over with no backup, and a device a day fast locked stores for a day.
Every write is now stamped later than what it replaces.

**Second review, of the hardening itself.** Four lenses ran on a frozen snapshot (`../NutriFlow-review2`,
detached, to be removed afterwards). Three of them reported 23 findings, each with a reproduction. The
security lens and the skeptics hit a usage limit and were resumed; they are still running.

**Batch 1 is fixed (shipping):**
- delete, sign-out and forget are pinned to the account this tab shows;
- the owner is recorded at sync start and kept after delete;
- "Put it back" works on the oldest copy;
- the import preview names what it clears, and a file with a null store is refused;
- rule 6 keeps the account's copy a push replaces.

**Next:**
- batch 2, stale tabs: a tab-lifetime watcher, with a real two-tab test harness;
- batch 3, sign-in against the real GoTrue: a 401 means refresh and retry; token expiry relative to the
  device clock; the 5-minute first-link window; keep the verifier on transient failures;
- batch 4: status, tests, fake fidelity, accessibility.
Then wait on the owner's Supabase project for a live run.

## Files I'm editing right now

*(the other lanes: if you need one of these, message me first)*

- `src/lib/storage.ts`, `src/lib/savedStore.ts`, `src/lib/account/**`, `src/app/sage/account/**`,
  `scripts/test-account.*`, `scripts/test-account-sql.mjs`, `scripts/mutate-account.mjs`,
  `supabase/**` — all mine; nothing of yours.

## Heads-up for the other lanes

- **`storage.ts` — what changed underneath, still NOT in shape.** Every `load*`/`save*` you call is
  identical, but two behaviours are new and you may notice them:
  - **A save that changes nothing is now a no-op** — no write time, no event, no sync. Re-saving the
    same content (in any key order), or saving `[]`/`null` over a store that doesn't exist, does
    nothing. This was needed because screens re-save what they loaded (GroceriesClient's persist
    effect, AssistantChat after every turn), and with sync that made a stale copy the "newest edit".
  - **`rememberImport` stamps each entry with `importedAt`**, so two devices' histories merge by recency.
  - **Write stamps are ORDERING stamps, not wall-clock times** (lesson 57). A write, an import or a
    restore is stamped `max(now, the replaced value's stamp + 1)`, so one can sit slightly in the
    future after a device with a fast clock synced. No screen reads them today. If one ever shows
    `importedAt` or the store meta as a time ("imported 3 min ago"), say so first, since that time can
    be wrong.
  New beside the old API (all accounts-only): `STORE_NAMES`, `readStore`/`writeStore`, `onStoreChange`,
  `loadStoreMeta`, `loadSyncedAt`/`markSynced`, `takeBackup`/`loadBackups`/`restoreBackup(id)`/
  `discardBackup(id)`, owner/session/PKCE helpers, `onSignInChangedElsewhere`, `claimSyncReload`.
  **If you add a new persisted thing, add it as a store in `KEYS` (message me) so it syncs and exports.**
- **The theme key now lives in `storage.ts`** for ThemeSwitch's boundaries debt (rule 3):
  `THEME_STORAGE_KEY` (still `"nutriflow-theme"`, so nobody loses their choice), `loadTheme()`,
  `saveTheme("sage" | "violet")`. The boot script can interpolate `THEME_STORAGE_KEY`. Yours to switch
  over whenever suits; then delete the KNOWN_DEBT entry.
- **`<AccountSync/>` reloads the tab once** (at most once per 30 s, per tab) when sync brings the week,
  the meal-prep week or the profile DOWN from the account. Reason, and how to retire it: Ask 1 below.
- **`/sage/account` copy now says what a plan action sends** (profile + week to the server, and to the
  model provider when one is on) and what operators and the sign-in provider can see. If you change
  what a route sends or logs, tell me and I'll keep the note true.
- **For the models lane:** the server-side conversation log (`data/edit-log*.jsonl`) is still an open
  owner decision (raised in CONTEXT by v1). If it is gated or removed, I'll update the privacy note and
  say so here — those transcripts are your potential training/eval data.

## Asks of the other lanes

1. **v1 — make `AssistantChat` re-read on `PLAN_CHANGED_EVENT`, and drop `actions.ts`'s undo snapshot
   when a sync pulls.** Both hold a copy of the week/profile from before a pull; the next turn or undo
   writes that stale copy back, and it wins as the newest edit (review finding, reproduced). Until both
   re-read, `<AccountSync/>` reloads the tab when a pull touches `plan`/`batchPlan`/`profile` — tell me
   when they do and I'll remove the reload. (A dedicated "stores were pulled" event would let
   `actions.ts` tell a pull from a local action: say if you want one and I'll add it to `client.ts`.)
2. *(done — thank you)* `<AccountSync/>` mounted in the layout, Account in the nav.

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

**Status (2026-10-03):** A1–A3 done. A4 code-complete and tested end to end against an in-memory
Supabase (238 checks), then hardened by an adversarial review (PKCE, the account-switch guard,
conditional writes in migration 0002); the live run waits on the owner's project. A5 done — the v1 lane
mounted `<AccountSync/>` and added the nav entry. A6 done — `delete_my_account()` plus a privacy note
whose claims were each checked against the code (and corrected twice by the review).

## Shipped

| sha | what |
|---|---|
| `301a2a8` | the parallel-lanes protocol, `ship --onto` |
| `2fd6f02` | one-time handoff: the `modelFailed` fix (not accounts work) |
| `eac9bb8` | A1–A4: storage bookkeeping, export/import/delete, sync rules + engine, SQL + RLS, the REST client, `/sage/account` — `node scripts/test-account.mjs` 94/0 |
| `91501d5` | docs: A1–A4 recorded — what works without keys, what waits on them, and two asks |
| `8190c2b` | the adversarial review's fixes: PKCE, the account-switch guard and per-account pin, key-order-blind sync, `upsert_state` (0002), restore without deletions, rows validated on pull, the privacy note — 238/0, 8/8 mutations caught, engine 680/0 |
| `a42a97e` | the SQL executed in real Postgres (`test-account-sql.mjs`, 37/0, 15/15 mutations); TRUNCATE revoked from signed-in users; test plan rows 5/5b/5c; lessons 52–56 |
| `5c6c80c` | the store-size cap counts UTF-8 bytes, as the server does (`storeBytes`): a long Japanese or Arabic chat was waved through by `.length` and then refused, re-uploaded on every edit — 240/0, 9/9 mutations, engine 680/0 |
| `b4492e3` | clock skew: every write stamped later than what it replaces (`nextStamp`). A 2-h-slow phone lost post-sync edits silently; a day-fast device locked stores; merged stores never settled; "Put it back" lost its copy. All reproduced first — 252/0, 14/14 mutations, engine 680/0, lesson 57 |
| *(next)* | review 2, batch 1: destructive actions pinned to the shown account (a stale tab deleted the OTHER account); owner at sync start and kept after delete (cross-account upload); put back the oldest copy; honest import preview; rule 6 (keep the account copy a push replaces) — 269/0, 25/25 mutations, lesson 58 |
