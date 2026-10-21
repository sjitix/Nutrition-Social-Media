#!/usr/bin/env bash
# The local stack, inside WSL:   stack.sh up | down | reset
#
#   up     Postgres (initialised once), the platform's roles, GoTrue's own migrations, THIS repo's
#          migrations, then GoTrue (twice: as step 3 sets it, and with "Confirm email" on), PostgREST
#          and the gateway. Prints `READY <stack id>`, then stays in the
#          foreground: the stack lives exactly as long as this script, and its EXIT trap takes it down
#          (run.mjs ending, Ctrl+C, a closed window).
#   down   stops a stack something left behind (a crash, `wsl --shutdown` mid-run)
#   reset  down, then forgets the database (the next `up` starts from an empty project)
#
# ONE STACK AT A TIME. `up` holds a lock for its whole life, and `down`/`reset` wait briefly for it and
# then refuse, instead of tearing down someone else's run. Several agents share this WSL user, and two
# overlapping runs used to destroy each other's stacks and both report failures that looked like bugs.
# Nothing is ever signalled by PID alone: a process is stopped only if it is still one of the cache's
# own binaries, because PIDs start again from 1 every time the distro boots.
#
# Postgres listens ONLY on a Unix socket, in a folder only this user can open. WSL republishes every
# loopback TCP port on Windows' localhost, so 127.0.0.1 would not have kept a passwordless superuser
# to this user. GoTrue, PostgREST and db.mjs all connect through the socket.
#
# run.mjs feeds this file to `bash -s` with LIVE_REPO set (the repo as WSL sees it), so it does not rely
# on its own path. Ports: 54321 gateway (the app's URL), 54325 mail, 54329 GoTrue, 54330 PostgREST, 54331
# the second GoTrue ("Confirm email" on), all on 127.0.0.1; Postgres's socket is .s.PGSQL.54322 in
# $C/run/pg.
set -euo pipefail

C="$HOME/.cache/nutriflow-live"
PG="$C/pg/bin"
NODE="$C/node/bin/node"
SOCK="$C/run/pg"
mkdir -p "$C/run" "$C/logs" "$SOCK"
chmod 700 "$C" "$SOCK"

exec 9>"$C/run/lock"
flock -w 15 9 || { echo "stack.sh: another live run is using the stack; try again when it has finished" >&2; exit 3; }

ours() { case "$(readlink "/proc/$1/exe" 2>/dev/null)" in "$C"/*) return 0 ;; *) return 1 ;; esac; }

down() {
  for f in "$C"/run/*.pid; do
    [ -e "$f" ] || continue
    p="$(cat "$f")"
    if ours "$p"; then kill "$p" 2>/dev/null || true; fi
    rm -f "$f"
  done
  # A postmaster.pid left by a stack that never shut down names a PID some other process may hold now.
  # So does the lock beside the socket, which lives on the persistent disk with it (/tmp, emptied at every
  # boot, no longer is its home): Postgres refuses to start while a stale one names a live process.
  if [ -f "$C/data/postmaster.pid" ] && ! ours "$(head -n 1 "$C/data/postmaster.pid")"; then rm -f "$C/data/postmaster.pid"; fi
  if [ -f "$SOCK/.s.PGSQL.54322.lock" ] && ! ours "$(head -n 1 "$SOCK/.s.PGSQL.54322.lock")"; then
    rm -f "$SOCK/.s.PGSQL.54322.lock" "$SOCK/.s.PGSQL.54322"
  fi
  if [ -d "$C/data" ] && "$PG/pg_ctl" -D "$C/data" status >/dev/null 2>&1; then
    "$PG/pg_ctl" -D "$C/data" -m fast -w stop >/dev/null
  fi
}

case "${1:-}" in
  down) down; echo "stack down"; exit 0 ;;
  reset) down; rm -rf "$C/data" "$C/jwt-secret"; echo "stack reset"; exit 0 ;;
  up) LIVE="${LIVE_REPO:?LIVE_REPO is not set}/scripts/account-live" ;;
  *) echo "usage: stack.sh up|down|reset" >&2; exit 2 ;;
esac

down # whatever a crash left behind
trap down EXIT
# A signal ends the script through `exit`, so the EXIT trap runs whatever ends it: run.mjs killing its
# wsl.exe, Ctrl+C, a closed window. bash does not promise the EXIT trap for an untrapped signal.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

STACK="$(openssl rand -hex 8)" # run.mjs checks that Windows' localhost:54321 answers with THIS id
( umask 077; [ -s "$C/jwt-secret" ] || openssl rand -hex 32 > "$C/jwt-secret" )
SECRET="$(cat "$C/jwt-secret")"

if [ ! -d "$C/data" ]; then
  "$PG/initdb" -D "$C/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
fi
# 9>&-: the servers must not inherit the lock, or it would outlive this script.
"$PG/pg_ctl" -D "$C/data" -o "-p 54322 -k '$SOCK' -c listen_addresses='' -c unix_socket_permissions=0700" \
  -l "$C/logs/postgres.log" -w start >/dev/null 9>&- || {
  echo "postgres did not start; the end of $C/logs/postgres.log:" >&2
  tail -n 20 "$C/logs/postgres.log" >&2
  exit 1
}
"$NODE" "$LIVE/db.mjs" init

# ---- GoTrue: Supabase's own auth server, configured as steps 3 and 4 of supabase/README.md say ----
export GOTRUE_API_HOST=127.0.0.1
export PORT=54329
export API_EXTERNAL_URL=http://localhost:54321
export GOTRUE_DB_DRIVER=postgres
export DATABASE_URL="postgres://supabase_auth_admin@/postgres?host=$SOCK&port=54322&sslmode=disable"
export GOTRUE_DB_DATABASE_URL="$DATABASE_URL"
export GOTRUE_DB_MIGRATIONS_PATH="$C/auth/migrations"
# Step 3: the Site URL is the PRODUCTION account page, and localhost reaches the account page only through
# the allow list, exactly as on the hosted project. A return address the list refused would land on the
# browser's Referer origin if the list admitted that, and on the Site URL otherwise. The run sends no
# Referer, so only the second can happen here, and the live run checks where every link lands. (open()
# never follows the redirect, so nothing is fetched from production.)
export GOTRUE_SITE_URL="https://ntrux.vercel.app/sage/account"
export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**"
export GOTRUE_JWT_SECRET="$SECRET"
export GOTRUE_JWT_EXP=3600
export GOTRUE_JWT_AUD=authenticated
export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_JWT_ADMIN_ROLES=service_role
export GOTRUE_DISABLE_SIGNUP=false
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
export GOTRUE_MAILER_AUTOCONFIRM=true                        # step 3: "Confirm email" off
export GOTRUE_AUDIT_LOG_DISABLE_POSTGRES=true                # step 3: "Write audit logs to the database" off
export GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10       # a hosted project's default (unset, GoTrue uses 0)
export GOTRUE_SMTP_HOST=127.0.0.1                             # step 4: a custom SMTP (here, the catcher)
export GOTRUE_SMTP_PORT=54325
export GOTRUE_SMTP_ADMIN_EMAIL=noreply@nutriflow.local
export GOTRUE_SMTP_SENDER_NAME=NutriFlow
export GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify
export GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify
export GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify
export GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000                      # the hourly cap; the 60 s per-person limit stays real
export GOTRUE_LOG_LEVEL=info

(cd "$C/auth" && ./auth migrate) >"$C/logs/gotrue-migrate.log" 2>&1 || { cat "$C/logs/gotrue-migrate.log" >&2; exit 1; }
"$NODE" "$LIVE/db.mjs" migrate

(cd "$C/auth" && exec ./auth serve) >"$C/logs/gotrue.log" 2>&1 9>&- &
echo $! > "$C/run/gotrue.pid"

# A second GoTrue on the same database, with "Confirm email" ON: a hosted project's default, which step 3
# turns off. The gateway sends /confirm/auth/v1/* to it, and run.mjs points four browsers there. A new
# person's first link is then a confirmation link, whose flow state expires 300 s after the REQUEST
# (FlowStateExpiryDuration; flow_state.go counts from the open only for a magic link). Everything else
# is the exported setup above. Its links carry the /confirm prefix, so they come back through the gateway.
(cd "$C/auth" && PORT=54331 GOTRUE_MAILER_AUTOCONFIRM=false \
  GOTRUE_MAILER_URLPATHS_CONFIRMATION=/confirm/auth/v1/verify GOTRUE_MAILER_URLPATHS_RECOVERY=/confirm/auth/v1/verify \
  GOTRUE_MAILER_URLPATHS_INVITE=/confirm/auth/v1/verify GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/confirm/auth/v1/verify \
  GOTRUE_MAILER_URLPATHS_MAGIC_LINK=/confirm/auth/v1/verify \
  exec ./auth serve) >"$C/logs/gotrue-confirm.log" 2>&1 9>&- &
echo $! > "$C/run/gotrue-confirm.pid"

( umask 077; cat > "$C/postgrest.conf" <<CONF
db-uri = "postgres://authenticator@/postgres?host=$SOCK&port=54322"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = 54330
CONF
)
"$C/postgrest/postgrest" "$C/postgrest.conf" >"$C/logs/postgrest.log" 2>&1 9>&- &
echo $! > "$C/run/postgrest.pid"

LIVE_JWT_SECRET="$SECRET" LIVE_STACK_ID="$STACK" "$NODE" "$LIVE/gateway.mjs" >"$C/logs/gateway.log" 2>&1 9>&- &
echo $! > "$C/run/gateway.pid"

for _ in $(seq 1 80); do
  if curl -fs -o /dev/null http://127.0.0.1:54321/auth/v1/health && curl -fs -o /dev/null http://127.0.0.1:54321/confirm/auth/v1/health \
    && curl -fs -o /dev/null http://127.0.0.1:54330/; then
    echo "READY $STACK"
    wait # keep the stack alive for as long as the run that started it
    exit 0
  fi
  sleep 0.25
done
echo "the stack did not come up; logs (in $C/logs):" >&2
tail -n 20 "$C"/logs/*.log >&2
exit 1
