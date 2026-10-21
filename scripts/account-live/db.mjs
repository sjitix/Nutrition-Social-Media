// SQL against the local stack's Postgres, run INSIDE WSL with the cache's Node (stack.sh calls it):
//
//   node db.mjs init       the roles and schemas a Supabase project starts with (idempotent)
//   node db.mjs migrate    supabase/migrations/*.sql from this repo, in order, exactly as committed
//   node db.mjs query SQL  one statement, rows printed as JSON (the live run's look at the database)
//
// Superuser `postgres` throughout: on a hosted project that is the role the SQL editor runs as. It
// connects through Postgres's Unix socket, which only this WSL user can open (stack.sh), never TCP.
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = `${process.env.HOME}/.cache/nutriflow-live`;
const require = createRequire(`${cache}/node_modules/`);
const { Client } = require("pg");

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const SOCKET_DIR = `${cache}/run/pg`;
const PORT = 54322; // names the socket file (.s.PGSQL.54322); nothing listens on a TCP port

// What Supabase's platform sets up before any project SQL runs, as far as this app depends on it:
// the three API roles; `authenticator`, the login PostgREST connects as and switches role from; GoTrue's
// own admin role owning the `auth` schema (GoTrue's migrations create everything inside it); and the
// DEFAULT PRIVILEGES that grant every new table and function in `public` to the API roles. That last one
// is the default the 0001 migration has to take back (lesson 56), so it must be here for the run to mean
// anything.
const INIT = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login noinherit createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'dashboard_user') then create role dashboard_user nologin; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const [cmd, ...rest] = process.argv.slice(2);
const client = new Client({ host: SOCKET_DIR, port: PORT, user: "postgres", database: "postgres" });
await client.connect();
try {
  if (cmd === "init") {
    await client.query(INIT);
    console.log("db: roles and schemas in place");
  } else if (cmd === "migrate") {
    const dir = join(repo, "supabase", "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(dir, f), "utf8"));
      console.log(`db: applied ${f}`);
    }
  } else if (cmd === "query") {
    const r = await client.query(rest.join(" "));
    console.log(JSON.stringify(r.rows));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} finally {
  await client.end();
}
