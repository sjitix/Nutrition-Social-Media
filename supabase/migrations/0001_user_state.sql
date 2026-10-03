-- NutriFlow accounts — the whole server-side schema.
--
-- Local-first, the account is a mirror (VISION → Accounts; docs/parallel/lane-accounts.md). The
-- browser keeps every store in localStorage; a signed-in browser mirrors each store to ONE row here.
-- So the schema is deliberately one table: a row per (user, store), the store's JSON as written by
-- the app, and the time it was written.
--
-- Apply once, in the Supabase dashboard → SQL editor (or `supabase db push`). It is idempotent.
-- It needs nothing but the anon key on the client: every rule below is enforced by Row Level
-- Security, so the browser can talk to the REST API directly and still only ever reach its own rows.
-- The service_role key is NOT used by the app and must never be committed to this public repo.

create table if not exists public.user_state (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  -- The store's name. Must match `STORE_NAMES` in src/lib/storage.ts — the same "one concept, one
  -- key" rule, enforced here so a typo in a client can't create a second, drifting copy of a store.
  key        text        not null check (key in (
               'profile', 'plan', 'batchPlan', 'chat', 'imports', 'saved', 'groceriesChecked', 'visits'
             )),
  -- The store's content exactly as the app wrote it. NULL means the store was cleared on purpose —
  -- kept as a row (not deleted) so the clear itself syncs to the user's other devices.
  value      jsonb,
  -- When the WRITING DEVICE wrote it. Sync compares this with the local write time to decide which
  -- side is newer (src/lib/account/merge.ts, rule 2), so it is the client's time, not now().
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  -- A week plan is ~30 kB. 1 MB per store is generous for real use and stops the table being used
  -- as free storage for anything else.
  constraint user_state_value_size check (value is null or pg_column_size(value) < 1000000)
);

alter table public.user_state enable row level security;

-- One policy per verb, each the same rule: you may only touch rows that are yours. Written out per
-- verb (rather than `for all`) so a reviewer can see that INSERT and UPDATE also CHECK the row being
-- written — without `with check`, a user could write a row carrying someone else's user_id.
drop policy if exists "read own state"   on public.user_state;
drop policy if exists "insert own state" on public.user_state;
drop policy if exists "update own state" on public.user_state;
drop policy if exists "delete own state" on public.user_state;

create policy "read own state"   on public.user_state for select to authenticated
  using (user_id = auth.uid());
create policy "insert own state" on public.user_state for insert to authenticated
  with check (user_id = auth.uid());
create policy "update own state" on public.user_state for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own state" on public.user_state for delete to authenticated
  using (user_id = auth.uid());

-- Anonymous visitors get nothing at all — not even an empty select.
revoke all on public.user_state from anon;
grant select, insert, update, delete on public.user_state to authenticated;

-- Delete my account: the signed-in user removes their own auth record, and `on delete cascade`
-- removes every row above with it. SECURITY DEFINER because a user cannot normally touch auth.users;
-- it is safe because the only row it can ever reach is `auth.uid()` — the caller's own. An empty
-- search_path stops a malicious object named like a built-in from being picked up.
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
