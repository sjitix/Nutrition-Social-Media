# Lane: accounts — live status

**Written only by the accounts agent.** The v1 agent reads it; it does not edit it. Protocol:
[`README.md`](README.md). Worktree: `../NutriFlow-accounts/`, branch `accounts`, ships `--onto main`.

---

## Now doing

**2026-10-23: "Try again" after a failed sign-in exchange, run live and fixed (`4fa187f`). The live run
is 55/55, and 39 of its 55 checks are proven able to fail (31/31).** "Try again" is offered when the
link's exchange fails for a transient reason, with the code kept. Against GoTrue's source it handled five
cases wrongly:
- three were told wrongly. A lost answer (GoTrue had used the code, so the retry gets 404) blamed the
  link. A late retry (422) blamed a slow first link. An answer cut off after its headers showed the
  browser's own error;
- two failed although they could have finished. Another tab's request broke the retry, which paired this
  tab's code with the newer verifier. And "Sam@" after "sam@" made a new verifier, though GoTrue
  lowercases addresses.

Each is fixed, and the rules for a kept sign-in are settled:
- it is kept or given up by its own address;
- "Delete everything" ends it in every tab, since it is stamped with the data generation, and so does
  a sign-in elsewhere;
- an exchange the browser was cleared under keeps nothing.

Five reviews (18, 13, 10, 10 and 4 findings). Two rare cases are left, in the 2026-10-23 day file. The
gateway can now drop a response, or cut one off after its headers.

**2026-10-21, later: "Confirm email" on, run live (`a915d12`). The live run is 50/50, and 35 of its 50
checks are proven able to fail (24/24).** A second GoTrue on the same database has "Confirm email" on,
a hosted project's default, behind the gateway's `/confirm` prefix. Four browsers are pointed at it.
Against the real GoTrue, it shows:
- a new person's first link is a confirmation link;
- opened six minutes after the REQUEST, it is refused by the exchange (422) with the slow-first-link
  sentence, while one opened at four minutes works. The run moves requests back in `auth.flow_state`
  rather than wait; GoTrue's source gives 300 s and takes no less;
- the magic link asked for next still works aged the same, because a magic link's five minutes run from
  its opening;
- a second request from someone who has not yet opened a link, refused as too soon, rolls back its own
  flow state, because GoTrue's sign-up path refuses inside its transaction. So it takes nothing over.
  The README's qualifier on the takeover rule now says confirmed versus not, which is the line GoTrue
  draws.

Two new mutations require it: "Confirm email" off on that server, and the app's 422 mapping removed.
A review of the batch (one agent, 6 findings, none of which broke a check) is fixed in `2bd92e8`. It
covers the mechanism above, a four-minute point to bracket the limit, a logged 422, GoTrue's 60 s
message pinned, a magic-link path setting GoTrue never reads, and stale text. Two things this stack
could still show are listed in `supabase/README.md`.

**2026-10-21: the Site URL batch landed (`c284616`): the live run was then 45/45, with 31 of its 45
checks proven able to fail by mutation (22/22).** It adds:
- **Sign-out on one of two devices** ends only that one: Jo signs in on the tablet and the desk, signs
  out on the desk, and the tablet still renews (`scope=local`).
- **The Site URL fallback,** run for real. A preview the allow list refuses (Kai, then Lee) gets its
  link sent to the Site URL's page, which has storage of its own:
  - holding no request, the page says the link was asked for at a different web address;
  - holding an earlier request of this browser's own, the takeover sentence names that cause too;
  - asking again there signs the person in.
- **The takeover sentence's three causes,** each shown against the real GoTrue: a different browser
  (Max, new), a different web address (Lee), a newer request (Ivy).
- **Two sentence fixes in the app:**
  - the takeover sentence names the web address;
  - the no-request sentence names cleared browser data as well ("Delete everything in this browser"
    causes it). Both used to blame another browser for what was really another address of the app.
- **A held request now counts for 25 h, not 24:** a day-long link can finish a request whose verifier
  was reused an hour after it was made.

Two reviews shaped it:
- **The first (8 agents, 21 findings, 20 confirmed).** The runner's reason for the unproven landings
  ("never reached once the first sign-in fails") was false: the first sign-in still succeeds under the
  allow-list mutation, so all nine landings went red, and now all nine are required. The same-origin
  rule was credited to a check that cannot see it, and the global sign-out was said to stop the other
  device "unsaid" (it is told its sign-in expired, up to an hour later).
- **A re-review of those fixes (14 findings),** its verifiers lost to a restart, so each was checked by
  hand. K2 could not tell its branch from the takeover sentence. A "platform fact" (the tablet
  finishing Jo's link) turns red every time the dropped-verifier mutation runs. And "the live run shows
  all three causes" was true only once Max's check was added. All were fixed.

**2026-10-18: the LOCAL live run, then two reviews of it.** The owner's Supabase project still does not exist, and fakes are what hid this
lane's worst bugs (lesson 52). So `node scripts/account-live/run.mjs` runs the real thing locally:
- **The servers:** real GoTrue v2.197.0, PostgREST 16.4 and Postgres 17.11, as user-level Linux
  binaries in WSL (no Docker, no sudo: neither is on this laptop). They are fetched once into
  `~/.cache/nutriflow-live` inside WSL, outside the repo, each checked against a pinned SHA-256.
- **What stands in for Supabase:** a gateway, a mail catcher, and `db.mjs`'s copy of the platform's
  roles and grants. GoTrue is set up as the README's steps 3 and 4 say.
- **The client:** the real `client.ts`, driven by seven browsers (one of them at two web addresses)
  through sign-in, sync, RLS, renewal, sign-out and deletion. The full list is in `supabase/README.md`.

The first version (`c2bd5a0`, 20/20) was then reviewed by ten agents: five lenses, each verified. They
confirmed 35 findings:
- **Checks that could not fail.** The RLS write check forged a row Sam already had, so the primary
  key refused it whatever the policy said. The renewals never sent a token that had really expired.
  Nobody looked where a link landed, and the Site URL was the dev page itself.
- **A wrong platform fact in my docs:** GoTrue's "~10 s reuse window". GoTrue in fact accepts the
  replaced refresh token with no time limit while it is the current one's parent.
- **Tooling:**
  - no lock between runs;
  - PIDs signalled blind;
  - a passwordless Postgres reachable from Windows' localhost;
  - a gateway on 0.0.0.0;
  - downloads not checked;
  - `--keep` that could not keep.
- **A setup instruction from 2026-10-03 that cannot work:** phone testing by LAN address.

All 35 are fixed (`766e243`). The live run is 38 checks now. Its mutation runner's first run caught 7
of 9: one check crashed instead of failing (fixed), and one mutation survived. That survivor was a
platform fact nobody here knew:
- **GoTrue issues a link's code for the person's MOST RECENT request, from whichever browser.** The
  chain is verify.go -> pkce.go issueAuthCode -> models/flow_state.go `FindFlowStateByUserID(...).Last()`,
  ordered by created_at. With "Confirm email" off, as the setup sets it, that includes a request it
  refused as too soon: magic_link.go writes the flow state before the rate limit.
- **What follows for a person:** a second device asking moves the sign-in there, and the first
  browser's link then fails.
- **What follows for the code:** the app's verifier reuse only matters for a request GoTrue never
  received, so that is what the checks now test (a dropped connection, through a gateway hook).

**A second review, of that batch (6 agents), confirmed 16 more.** All are fixed (`4663a81`, 2026-10-20):
- **"Every live check is proven by mutation" was itself an overclaim.** It became 17 of the 38 then (35 of 50 now): seven
  more mutations, the select policy among them, and the other 21 are accounted for.
- **The new sentence was wrong for the other cause.** GoTrue's `bad_code_verifier` also comes back
  when a link asked for in another browser is opened where a different sign-in is pending, so the
  sentence now names both causes.
- **Two clock dependences were left in the takeover checks.** GoTrue orders requests by WSL's clock, so
  the run now reads `auth.flow_state` to confirm GoTrue's latest before relying on it.
- **Smaller fixes:** a socket lock that could block Postgres after a crash; `setup.sh` outside the
  stack's lock; a lockfile hash that CRLF broke; and the fake binding a code at exchange time, where
  GoTrue binds it when the link is opened.

The fake models GoTrue's rule: one link per person, a code bound to the latest request when first
presented, and an optional 60 s refusal. Detail: `docs/worklog/2026-10-18-accounts.md`.

Also today: `account/validate.ts` imports from `../core/client` (`dd5b33e`); the theme key moved to its
own module, which took 3.16 kB gz off "/" (`2d9e024`); and two script imports moved off a D5a shim
for v1's shim removal.

**Next:**
- a shape check in `checkProfileExtras` for v1's `removedAllergies` profile field (after v1's F6), once
  v1 confirms its shape;
- whatever the owner's decisions doc answers for #1 (the Supabase project) and #4 (the chat log). Until
  then, the three things only a hosted project can show stay listed in `supabase/README.md`.

**Built and shipped (`4fa187f`, see above), kept as the plan it started from: "Try again" after a lost response.** "Try again" appears
after a transient failure of the link's exchange (offline, 429, 5xx), with the code kept
(`exchangeWith`, `retrySignIn`). Two cases differ on the real GoTrue:
- **The request was lost** (GoTrue never saw it). The code is unused, so the retry finishes. The fake
  covers this already.
- **The response was lost** (GoTrue finished the exchange, then the connection dropped: a plausible case
  on a phone). GoTrue destroyed the flow state on success (token.go), so the retry gets 404
  `flow_state_not_found`. The app then shows its generic sentence: "expired, was already used, or was
  opened in a different browser". That is not what happened, and nothing in it says the first try went
  through.

The plan:
- a gateway hook that forwards the next request to a path and drops its response;
- two live checks: after a lost request the retry signs in; after a lost response the retry is refused
  with a sentence of its own ("the first try reached the server, so this link is used up: ask for a new
  link"), and a new link then works;
- the sentence in `exchangeCode`, used only for a retry's 404;
- a mutation each.
It touches `src/lib/account`, so its ship needs the engine slot.

**2026-10-03: review 2 is fully fixed, and so is the review of that work (batch 6, `ea71ca6`).**
Everything ran against fakes that behave like GoTrue and PostgREST, and against real Postgres (PGlite).
The history of that day is in `docs/worklog/2026-10-03-accounts.md`.

- **Shipped that day:** the first review's fixes (`8190c2b`), the SQL executed (`a42a97e`), byte-counted
  store sizes (`5c6c80c`), clock skew (`b4492e3`), and review 2's batches 1–5 (`d219a1f`, `e4b927f`,
  `c9208df`, `e186710`). Batch 4 is THE WRITE FENCE (see the heads-up below; it changes what a save from
  a stale tab does). Batch 5: an account deleted on another device is reported as deleted, and the
  "expired link" sentence says only the newest link works (GoTrue keeps one per person).
- **Batch 6 (`ea71ca6`), the review of batches 4–5:** who is signed in is re-checked after every wait in
  sign-out and "Delete everything" (another tab's sign-in made during the wait was ended or wiped); the
  account's sentences show on every `/sage` screen (a notice from `<AccountSync/>`, see the heads-up);
  the carried note is tagged with its account; and the tests the review showed could not fail now can.
- **Then:** the local live run (above); the owner's project, whenever it exists, repeats it for real.

## Files I'm editing right now

*(the other lanes: if you need one of these, message me first)*

- `src/lib/persistence/**` (`storage.ts`), `src/lib/account/**` (now including `savedStore.ts`),
  `src/app/sage/account/**`, `scripts/test-account.*`, `scripts/test-account-tabs.mts`,
  `scripts/account-tab.mts`, `scripts/account-fakes.ts`, `scripts/test-account-sql.mjs`,
  `scripts/mutate-account.mjs`, `scripts/account-live/**`, `supabase/**`: all mine, nothing of yours.
  The old paths `src/lib/storage.ts` and `src/lib/savedStore.ts` were deleted with the other D5a shims
  (v1, `5b6d874`, 2026-10-21); check:boundaries fails a re-export put back at one. None of this lane's
  files used them.
- **D5a's move landed as `2b7075d` (v1), and the hold for it is released.** Checked here: in this
  lane's files only import lines and the 21 path strings changed. The suites pass 333 + 43 on the
  moved tree, and v1 ran all 85 mutations, 85/85.

## Heads-up for the other lanes

- **This lane ships shared docs in a commit of their own (2026-10-20, WORKPLAN lesson 69).** The code
  goes gated. Straight after it, `CONTEXT.md`, `CLAUDE.md`, `WORKPLAN.md`, `VISION.md` and the worklog
  index go with `--no-gate`, which `ship` allows because no gate reads a doc. A gated commit holding
  one of those was stopped here by two other lanes' doc commits during its 24-minute gate, green and
  delivering nothing. The same split would spare any lane that.
- **`scripts/account-live/` is mine (2026-10-18).** `live.mts` is type-checked by `tsconfig.scripts.json`
  like every script. Nothing in it is a gate: run it by hand, about 80 s once cached. It needs WSL 2
  with an x86-64 Ubuntu (`LIVE_WSL_DISTRO` names another distro).
  - **One run at a time, across all lanes:** setup and the stack both take the stack's lock. A second
    run waits 15 s, then exits saying another run is using it, before it touches anything.
  - **`mutate-live.mjs` edits files in place while it runs** (migrations 0001 and 0002, `stack.sh`,
    `supabase.ts`, `client.ts`), like `mutate-account.mjs`. Do not run a gate in this worktree at the
    same time.
  - **This lane's bundles and mutation journals live in the worktree's own `.cache/`** (since
    2026-10-20, after v1's `6509cdb` did the same for `package.json`), never in `node_modules/.cache`,
    which worktrees can share through a junction. A journal left at the old place is still restored.
  - **This laptop's WSL clock steps backwards** (dmesg: "Time jumped backwards", offsets from Windows
    moving by seconds). Anything that compares WSL timestamps across seconds can flake. The live run
    orders by sequence numbers, and checks GoTrue's own ordering where it depends on that clock.
  - **The fake now follows GoTrue's link rules (`account-fakes.ts`):**
    - an accepted request retires the address's earlier link;
    - a link's code is checked against the person's LATEST request's challenge, refused requests
      included;
    - `linkIntervalMs` can refuse a second request within 60 s.

    So a test that asks twice and opens the first link fails, and so does one where another browser
    asked since. Both outcomes are the truth on the real platform.
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
- **The theme key lives in `persistence/theme.ts` (2026-10-18), re-exported by `storage.ts`.**
  `@/lib/persistence` still offers `THEME_STORAGE_KEY` (still `"nutriflow-theme"`, so nobody loses their
  choice), `loadTheme()` and `saveTheme()`, and no import changed.
  - **Why it is its own module:** a page that needs only the theme no longer loads `storage.ts`.
  - **Rule:** import nothing into `theme.ts`; every page pays for whatever it imports.
  - Rule 3 lets exactly these two files name a key and fails if both name the same one (v1, `2c48ac3`).
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

- **v1, D5a's `persistence/` move: done as `2b7075d` (2026-10-18).** It was agreed as one commit
  (option A), with two conditions found by reading the code before anything moved. Either one alone
  would have turned a gate red:
  1. `savedStore.ts` value-imports `account/client`. In the persistence barrel it would have closed a
     rule-5 import cycle (`account/client → persistence → savedStore → account/client`), so it lives in
     `account/` instead.
  2. `mutate-account.mjs` anchors on file paths (17 + 4 entries), so those strings moved in the same
     commit. The quick `--only "WRITE FENCE|savedStore"` check suggested first selected 1 of the 21:
     mutations are named for the behaviour they break, not for their file. **A name filter is no proof
     that a moved path resolves.** v1 ran the full 85/85 instead.

  Also kept from the original agreement: one `export *` re-export per old path, so `storage.ts`'s
  module state (the fence's `knownEpoch`, the change listeners) stays one instance per tab. And
  `storage.ts` still has no import-time side effects, so it needs no `sideEffects` entry.
- **v1, the old-path debts (2026-10-18): all paid.** `validate.ts`'s in `dd5b33e`, the two `storage.ts`
  entries by the move. The schedule's stale accounts rows were fixed in `f580918`.
- **ThemeSwitch's debt: paid (v1, `3ff9732`), then made cheap.** The root layout then loaded all of
  `storage.ts` for three names, on "/", "/_not-found" and "/recipes". The split (`2d9e024`) took
  3.16 kB gz off each. v1's first figure, +3.4 kB, came from a control built in a worktree with a
  junctioned `node_modules`, and v1 has withdrawn it (`7c2d360`).
  This lane offered to move those names to `persistence/theme.ts`; v1 agreed and widened rule 3 to two
  owner files (`2c48ac3`). v1 re-measures after the split ships.

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

**Status (2026-10-18):** A1–A3 done. A4 code-complete and tested end to end against an in-memory
Supabase (now 333 + 43 checks), hardened by three adversarial reviews, and **run live against the real
GoTrue, PostgREST and Postgres locally (20/20, `scripts/account-live/`)**. What remains for A4 is the
owner's hosted project: its gateway and keys, real email, and the RLS plan run once there. A5 done — the v1 lane
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
| `dd5b33e` | `account/validate.ts` imports `DAYS`/`MEAL_TYPES` from `../core/client` (v1's old-path debt), plus this lane file brought current — 333 + 43 |
| `c2bd5a0` | the local live run: `scripts/account-live/` (real GoTrue v2.197.0, PostgREST 16.4, Postgres 17.11 in WSL; a gateway and mail catcher), 20/20; `supabase/README.md` says what it covers and what only a hosted project can show |
| `555a97b` | D5a's move (`2b7075d`) checked in this lane's files; the docs that named the old paths name the new ones |
| `2d9e024` | `persistence/theme.ts`: the theme key in its own module, so "/", "/_not-found" and "/recipes" stop loading `storage.ts` (−3.16 kB gz each, both builds in one folder) — engine 943/0 |
| `766e243` | the live run's review, all 35 findings: checks that can fail (RLS insert, unfiltered update and delete; renewal of really expired tokens before a push and after a 401; where every link lands; the newest-link rule; a re-signup's id; the audit table), with `mutate-live.mjs`; the stack hardened (lock, PID identity, socket-only Postgres, gateway on 127.0.0.1, SHA-256 pins, a locked `pg` client, `--keep`/`--down`); the README's phone advice fixed; the fake keeps one link per person. The first `mutate-live` run surfaced GoTrue's latest-request rule (a link's code goes to the person's most recent request, even a refused one): a takeover sentence, the fake modelling it, and the verifier tested through a lost request — 38/38 live, 10/10, 335 + 43, 87/87, lessons 66–67 |
| `4663a81` | the second review of the live run (16 findings): 17 of the 38 checks proven able to fail (seven more mutations, the select policy among them), and the docs saying so instead of "every check"; the `bad_code_verifier` sentence names both causes (asked for elsewhere, or taken over), with a test for the first; GoTrue's ordering confirmed from `auth.flow_state` before the takeover checks; the stale socket lock cleared; `setup.sh` under the stack's lock; a CR-blind lockfile hash; the fake binds a code when it is first presented; the takeover rule qualified ("Confirm email" off); the Referer fallback documented; bundles and journals in the worktree's own `.cache/`. Shipped apart from its docs, which follow in the next commit (lesson 69) — 38/38 live, 17/17, 336 + 43, 87/87, engine 1010/0, test:ui 51/0 |
| `bbf0f17` | the docs half of `4663a81`, shipped apart from it with `--no-gate`: "17 of 38" everywhere, lesson 67's wording, lesson 69 (shared docs in a commit of their own), the 2026-10-20 day file |
| `c284616` | the Site URL batch: sign-out on one of two devices (`scope=local`), the Site URL fallback run for real (a refused preview's link lands on the Site URL's page; holding nothing, it names a different web address; holding a request of its own, the takeover sentence does), the takeover sentence's three causes each shown live (Max, Lee, Ivy), the no-request sentence naming cleared data, a held request counting for 25 h, all nine landings required under the allow-list mutation, the same-origin rule recorded through a `passes` requirement, the tablet finishing Jo's link required under the dropped-verifier mutation — 45/45 live, 22/22, 339 + 43, 91/91, engine 1061/0 |
| `2410119` | the docs half of `c284616` (`--no-gate`): 45/45 and 31 of 45 everywhere, lesson 67 twice more, the 2026-10-21 day file, and the shims removal reflected |
| `a915d12` | "Confirm email" on, run live: a second GoTrue with it on behind the gateway's `/confirm` prefix and four browsers pointed at it; a first link's five minutes from the request (the request aged in `auth.flow_state`), the magic link after it from its opening, and a not-yet-confirmed person's refused second request rolling back its own flow state; two mutations ("Confirm email" off on that server, the app's 422 mapping), and the allow list's tenth landing — 50/50 live, 24/24, 35 of 50 |
| `2bd92e8` | the review of `a915d12` (one agent, 6 findings, none breaking a check): the rollback described as GoTrue does it (confirmed versus not; the sign-up path refuses inside its transaction), in the README's takeover qualifier, the fake's comment and the app's; a four-minute first link that still works, bracketing the limit; the slow link's code and logged 422 asserted; GoTrue's 60 s message pinned; the magic-link path line GoTrue never reads, dropped; "Try again" and the hourly cap back under "Not exercised"; step 4 on the hourly cap — 50/50 live, 24/24 |
| `3f64959` | VISION: accounts are built and checked against the real servers, not "nothing is built"; the old path and the anon key's name gone |
| `4fa187f` | "Try again", run live and fixed. Told rightly: a lost answer (404), a late retry (422), an answer cut off after its headers (final). Finishing where it can: across tabs (the kept sign-in carries its verifier and address) and in any letter case. "Finish the earlier sign-in" after a failed request. A kept sign-in ended by "Delete everything" in every tab (the data generation) and by a sign-in elsewhere. The gateway's drop-response and drop-body one-shots. Five reviews — 55/55 live, 31/31, 39 of 55, 354 + 48, 114/114 |
