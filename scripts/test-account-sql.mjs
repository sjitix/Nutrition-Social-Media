// The accounts migrations, EXECUTED in real Postgres, and the test plan from supabase/README.md run
// against them.
//
//   node scripts/test-account-sql.mjs             every check, against supabase/migrations/*.sql
//   node scripts/test-account-sql.mjs --mutate    ...then break each guard in turn: a check must fail
//   node scripts/test-account-sql.mjs [--mutate] <repo-root>   (another worktree)
//
// Why it exists. scripts/test-account.mjs runs the client against an in-memory FAKE of Supabase, and
// WORKPLAN lesson 52 is what a fake costs: it only fails where its author thought to model the
// backend. Until a Supabase project exists, this is the only place the SQL itself ever runs — and its
// first run found what no fake could have: under Supabase's default grants, every signed-in user held
// TRUNCATE on the table, which row-level security does not cover (fixed in 0001).
//
// What is real: PGlite is the actual Postgres engine compiled to WebAssembly — its parser, RLS,
// grants, constraints, jsonb and ON CONFLICT. What is stubbed, the way Supabase defines it: the anon
// and authenticated roles WITH Supabase's default privileges (a fresh project grants every new table
// and function in `public` to both), `auth.users`, and `auth.uid()` reading the request's JWT claims.
// NOT covered, and left to the live run: whether the `postgres` role may delete from auth.users on a
// hosted project (here it is a superuser), PostgREST's routing, and GoTrue itself.
//
// No package.json change for either lane: PGlite is taken from node_modules if a lane ever adds it,
// and is otherwise installed once into a folder of its own under the OS temp directory.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PGLITE = "@electric-sql/pglite@0.3.16";
const mutate = process.argv.includes("--mutate");
const root = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.cwd();

async function loadPGlite() {
  try {
    return (await import("@electric-sql/pglite")).PGlite;
  } catch {
    /* not in node_modules — use (or make) the cache below */
  }
  const dir = join(tmpdir(), "nutriflow-pglite-0.3.16");
  const entry = join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js");
  if (!existsSync(entry)) {
    console.log(`PGlite (Postgres compiled to WebAssembly) is not installed. Installing ${PGLITE} once,`);
    console.log(`into ${dir} — nothing in this repo changes.\n`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "name": "nutriflow-pglite-cache", "private": true }\n');
    // npm is a .cmd shim on Windows, and Node only spawns one through a shell (see ship.mjs). So the
    // command is ONE CONSTANT STRING and the folder goes in as `cwd`: nothing variable ever reaches
    // that shell, and Node has no separate arguments to warn about concatenating (DEP0190).
    execSync(`npm install --no-audit --no-fund ${PGLITE}`, { cwd: dir, stdio: "inherit" });
  }
  return (await import(pathToFileURL(entry).href)).PGlite;
}

// ---------------------------------------------------------------------------------------------------
// The checks. Each run gets a fresh database, so a mutation run cannot inherit anything from the last.
// ---------------------------------------------------------------------------------------------------

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

async function runChecks(PGlite, migrations, { quiet = false } = {}) {
  const db = new PGlite();
  const results = [];
  const check = (label, cond, detail = "") => {
    results.push({ label, ok: !!cond, detail });
    if (!quiet) console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && detail ? `  — ${detail}` : ""}`);
  };
  const attempt = async (sql, params) => {
    try {
      return { ok: true, res: await db.query(sql, params) };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e), code: e?.code };
    }
  };
  // A migration file is many statements; the extended protocol (db.query) takes exactly one.
  const attemptScript = async (sql) => {
    try {
      await db.exec(sql);
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e) };
    }
  };
  const as = async (role, sub) => {
    await db.exec("reset role;");
    await db.query("select set_config('request.jwt.claims', $1, false)", [sub ? JSON.stringify({ sub, role }) : ""]);
    await db.exec(`set role ${role};`);
  };
  const asAdmin = () => db.exec("reset role;");
  const upsert = (rows) => attempt("select public.upsert_state($1::jsonb) as skipped", [JSON.stringify(rows)]);
  const skippedOf = (r) => JSON.stringify(r.res?.rows?.[0]?.skipped);
  const valueOf = async (user, key) => {
    const q = await attempt("select value from public.user_state where user_id = $1 and key = $2", [user, key]);
    return q.ok && q.res.rows.length ? JSON.stringify(q.res.rows[0].value) : undefined;
  };

  // ---- Supabase's environment, stubbed the way Supabase defines it ----
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
    -- A fresh Supabase project grants every table, function and sequence created in public to BOTH
    -- API roles. Without this the stub would deny anon on its own, and "anon gets nothing" would pass
    -- whether or not the migration revokes anything.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create table auth.users (id uuid primary key, email text);
    -- Supabase's own definition, so a request with no claims reads as no user rather than an error.
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');
  `);

  // ---- the migrations, exactly as committed, each applied twice (they claim to be idempotent) ----
  for (const m of migrations) {
    const first = await attemptScript(m.sql);
    check(`migration ${m.name} applies`, first.ok, first.err);
    const again = await attemptScript(m.sql);
    check(`migration ${m.name} applies a second time (idempotent)`, again.ok, again.err);
  }

  // ---- grants: exactly what each API role holds ----
  // RLS filters rows for SELECT/INSERT/UPDATE/DELETE. TRUNCATE ignores RLS entirely, so it must not
  // be granted at all — and Supabase's defaults grant it unless the migration takes it back.
  const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  for (const [role, want] of [["anon", []], ["authenticated", ["SELECT", "INSERT", "UPDATE", "DELETE"]]]) {
    const held = [];
    for (const p of PRIVS) {
      const q = await attempt("select has_table_privilege($1, 'public.user_state', $2) as ok", [role, p]);
      if (q.ok && q.res.rows[0].ok) held.push(p);
    }
    check(`grants: ${role} holds exactly [${want.join(", ")}] on user_state`, held.join() === want.join(), `holds [${held.join(", ")}]`);
  }
  for (const [fn, role, want] of [
    ["public.upsert_state(jsonb)", "anon", false],
    ["public.upsert_state(jsonb)", "authenticated", true],
    ["public.delete_my_account()", "anon", false],
    ["public.delete_my_account()", "authenticated", true],
  ]) {
    const q = await attempt("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn]);
    check(`grants: ${role} ${want ? "can" : "cannot"} execute ${fn}`, q.ok && q.res.rows[0].ok === want, q.err);
  }

  // ---- the README's test plan ----
  await as("anon", null);
  let r = await attempt("select * from public.user_state");
  check("RLS 1: anon cannot read the table at all (permission denied, not an empty list)", !r.ok && /permission denied/i.test(r.err), r.err ?? "the select succeeded");

  await as("authenticated", A);
  r = await attempt(`insert into public.user_state (user_id, key, value) values ($1, 'plan', '{"x":1}')`, [A]);
  check("RLS 2: user A can insert a row for A", r.ok, r.err);

  r = await attempt(`insert into public.user_state (user_id, key, value) values ($1, 'saved', '["x"]')`, [B]);
  check("RLS 3: user A CANNOT insert a row carrying B's id (with check)", !r.ok && /row-level security/i.test(r.err), r.err ?? "the insert succeeded");

  await asAdmin();
  r = await attempt(`insert into public.user_state (user_id, key, value) values ($1, 'plan', '{"b":true}')`, [B]);
  check("(setup) an admin can seed a row for B", r.ok, r.err);

  await as("authenticated", B);
  r = await attempt("select user_id::text, key from public.user_state");
  check("RLS 4: user B sees only B's rows", r.ok && r.res.rows.length === 1 && r.res.rows[0].user_id === B, JSON.stringify(r.res?.rows ?? r.err));

  // No WHERE clause, and a constant SET, ON PURPOSE: a statement that reads a column also gets the
  // SELECT policy applied, which would hide A's row by itself and let a broken UPDATE or DELETE policy
  // pass unseen. Each runs in a transaction that is rolled back, so B's row is still there afterwards.
  // (A role set inside a rolled-back transaction is rolled back too, hence the `as` after each.)
  await db.exec("begin;");
  r = await attempt("update public.user_state set value = '1'::jsonb");
  check("RLS 5: B's update of EVERY row reaches only B's own row", r.ok && r.res.affectedRows === 1, JSON.stringify(r.res?.affectedRows ?? r.err));
  await db.exec("rollback;");
  await as("authenticated", B);

  await db.exec("begin;");
  r = await attempt("delete from public.user_state");
  check("RLS 5b: B's delete of EVERY row removes only B's own row", r.ok && r.res.affectedRows === 1, JSON.stringify(r.res?.affectedRows ?? r.err));
  await db.exec("rollback;");
  await as("authenticated", B);

  r = await attempt("truncate public.user_state");
  check("RLS 5c: user B cannot TRUNCATE the table (it would empty every account, RLS or not)", !r.ok && /permission denied/i.test(r.err), r.err ?? "the truncate succeeded");
  await asAdmin();
  const survivors = await attempt("select count(*)::int as n from public.user_state");
  check("RLS 5c: ...and every account's rows are still there", survivors.ok && survivors.res.rows[0].n === 2, JSON.stringify(survivors.res?.rows ?? survivors.err));

  await as("authenticated", A);
  r = await attempt(`insert into public.user_state (user_id, key, value) values ($1, 'somethingElse', '1')`, [A]);
  check("RLS 6: an unknown store name is rejected (check constraint)", !r.ok && /check constraint/i.test(r.err), r.err ?? "the insert succeeded");

  // ---- upsert_state: writes only move forward in time ----
  r = await upsert([{ key: "saved", value: ["x"], updated_at: "2030-01-01T00:00:00Z" }]);
  check("upsert 7: a new store is written and nothing is skipped", r.ok && skippedOf(r) === "[]", skippedOf(r) ?? r.err);
  await asAdmin();
  const owner = await attempt("select user_id::text from public.user_state where key = 'saved'");
  check("upsert 7: ...and the row belongs to A — the user id comes from the token, not the request", owner.ok && owner.res.rows.length === 1 && owner.res.rows[0].user_id === A, JSON.stringify(owner.res?.rows ?? owner.err));

  await as("authenticated", A);
  r = await upsert([{ key: "saved", value: ["OLD"], updated_at: "2020-01-01T00:00:00Z" }]);
  check("upsert 8: an OLDER write is skipped, and reported as skipped", r.ok && skippedOf(r) === '["saved"]', skippedOf(r) ?? r.err);
  check("upsert 8: ...and the stored value is unchanged", (await valueOf(A, "saved")) === '["x"]', await valueOf(A, "saved"));

  r = await upsert([{ key: "saved", value: ["x"], updated_at: "2030-01-01T00:00:00Z" }]);
  check("upsert: an equal time (a resend of the same write) is skipped, not re-written", r.ok && skippedOf(r) === '["saved"]', skippedOf(r) ?? r.err);

  r = await upsert([{ key: "saved", value: ["NEW"], updated_at: "2031-01-01T00:00:00Z" }]);
  check("upsert: a NEWER write replaces the stored value", r.ok && (await valueOf(A, "saved")) === '["NEW"]', (await valueOf(A, "saved")) ?? r.err);

  r = await upsert([
    { key: "saved", value: ["OLDER"], updated_at: "2001-01-01T00:00:00Z" },
    { key: "chat", value: [], updated_at: "2031-01-01T00:00:00Z" },
  ]);
  check("upsert: a mixed batch writes the newer row and skips only the older", r.ok && skippedOf(r) === '["saved"]' && (await valueOf(A, "chat")) === "[]", skippedOf(r) ?? r.err);

  r = await upsert([{ key: "batchPlan", value: null, updated_at: "2031-01-01T00:00:00Z" }]);
  check("upsert: a cleared store (null) is kept as a row and reads back as null", r.ok && (await valueOf(A, "batchPlan")) === "null", (await valueOf(A, "batchPlan")) ?? r.err);

  // ---- what Postgres does to the data — the facts the client's design rests on ----
  r = await attempt("select public.upsert_state($1::jsonb)", ['[{"key":"profile","value":{"targetCalories":1,"bb":2,"a":3},"updated_at":"2031-01-01T00:00:00Z"}]']);
  const text = await attempt("select value::text as t from public.user_state where user_id = $1 and key = 'profile'", [A]);
  const t = text.res?.rows?.[0]?.t ?? "";
  check("jsonb: object keys come back RE-ORDERED — why sync compares with canonical(), never by text", r.ok && t.indexOf('"a"') < t.indexOf('"targetCalories"'), t || text.err);

  r = await upsert([{ key: "chat", value: [{ text: "x".repeat(1_100_000) }], updated_at: "2032-01-01T00:00:00Z" }]);
  check("size: a store over 1 MB is refused, measured as written (this one compresses to almost nothing)", !r.ok && /user_state_value_size/i.test(r.err), r.err?.slice(0, 160) ?? "it was stored");

  r = await attempt(`select '{"t":"\\ud83c"}'::jsonb`);
  check("jsonb: a lone surrogate is refused — why the client makes every string well-formed first", !r.ok, "it was accepted");

  await as("anon", null);
  r = await attempt("select public.upsert_state('[]'::jsonb)");
  check("RLS 9: anon cannot call upsert_state", !r.ok && /permission denied/i.test(r.err), r.err ?? "the call succeeded");

  await as("authenticated", B);
  r = await upsert([{ key: "saved", value: ["B WROTE THIS"], updated_at: "2040-01-01T00:00:00Z" }]);
  await asAdmin(); // read both sides as the owner: as B, RLS would hide A's row and prove nothing
  const aSaved = await valueOf(A, "saved");
  const bSaved = await valueOf(B, "saved");
  check("upsert: B's call writes B's row and never A's", r.ok && aSaved === '["NEW"]' && bSaved === '["B WROTE THIS"]', `A ${aSaved}, B ${bSaved}, ${r.err ?? ""}`);

  // ---- delete my account ----
  await as("authenticated", A);
  r = await attempt("select public.delete_my_account()");
  check("RLS 10: delete_my_account runs for the signed-in user", r.ok, r.err);
  await asAdmin();
  const users = await attempt("select id::text from auth.users order by id");
  const rows = await attempt("select user_id::text from public.user_state");
  check("RLS 10: A's auth user is gone and B's remains", users.ok && users.res.rows.length === 1 && users.res.rows[0].id === B, JSON.stringify(users.res?.rows ?? users.err));
  check("RLS 10: every one of A's rows went with it (cascade), and B's are untouched", rows.ok && rows.res.rows.length >= 2 && rows.res.rows.every((x) => x.user_id === B), JSON.stringify(rows.res?.rows ?? rows.err));

  // A deleted account's token still works at PostgREST until it expires (a JWT is stateless). What it
  // then gets is the client's contract (supabase.ts `pushFailure`): reads come back empty, and a write
  // breaks the foreign key to auth.users with SQLSTATE 23503, which PostgREST sends as 409 and the
  // client reads as "this account was deleted" (review 2, platform-4).
  await as("authenticated", A);
  r = await attempt("select key from public.user_state");
  check("deleted account: its still-valid token reads an empty account", r.ok && r.res.rows.length === 0, JSON.stringify(r.res?.rows ?? r.err));
  r = await upsert([{ key: "plan", value: { late: true }, updated_at: "2050-01-01T00:00:00Z" }]);
  check("deleted account: …and a write fails with 23503, which the client reads as 'this account was deleted'",
    !r.ok && r.code === "23503", JSON.stringify({ code: r.code ?? null, err: r.err ?? "the write succeeded" }));

  await as("anon", null);
  r = await attempt("select public.delete_my_account()");
  check("delete: anon cannot call delete_my_account", !r.ok && /permission denied/i.test(r.err), r.err ?? "the call succeeded");

  await db.close();
  return results;
}

// ---------------------------------------------------------------------------------------------------
// The mutations: each removes ONE guard from the SQL. A check that still passes without the thing it
// guards proves nothing (WORKPLAN lesson 53), so every one of these must turn at least one check red.
// ---------------------------------------------------------------------------------------------------

const MUTATIONS = [
  ["no RLS at all", "0001", "alter table public.user_state enable row level security;", ""],
  ["select policy lets everyone read", "0001", 'for select to authenticated\n  using (user_id = auth.uid());', "for select to authenticated\n  using (true);"],
  ["insert policy without its check", "0001", "for insert to authenticated\n  with check (user_id = auth.uid());", "for insert to authenticated\n  with check (true);"],
  ["update policy reaches every row", "0001", "for update to authenticated\n  using (user_id = auth.uid())", "for update to authenticated\n  using (true)"],
  ["delete policy reaches every row", "0001", "for delete to authenticated\n  using (user_id = auth.uid());", "for delete to authenticated\n  using (true);"],
  ["Supabase's default grants left in place", "0001", "revoke all on public.user_state from anon, authenticated;", ""],
  ["TRUNCATE left with signed-in users", "0001", "revoke all on public.user_state from anon, authenticated;", "revoke all on public.user_state from anon;"],
  ["any store name accepted", "0001", "check (key in (", "check (key is not null or key in ("],
  ["no size limit", "0001", "pg_column_size(value) < 1000000", "true"],
  ["no cascade from the auth user", "0001", "references auth.users (id) on delete cascade", "references auth.users (id)"],
  ["no foreign key to the auth user (a deleted account's late writes land as orphans)", "0001", "references auth.users (id) on delete cascade", ""],
  ["delete_my_account deletes everyone", "0001", "delete from auth.users where id = auth.uid();", "delete from auth.users;"],
  ["anon may delete accounts", "0001", "revoke all on function public.delete_my_account() from public, anon;", ""],
  ["stale writes win (the conditional upsert)", "0002", "where s.updated_at < excluded.updated_at", "where true"],
  ["equal times re-write (a resend counts as new)", "0002", "where s.updated_at < excluded.updated_at", "where s.updated_at <= excluded.updated_at"],
  ["anon may call upsert_state", "0002", "revoke all on function public.upsert_state(jsonb) from public, anon;", ""],
];

// ---------------------------------------------------------------------------------------------------

const dir = join(root, "supabase", "migrations");
// CRLF or LF depends on the checkout; the SQL means the same either way, and the anchors are LF.
const migrations = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n") }));

const PGlite = await loadPGlite();
const results = await runChecks(PGlite, migrations);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);

if (mutate) {
  console.log("\nMutations — each must turn at least one check red:\n");
  let missed = 0;
  for (const [label, prefix, from, to] of MUTATIONS) {
    const target = migrations.find((m) => m.name.startsWith(prefix));
    const hits = target ? target.sql.split(from).length - 1 : 0;
    if (hits !== 1) {
      // A mutation that cannot be applied is not a pass: the SQL moved and the check went with it.
      missed++;
      console.log(`SKIP    ${label}  — its anchor matched ${hits} times in ${prefix}; update MUTATIONS`);
      continue;
    }
    const mutated = migrations.map((m) => (m === target ? { ...m, sql: m.sql.replace(from, to) } : m));
    const red = (await runChecks(PGlite, mutated, { quiet: true })).filter((x) => !x.ok);
    if (red.length) console.log(`caught  ${label}  — ${red[0].label}${red.length > 1 ? ` (+${red.length - 1} more)` : ""}`);
    else {
      missed++;
      console.log(`MISSED  ${label}  — every check still passes without it`);
    }
  }
  console.log(`\n${MUTATIONS.length - missed}/${MUTATIONS.length} mutations caught`);
  if (missed) process.exit(1);
}
