# Supabase — the account backend

**Owned by the accounts lane** (`docs/parallel/lane-accounts.md`). Nothing here runs until the owner
creates a Supabase project; with no keys configured the app behaves exactly as it always has.

## Setting it up (one time, about ten minutes)

1. Create a project at supabase.com (the free tier is plenty).
2. **SQL editor → paste `migrations/0001_user_state.sql` → Run.** It is idempotent; running it twice is
   harmless.
3. **Authentication → URL configuration:** set the Site URL to where the app runs
   (`https://ntrux.vercel.app`), and add `http://localhost:3000/**` to the redirect allow-list for
   development. A magic link only ever redirects to an allow-listed URL.
4. **Project settings → API:** copy the **Project URL** and the **anon / publishable key** into
   `.env.local` (and the Vercel project's environment variables):

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```

   The anon key is safe in a browser: Row Level Security (below) is what protects the data. **The
   `service_role` key is never needed by this app and must never be committed** — the repo is public.

## What the schema is

One table, `user_state`: a row per (user, store), holding that store's JSON exactly as
`src/lib/storage.ts` wrote it, plus the time the writing device wrote it. Sync rules live in
`src/lib/account/merge.ts`. One function, `delete_my_account()`, lets a signed-in user delete
themselves; every row of theirs goes with them by cascade.

## The RLS test plan — run it once after applying the migration

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
| 7 | user A | `select delete_my_account()` | A's auth user and every A row gone; B untouched |

Impersonation in the SQL editor:

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<user A uuid>", "role": "authenticated"}';
select * from public.user_state;   -- then run each row of the table above
```
