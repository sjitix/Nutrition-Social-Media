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
   every other address the app is opened at: `http://localhost:3000/**` for development, plus any you
   use for testing on a phone (the LAN address `next dev` prints, e.g. `http://192.168.1.20:3000/**`),
   another dev port, or Vercel preview URLs (`https://*-<your-team>.vercel.app/**`).
   Why both matter: a link whose return address is NOT on the list silently goes to the Site URL
   instead. If that were the bare domain, the root page's redirect to `/sage` would drop the sign-in
   code, and the sign-in would do nothing at all, with no message. Landing on the account page, it
   either completes or says why it didn't.
   **Authentication → Sign In / Providers → Email:** turn **off "Confirm email"**. This app signs in
   only by email link, and opening the link already proves the address. With it on (the default), a
   new person's FIRST link expires five minutes after it was *requested*, not after it was opened, so
   anyone slower than that to find the email is told the link expired (the app says to ask for a new
   one, which then works). If you leave it on, expect that.
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
another device or in another browser is refused with a sentence saying exactly that.

## What the schema is

One table, `user_state`: a row per (user, store), holding that store's JSON exactly as
`src/lib/storage.ts` wrote it, plus the time the writing device wrote it. Sync rules live in
`src/lib/account/merge.ts`.

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
`--mutate` removes fifteen guards one at a time (each policy, each revoke, the cascade, the size limit,
the forward-only rule) and fails if any removal goes unnoticed. PGlite installs itself once into the OS
temp folder; `package.json` does not change.

Not covered locally, and left to the live run: whether the `postgres` role may delete from
`auth.users` on a hosted project (the stub's is a superuser), PostgREST's routing, and sign-in itself.

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
