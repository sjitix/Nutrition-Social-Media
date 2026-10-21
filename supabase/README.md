# Supabase — the account backend

**Owned by the accounts lane** (`docs/parallel/lane-accounts.md`). Nothing here runs until the owner
creates a Supabase project; with no keys configured the app behaves exactly as it always has.

## Setting it up (one time, about twenty minutes)

1. Create a project at supabase.com (the free tier is plenty).
2. **SQL editor → run every file in `migrations/`, in order: `0001_user_state.sql`, then
   `0002_conditional_upsert.sql`.** Each is idempotent; running one twice is harmless. The app writes
   through the function 0002 creates, so sync does not work with 0001 alone.
3. **Authentication → URL configuration:** set the **Site URL to the account page,
   `https://ntrux.vercel.app/sage/account`**, not the bare domain. Then add to the redirect allow-list
   every other address the app is opened at: `http://localhost:3000/**` for development, plus another
   dev port, or Vercel preview URLs (`https://*-<your-team>.vercel.app/**`).
   **Not the LAN address `next dev` prints** (e.g. `http://192.168.1.20:3000`), so testing on a phone
   that way cannot work. GoTrue refuses to send a link back to any IP address but loopback, whatever
   this list says. And over plain http that page is not a secure context, so the browser cannot even
   make the sign-in's PKCE challenge. Two ways that do work:
   - an https tunnel with a fixed hostname, with exactly `https://<that host>/**` allow-listed;
   - on Android, Chrome's port forwarding (`chrome://inspect` → Port forwarding, 3000 → localhost:3000).
     The phone then opens `http://localhost:3000`, which is allowed and secure.
   Why both matter: a link whose return address is NOT on the list silently goes elsewhere. It goes to
   the asking page's origin (the browser's Referer) if the list admits that, and otherwise to the Site
   URL. Landing on a bare domain, the root page's redirect to `/sage` would drop the sign-in code, and
   the sign-in would do nothing at all, with no message. So use `/**` entries: a one-star entry such as
   `http://localhost:3000/*` admits the origin but not the account page. Landing on an account page,
   it either completes, or says why it cannot. The Site URL is another web address than the one that
   asked, and a browser keeps a sign-in request per address. So the page says the link was asked for
   at a different web address: in the sentence for a page that holds no request, or in the takeover
   sentence, when this browser asked there earlier and never finished. Asking again on that page works.
   **Authentication → Sign In / Providers → Email:** turn **off "Confirm email"**. This app signs in
   only by email link, and opening the link already proves the address. With it on (the default), a
   new person's FIRST link expires five minutes after it was *requested*, not after it was opened, so
   anyone slower than that to find the email is told the link expired (the app says to ask for a new
   one, which then works). If you leave it on, expect that. The live run shows both against the real
   GoTrue, on a second server with "Confirm email" on.
   **Keep CAPTCHA protection off** (Authentication → Attack Protection). This app sends no captcha
   token, so with it on every sign-in fails.
   **Authentication → Configuration → Audit Logs:** turn **off "Write audit logs to the database"**.
   Every sign-in, and every automatic renewal of it (about once an hour while the app is open), writes
   an audit entry holding the person's email and IP address. In the database (`auth.audit_log_entries`)
   nothing ever removes those entries, not even deleting the account. With the switch off they are
   kept only in Supabase's log storage, for the plan's log retention: 1 day on Free, 7 on Pro, 28 on
   Team, 90 on Enterprise. That is what the app's privacy note promises ("for as long as the provider's
   log settings keep them"), so leaving the switch on makes the note untrue.
   Sources: <https://supabase.com/docs/guides/auth/audit-logs> ·
   <https://supabase.com/docs/guides/telemetry/logs>
4. **Authentication → Emails → SMTP settings: switch on a custom SMTP provider. Without this step
   nobody but you can sign in.** Supabase's built-in mailer is for trying things out only: it sends
   **only to members of your Supabase organisation** (everyone else gets `email_address_not_authorized`)
   and only a couple of emails an hour. Any transactional email service works (Resend, Postmark,
   Amazon SES, Brevo…): create an account, verify a sender domain or address, and paste its SMTP host,
   port, user and password here. Then **Authentication → Rate limits → "emails sent per hour"**: raise
   it to something a real launch needs (it starts low).
   Sources: <https://supabase.com/docs/guides/auth/auth-smtp> ·
   <https://supabase.com/docs/guides/auth/debugging/error-codes>
5. **Project Settings → API Keys** (or the **Connect** button at the top of the dashboard): copy the
   **Project URL** and the **publishable key** (`sb_publishable_…`) into `.env.local`, and into the
   Vercel project's environment variables:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
   ```

   That is the name Supabase's own Next.js snippet uses, so pasting the Connect dialog's block works.
   The older name, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, with the legacy anon key, also works, but Supabase
   is deactivating the legacy keys, so use the publishable one. Either is safe in a browser: Row Level
   Security (below) is what protects the data. **The `service_role` and secret keys are never needed
   by this app and must never be committed** — the repo is public.

## How sign-in works, and the one thing to tell people

Sign-in is an email magic link using **PKCE**: when someone asks for a link, their browser keeps a
secret, and the link only completes in the browser that holds it. That is what stops a link made by
someone else — or session tokens pasted into the address — from signing a browser into a stranger's
account and uploading its data there. The cost is one rule people need to know, which the app says at
the moment they ask: **open the link in the same browser you asked for it in.** A link opened on
another device or in another browser is refused, with a sentence saying it was asked for elsewhere.
So is one that comes back to another of the app's web addresses: a return address the allow list
refuses is sent to the Site URL (step 3), and a browser keeps the secret per address. The page cannot
tell these apart, so each refusal names every cause it can have:
- where the page holds no request: a different browser, a different web address, or this browser's
  data cleared since ("Delete everything in this browser" does that);
- where it holds a request of its own that the link does not match (the takeover sentence): a
  different browser, a different web address, or a newer request that took the link over (below).

**And ask from one browser at a time.** GoTrue issues a link's code for the person's MOST RECENT
request, whichever browser made it. For anyone already signed up, and for everyone while "Confirm email"
is off (as step 3 sets it), it records a request even when it refuses to email it as too soon: the flow
state is written before the rate limit. (With "Confirm email" on, a new person's refused request is
rolled back with its email. A request stopped earlier, by the per-IP limit or CAPTCHA, never reaches
GoTrue's handler at all.) So once a second device has asked, even unsuccessfully, the link completes
only on that device. Opened in the first browser, it is refused with the takeover sentence. The live
run shows both sides against the real GoTrue.

## What the schema is

One table, `user_state`: a row per (user, store), holding that store's JSON exactly as
`src/lib/persistence/storage.ts` wrote it, plus the time the writing device wrote it. Sync rules live
in `src/lib/account/merge.ts`.

Two functions:

- **`upsert_state(rows)`** (0002) — every write goes through it. A store is written only if the incoming
  write is NEWER than the account's copy; the stores it skipped are returned, and the client pulls before
  trying them again. Without it a device that was offline for days could overwrite a newer week from
  another device. It runs as the calling user (`security invoker`), so every RLS policy still applies, and
  it takes the user id from the verified token, never from the request.
- **`delete_my_account()`** (0001) — a signed-in user deletes themselves; every row of theirs goes with
  them by cascade. The sign-in audit log is not part of the account and is not deleted with it: with
  step 3's "Write audit logs to the database" off, it ages out of Supabase's log storage at the plan's
  retention; left on, its copy in the database stays until someone deletes it by hand.
  Another device still signed in to the deleted account finds out at its next write: its token is
  valid until it expires (a JWT is stateless), so reads come back empty and the write breaks
  `user_state`'s foreign key (Postgres 23503, a 409 from the REST API), which the app reads as "this
  account was deleted". It stops syncing and says so. Row 11 below checks it on the live project.

**Grants.** A new Supabase project grants every privilege on a new `public` table to both API roles.
0001 takes all of it back: signed-in users then hold exactly `select`, `insert`, `update` and `delete`,
the four verbs the policies govern, and anonymous visitors hold nothing. `truncate` especially must
never stay granted: RLS does not apply to it, so one signed-in user could empty every account. The REST
API has no `truncate`, so this was never reachable from a browser, but it is closed in the schema
anyway, and the check below makes sure of it.

## Before there is a project: run the SQL locally

```bash
node scripts/test-account-sql.mjs            # both migrations + the plan below, in real Postgres
node scripts/test-account-sql.mjs --mutate   # ...then breaks each guard in turn: a check must fail
```

This needs no project and no keys. It runs both migrations, each twice to prove they are idempotent, in
**PGlite**, the actual Postgres engine compiled to WebAssembly. It then runs every row of the plan
below plus exact grant checks. Supabase's own pieces are stubbed the way Supabase defines them,
**including its default grants**. Without those, "anon gets nothing" would pass whether or not the
migration revoked anything, which is how the `truncate` gap above stayed hidden until the stub had them.
`--mutate` removes sixteen guards one at a time (each policy, each revoke, the cascade and the foreign
key, the size limit, the forward-only rule) and fails if any removal goes unnoticed. PGlite installs
itself once into the OS temp folder; `package.json` does not change.

### And the whole sign-in and sync, against the real servers

```bash
node scripts/account-live/run.mjs               # from the repo root, about 80 s once the binaries are cached
node scripts/account-live/run.mjs --keep        # ...and the stack stays up until Ctrl+C
node scripts/account-live/run.mjs --down        # stops a stack a crash left behind
node scripts/account-live/mutate-live.mjs       # breaks 24 guards in turn: each named check must fail (~32 min)
```

This runs the app's own `client.ts` and `storage.ts` against **the real GoTrue (Supabase's auth
server), PostgREST and Postgres**, the same programs a project runs, started as user-level binaries in
WSL.

**What it needs:** no Docker and no admin rights, once WSL 2 is installed with an x86-64 distro named
`Ubuntu` (`LIVE_WSL_DISTRO` names another). The distro needs `curl`, `xz`, `python3`, `openssl` and
`flock`; Ubuntu has them all.

**What it fetches:** the first run fetches the binaries into `~/.cache/nutriflow-live` inside WSL. Each
is checked against a pinned SHA-256, the publisher's own, and nothing lands in the repo.

**What stands in for Supabase:**
- a small gateway, in place of Supabase's own;
- a mail catcher that receives the sign-in emails;
- `db.mjs`, which sets up the roles and grants a project starts with.

Every port is on 127.0.0.1, and Postgres listens only on a Unix socket only you can open. One run at
a time: a second one waits briefly, then says another run is using the stack.

**GoTrue is set up as steps 3 and 4 of this guide say:**
- the production account page as the Site URL, with `http://localhost:3000/**` on the allow list;
- "Confirm email" off, and audit logs kept out of the database;
- a custom mail server (the catcher);
- a hosted project's 10-second refresh-token reuse interval.

And a second GoTrue on the same database, with "Confirm email" ON (a hosted project's default), for
four of the run's browsers: the gateway sends `/confirm/auth/v1/*` to it, and those browsers are
given `http://localhost:54321/confirm` as the project URL.

**What the run checks**, each against the real servers' own answer (50 checks):
- **Links:**
  - a PKCE link signs a device in, and every link asked for at an allow-listed address lands back on
    that address (ten landings);
  - a link asked for at an address the allow list refuses (a preview deployment) lands on the Site URL
    instead. (A browser's Referer would be tried first; the run sends none.) That page is another
    origin, so the request is not held there: the sign-in cannot finish, and the sentence names a
    different web address as well as a different browser;
  - where that page does hold an earlier request of this browser's own, GoTrue refuses its verifier
    (`bad_code_verifier`, the link's code belonging to the newer request), and the takeover sentence
    names a different web address too;
  - asking again on that page brings the link back to it, and signs the person in. Two of GoTrue's
    rules would each do that here: it admits the Site URL's own origin (same scheme, host and port; any
    path) without the allow list, and it falls back to the Site URL, which is that same address. With
    the Site URL a bare domain, only the first could, and the mutation runner requires it there;
  - a second request within a minute is refused (429), and a third whose connection drops before GoTrue
    sees it is lost. Neither loses the link already sent;
  - once another browser asks, even refused, the link fails where it was asked for, with the sentence
    naming a newer request, and completes in the browser that asked last;
  - a fresh link asked for in one browser, opened in another that holds a request of its own, is
    refused (`bad_code_verifier`), with the sentence naming a different browser;
  - an unused link that a newer one replaced is refused, and so is a used one, each with the sentence
    that says only the newest link works.
- **"Confirm email" on** (the second GoTrue):
  - a new person's first link is a confirmation link, and opened at once it signs them in;
  - opened more than five minutes after it was asked for, it is refused (422, `flow_state_expired`), with
    the sentence for a slow first link. The run moves the request six minutes back in `auth.flow_state`
    rather than wait: GoTrue counts a first link's five minutes from the request, and takes no less
    than 300 s;
  - asking again, as that sentence says, sends a magic link (opening the slow link had confirmed the
    person), and a magic link's five minutes run from its opening: moved six minutes back, it works;
  - a new person's second request, refused as too soon, is rolled back with the sign-up, so it takes
    nothing over: the first link finishes where it was asked for.
- **Sync:** a second device pulls the week, an edit reaches the other device, and `upsert_state` skips
  a write older than the account's copy.
- **Renewal:**
  - a token that has really expired is renewed before the push, so the push never carries it;
  - a token the device judged fresh but PostgREST refuses (401) is renewed once, and the push is
    retried with the new one;
  - each renewal is exactly one rotation, and the refresh token a renewal just replaced is answered
    with the current one.
- **RLS:** another person cannot read Sam's rows or insert one in her name (the insert policy itself
  refuses it: 403, 42501). An update or delete with no filter reaches only his own rows.
- **Sign-out:** the session really ends: its refresh token is refused with `refresh_token_not_found`.
  And only that browser's: someone signed in on two devices who signs out on one stays signed in on
  the other (`scope=local`). GoTrue's default, global, would end both: the other device would keep
  syncing until its access token ran out (up to an hour), then stop, told only that its sign-in had
  expired.
- **Delete:**
  - the account and every row of it are gone;
  - another device still holding a valid token hears "deleted" (a 409 with 23503), and `/logout`
    answers that token 403 `user_not_found`;
  - signing up again with the same address gives a new id.
- **Privacy:** `auth.audit_log_entries` is still empty at the end.

**`mutate-live.mjs` shows 35 of the 50 checks able to fail.** It breaks 24 guards, one at a time, and
each must turn its own named checks red:
- all four RLS policies, and `upsert_state`'s forward-only rule;
- the allow list (all ten landings must fail: the run hands each code to the device it names,
  wherever the link landed, so it carries on past the first), the Site URL being the account page,
  GoTrue's per-person email limit, the audit-log setting, and "Confirm email" on the second GoTrue;
- both renewal paths;
- the verifier's handling across a refused and a lost request (the phone's link, and the tablet
  finishing Jo's), and the address bar being cleared;
- the takeover sentence, and its naming a different browser and a different web address; the
  newest-link sentence; the sentence for a link that lands where no request is held; and the
  expired first link (422) told apart from a passing failure;
- sign-out reaching GoTrue, sign-out ending only its own session, and a deleted account being read as
  deleted.

The other 15 checks are not shown to fail on their own. They are:
- five platform facts the run records rather than app guards: GoTrue's parent rule, the newest link
  signing in, `/logout`'s 403, a re-signup's new id, and a magic link still working six minutes after
  its request;
- ten preconditions and follow-ons of the proven checks: the first sign-in and sync, the phone's pull,
  the mirror, the newer week kept, both edits after a renewal, the plain sign-out, the delete, and the
  link that comes back when asked for again on the Site URL's page. That one is also required to PASS
  under the bare-domain Site URL, which is how the run records GoTrue's same-origin rule.

The reviews of the Site URL batch corrected two counts here. The landings were said to be never
reached once the first sign-in failed; the first sign-in does not fail under the allow-list mutation,
so the other eight had gone red unrequired, and now all of them are required (ten since the
"Confirm email" checks). And the tablet finishing
Jo's link was listed as a platform fact, though dropping the verifier on a refused request turns it
red every time; that mutation now requires it.

The first run of the mutations caught 7 of 9. One check crashed instead of failing (now fixed). One
mutation survived, because GoTrue's latest-request rule (above) makes a refused request harmless to
it. Only a request GoTrue never receives shows whether the verifier is kept.

**Clocks.** WSL's clock steps backwards at times, so the run orders its own observations (emails,
requests) by sequence number, never by time. Two things still rest on clocks, and both are handled:
- GoTrue picks a person's latest request by `created_at` on that clock. So before a takeover check
  relies on it, the run reads GoTrue's own `auth.flow_state` to confirm which request is latest, and
  asks again if a clock step put it behind.
- A request GoTrue still counts as under a minute old after the wait is retried, and the run says so.
  The minted expired token assumes only that Windows' and WSL's clocks agree within ten minutes.

**A platform fact it pins down:** GoTrue accepts the refresh token a renewal has just replaced, at any
age, for as long as that token is the parent of the session's current one. It answers with that
current token instead of a new one, which is why two tabs renewing at once both succeed. Older spent
tokens fall under the reuse interval: 10 s on a hosted project; GoTrue's own default is 0. The suites'
fake refuses the replaced token outright, which only makes those tests stricter.

**Left to the hosted project:** whether the `postgres` role may delete from `auth.users` there (locally
it is a superuser), Supabase's own gateway and its publishable keys, and real email delivery.

## The RLS test plan — run it once after applying the migrations

RLS is the only thing between one user and another's data, so it is verified, not assumed. In the SQL
editor, impersonate two users (or sign in as two accounts in two browsers) and check:

| # | As | Do | Expect |
|---|---|---|---|
| 1 | anon (signed out) | `select * from user_state` | permission denied |
| 2 | user A | insert a row with `user_id` = A | ok |
| 3 | user A | insert a row with `user_id` = **B** | **rejected** (`with check`) |
| 4 | user B | `select * from user_state` | only B's rows — none of A's |
| 5 | user B | `update user_state set value = '1'` (**no `where`**), then `rollback` | 1 row changed (B's own); A's untouched |
| 5b | user B | `delete from user_state` (**no `where`**), then `rollback` | 1 row deleted (B's own); A's untouched |
| 5c | user B | `truncate user_state` | permission denied |
| 6 | user A | insert `key = 'somethingElse'` | **rejected** (check constraint) |
| 7 | user A | `select upsert_state('[{"key":"saved","value":["x"],"updated_at":"2030-01-01T00:00:00Z"}]')` | `{}` (written) — and the row belongs to A |
| 8 | user A | the same call again with `"updated_at":"2020-01-01T00:00:00Z"` | `{saved}` (skipped: older than the stored row) |
| 9 | anon | `select upsert_state('[]')` | permission denied |
| 10 | user A | `select delete_my_account()` | A's auth user and every A row gone; B untouched |
| 11 | user A again (the same claims, after row 10) | `select upsert_state('[{"key":"plan","value":{},"updated_at":"2050-01-01T00:00:00Z"}]')` | **error 23503** (foreign key): what tells another device its account was deleted |

Impersonation in the SQL editor:

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<user A uuid>", "role": "authenticated"}';
select * from public.user_state;   -- then run each row of the table above
```

**Rows 5 and 5b have no `where` on purpose.** A statement that reads a column (`where user_id = …`)
also gets the SELECT policy applied, and that policy alone hides A's row. So with a `where`, "0 rows
changed" holds even with the UPDATE or DELETE policy deleted, and the check proves nothing. With no
`where`, only the policy under test stands between B and A's row. The local check confirmed both
behaviours: the `where` form passed with each policy removed, and the bare form failed.
