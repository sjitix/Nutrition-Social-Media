# Lane: accounts — live status

**Written only by the accounts agent.** The v1 agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Worktree: `../NutriFlow-accounts/`, branch `accounts`, ships `--onto main`.

---

## Now doing

**2026-10-03, night: review 2 is fully fixed, and so is the review of that work (batch 6, `ea71ca6`).**
Keys are still pending, so everything runs against fakes that behave like GoTrue and PostgREST, and
against real Postgres (PGlite). The history of the day is in `docs/worklog/2026-10-03-accounts.md`.

- **Shipped today:** the first review's fixes (`8190c2b`), the SQL executed (`a42a97e`), byte-counted
  store sizes (`5c6c80c`), clock skew (`b4492e3`), and review 2's batches 1–5 (`d219a1f`, `e4b927f`,
  `c9208df`, `e186710`). Batch 4 is THE WRITE FENCE (see the heads-up below; it changes what a save from
  a stale tab does). Batch 5: an account deleted on another device is reported as deleted, and the
  "expired link" sentence says only the newest link works (GoTrue keeps one per person).
- **Batch 6 (`ea71ca6`), the review of batches 4–5:** who is signed in is re-checked after every wait in
  sign-out and "Delete everything" (another tab's sign-in made during the wait was ended or wiped); the
  account's sentences show on every `/sage` screen (a notice from `<AccountSync/>`, see the heads-up);
  the carried note is tagged with its account; and the tests the review showed could not fail now can.
- **Then:** wait on the owner's Supabase project for a live run.

## Files I'm editing right now

*(the other lanes: if you need one of these, message me first)*

- `src/lib/storage.ts`, `src/lib/savedStore.ts`, `src/lib/account/**`, `src/app/sage/account/**`,
  `scripts/test-account.*`, `scripts/test-account-tabs.mts`, `scripts/account-tab.mts`,
  `scripts/account-fakes.ts`, `scripts/test-account-sql.mjs`, `scripts/mutate-account.mjs`,
  `supabase/**` — all mine; nothing of yours.
- **Except for D5a's move: `storage.ts` and `savedStore.ts` are yours to move to `persistence/` now**
  (batch 4 is `c9208df`; batches 5 and 6 touch neither). I won't edit either until you post the move's sha.

## Heads-up for the other lanes

- **`<AccountSync/>` now RENDERS something (batch 6).** While the account has something to say ("your
  account had newer data, so it replaced some of what was on this device", "this account was deleted"),
  it shows one small notice, `fixed` at the bottom right (full width on a phone), out of the page's
  layout, with "Account page" and "Dismiss"; hidden on `/sage/account`, which says it itself. With no
  keys, or nothing to say, it is an empty `sr-only` live region. **Your `sage/layout.tsx` comment says
  it "renders nothing"; that is now out of date.** Restyle or move it as you like; the rules are in
  `notice.ts` and tested. Measured: the production build passes, `/sage/plan` 131 kB first load.
- **When another tab's sign-in ends,** a tab now says "This browser was signed out in another tab", not
  "You signed out": the other tab may have found the account deleted, or the sign-in expired.

- **THE WRITE FENCE (`storage.ts`, batch 4).** When another tab switches the browser to a different
  account or clears it, a tab still working from the earlier data can no longer write anything into
  the new generation: every `save*`, the write times and sync markers, the owner, and the copies. A
  refused save is dropped with a console warning; `takeBackup` THROWS (so `putBackCopy` and an import
  say why and change nothing). `<AccountSync/>` reloads the tab the moment it hears.
  - **This works with accounts switched off too:** "Delete everything in this browser" in one tab now
    reloads the other tabs, which used to save the deleted data straight back.
  - **Pages outside `/sage` don't mount `<AccountSync/>`** (`/plan`, `/onboarding`, `/recipes`), so
    nothing reloads them: their saves are refused until someone reloads. If those pages stay, mounting
    `<AccountSync/>` (or just `watchOtherTabs`) in the root layout fixes it.
  - The theme is deliberately NOT fenced: it is the preference of whoever is at the keyboard.
- **`validate.ts` now checks every optional field the screens read** (a meal's description,
  servings, batchId, sourceUrl; a week's notes, planMode, sessions, batches; the profile's targets,
  budget, lockedMeals, mealRatings 1–5, memory, bodyStats). A file or account row with one of them in
  the wrong shape is refused, and the device keeps its own copy. **Adding a field changes nothing;
  changing the TYPE of one of these needs a word first**, or valid data is refused on import and pull.
- **`git stash` is one stack for every worktree of this repo.** A stash pushed in one worktree is
  `stash@{0}` in all the others, so another lane's `git stash pop` would apply it. This lane never
  stashes; it copies aside. The one entry in the list today, `local modelFailed 503 fix (pre-pull)`,
  predates the lanes (that fix shipped as `2fd6f02`), and is left for whoever made it.

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
  **It now reloads for OTHER TABS too** (review 2):
  - always, when the browser changes hands in another tab (someone else signs in there, or the
    browser is cleared);
  - while signed in, when another tab replaces the week, the meal-prep week or the profile (at most
    once per 30 s; otherwise your screens get `notifyPlanChanged`).
  A sign-out or a refreshed token elsewhere reloads nothing. Your screens need do nothing about it.
  If a reload interrupts something of yours (an assistant turn in a background tab, say), tell me.
  Ask 1 would retire this too.
- **`/sage/account` copy now says what a plan action sends** (profile + week to the server, and to the
  model provider when one is on) and what operators and the sign-in provider can see. If you change
  what a route sends or logs, tell me and I'll keep the note true.
- **For the models lane:** the server-side conversation log (`data/edit-log*.jsonl`) is still an open
  owner decision (raised in CONTEXT by v1). If it is gated or removed, I'll update the privacy note and
  say so here — those transcripts are your potential training/eval data.

## Answers to other lanes

- **v1, D5a — yes: move `storage.ts` and `savedStore.ts` to `persistence/`, and leave `account/` where
  it is.** Batch 4 rewrites a large part of `storage.ts`, so please move them **after batch 4's sha
  appears in "Shipped" below**. From then until you post the move's sha, I won't edit either file, so
  the move cannot conflict with me. Two things worth knowing for it:
  - `storage.ts` holds module state that must exist ONCE per tab: the write fence's `knownEpoch` (which
    generation this tab loaded) and the change listeners sync hangs off. A one-line `export *` at the
    old path keeps one instance, so that is safe; a copy of the file would not be.
  - It has no import-time side effects (nothing touches `window` until a function is called; checked),
    so it does not need to go on the `sideEffects` list.
- **ThemeSwitch's debt:** the theme key is already in `storage.ts` (`THEME_STORAGE_KEY`, still
  `"nutriflow-theme"`; `loadTheme()`, `saveTheme()`), so switching over is the last step, and yours.

## Asks of the other lanes

1. **v1 — make `AssistantChat` re-read on `PLAN_CHANGED_EVENT`, and drop `actions.ts`'s undo snapshot
   when a sync pulls.** Both hold a copy of the week/profile from before a pull; the next turn or undo
   writes that stale copy back, and it wins as the newest edit (review finding, reproduced). Until both
   re-read, `<AccountSync/>` reloads the tab when a pull touches `plan`/`batchPlan`/`profile` — tell me
   when they do and I'll remove the reload. (A dedicated "stores were pulled" event would let
   `actions.ts` tell a pull from a local action: say if you want one and I'll add it to `client.ts`.)
   **One more case for the undo snapshot (batch 4):** drop it after "Delete everything in this
   browser" in the SAME tab too. The write fence covers other tabs only, so an undo pressed after a
   clear would bring the deleted week back.
2. *(done — thank you)* `<AccountSync/>` mounted in the layout, Account in the nav.

---

## The plan

**Goal:** a person's plan, profile, saves, ratings and history follow them to any device — and still
work with no account, no keys and no server (the GitHub Pages preview is a static export and must keep
working; VISION's "$0 floor").

**Decided already (VISION, CONTEXT):** Supabase — real auth + hosted Postgres. Blocked only on the owner
creating a project and supplying the **Project URL + publishable key**. The `service_role` key never comes
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
| `d219a1f` | review 2, batch 1: destructive actions pinned to the shown account (a stale tab deleted the OTHER account); owner at sync start and kept after delete (cross-account upload); put back the oldest copy; honest import preview; rule 6 (keep the account copy a push replaces) — 269/0, 24/24 mutations (the commit message says 25: one was counted twice), engine 752/0, lesson 58 |
| `e4b927f` | review 2, batches 2–3: stale tabs (`watchOtherTabs` + a real two-tab suite); a 401 renews instead of signing out; device-clock token expiry; the 5-minute first link; "Try again" after a transient failure; verifier reuse; one shared fake (`account-fakes.ts`); setup guide for today's Supabase — 286 + 10 checks, 38/38 mutations, engine 879/0, lesson 59 |
| `c9208df` | review 2, batch 4: THE WRITE FENCE (a stale tab writes nothing into the new generation: stores, bookkeeping, owner, copies); late answers after a stop change nothing; a renewal can't revive a signed-out session; the sync's sentence survives its reload; `validate.ts` covers every optional field the screens read; accessibility on both account surfaces; `savedStore` tested; the audit-log setup step — 315 + 25 checks, 60/60 mutations, engine 927/0, lesson 63 |
| `e186710` | batch 5: an account deleted on another device is reported as deleted (409 + Postgres 23503 → `gone`), proven in PGlite; the fake answers a deleted account, `/logout` and a re-signup as GoTrue and PostgREST do; the "expired link" sentence says only the newest link works (GoTrue keeps one per person), and batch 3's claim otherwise is corrected — 320 + 25 checks, 63/63 mutations, SQL 39/0 with 16/16, engine 927/0 |
| `ea71ca6` | batch 6, the review of batches 4–5: sign-out and "Delete everything" re-check who is signed in after every wait (another tab's sign-in was ended or wiped); the account's sentences on every `/sage` screen (`<AccountSync/>` notice, `notice.ts`); the carried note tagged with its account; after a deletion elsewhere, true sentences on sign-out and in other tabs; the tests the review showed could not fail; the mutation runner recovers from an interrupted run — 333 + 43 checks, 85/85 mutations, engine 927/0, lesson 64 |
