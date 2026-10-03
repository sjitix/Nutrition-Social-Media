# Supabase — the account backend

**Owned by the accounts lane** (`docs/parallel/lane-accounts.md`). Nothing here runs until the owner
creates a Supabase project; with no keys configured the app behaves exactly as it always has.

## Setting it up (one time, about twenty minutes)

1. Create a project at supabase.com (the free tier is plenty).
2. **SQL editor → run every file in `migrations/`, in order: `0001_user_state.sql`, then
   `0002_conditional_upsert.sql`.** Each is idempotent; running one twice is harmless. The app writes
   through the function 0002 creates, so sync does not work with 0001 alone.
3. **Authentication → URL configuration:** set the Site URL to where the app runs
   (`https://ntrux.vercel.app`), and add `http://localhost:3000/**` to the redirect allow-list for
   development. A magic link only ever redirects to an allow-listed URL.
4. **Authentication → Emails → SMTP settings: switch on a custom SMTP provider. Without this step
   nobody but you can sign in.** Supabase's built-in mailer is for trying things out only: it sends
   **only to members of your Supabase organisation** (everyone else gets `email_address_not_authorized`)
   and only a couple of emails an hour. Any transactional email service works (Resend, Postmark,
   Amazon SES, Brevo…): create an account, verify a sender domain or address, and paste its SMTP host,
   port, user and password here. Then **Authentication → Rate limits → "emails sent per hour"**: raise
   it to something a real launch needs (it starts low).
   Sources: <https://supabase.com/docs/guides/auth/auth-smtp> ·
   <https://supabase.com/docs/guides/auth/debugging/error-codes>
5. **Project settings → API:** copy the **Project URL** and the **anon / publishable key** into
   `.env.local` (and the Vercel project's environment variables):

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```

   The anon key is safe in a browser: Row Level Security (below) is what protects the data. **The
   `service_role` key is never needed by this app and must never be committed** — the repo is public.

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
  them by cascade. The sign-in provider's own audit log of past sign-ins is kept for its retention period.

## The RLS test plan — run it once after applying the migrations

RLS is the only thing between one user and another's data, so it is verified, not assumed. In the SQL
editor, impersonate two users (or sign in as two accounts in two browsers) and check:

| # | As | Do | Expect |
|---|---|---|---|
| 1 | anon (signed out) | `select * from user_state` | permission denied |
| 2 | user A | insert a row with `user_id` = A | ok |
| 3 | user A | insert a row with `user_id` = **B** | **rejected** (`with check`) |
| 4 | user B | `select * from user_state` | only B's rows — none of A's |
| 5 | user B | `update user_state set value = '1' where user_id = A` | 0 rows changed |
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
