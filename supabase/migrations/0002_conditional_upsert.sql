-- NutriFlow accounts — writes that can only move a store FORWARD in time.
--
-- Why this exists (found by the adversarial review of 0001): a plain upsert takes whatever arrives
-- last. A phone that queued an edit offline on Saturday and reconnects on Monday would overwrite the
-- week the laptop saved on Sunday, because the server never compared their times — newest-wins was
-- only ever applied inside the client's full sync, not on the server's door.
--
-- So every write goes through this one function. For each store it inserts the row, or replaces the
-- existing one ONLY IF the incoming write is newer (`updated_at` strictly later). It returns the keys
-- it did NOT write, and the client answers those by pulling first (src/lib/account/sync.ts: `skipped`).
--
-- Apply after 0001, in the SQL editor. Idempotent: safe to run again.
--
-- SECURITY INVOKER: the function runs as the calling user, so every row-level-security policy from
-- 0001 still applies, and the user id is taken from the verified token (auth.uid()), never from the
-- request — a client cannot write a row for anyone else even by asking.

create or replace function public.upsert_state(rows jsonb)
returns text[]
language sql
security invoker
set search_path = ''
as $$
  with incoming as (
    select
      r ->> 'key'                       as key,
      r -> 'value'                      as value,
      (r ->> 'updated_at')::timestamptz as updated_at
    from jsonb_array_elements(rows) as r
  ),
  written as (
    insert into public.user_state as s (user_id, key, value, updated_at)
    select auth.uid(), i.key, i.value, i.updated_at
    from incoming as i
    on conflict (user_id, key) do update
      set value = excluded.value,
          updated_at = excluded.updated_at
      where s.updated_at < excluded.updated_at
    returning s.key
  )
  select coalesce(array_agg(i.key), '{}'::text[])
  from incoming as i
  where i.key not in (select w.key from written as w);
$$;

revoke all on function public.upsert_state(jsonb) from public, anon;
grant execute on function public.upsert_state(jsonb) to authenticated;
