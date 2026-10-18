#!/usr/bin/env bash
# The local stack, inside WSL:   stack.sh up | down | reset
#
#   up     Postgres (initialised once), the platform's roles, GoTrue's own migrations, THIS repo's
#          migrations, then GoTrue, PostgREST and the gateway. Prints READY, then stays in the foreground:
#          the stack lives exactly as long as the run that started it (run.mjs), so nothing is left behind.
#   down   stops whatever is running
#   reset  down, then forgets the database (the next `up` starts from an empty project)
#
# run.mjs feeds this file to `bash -s` with LIVE_REPO set (the repo as WSL sees it), so it does not rely on
# its own path. Ports: 54321 gateway (the app's URL), 54322 Postgres, 54325 mail, 54329 GoTrue, 54330 PostgREST.
set -euo pipefail

C="$HOME/.cache/nutriflow-live"
PG="$C/pg/bin"
NODE="$C/node/bin/node"
LIVE="${LIVE_REPO:?LIVE_REPO is not set}/scripts/account-live"
mkdir -p "$C/run" "$C/logs"

down() {
  for f in "$C"/run/*.pid; do
    [ -e "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  if [ -d "$C/data" ] && "$PG/pg_ctl" -D "$C/data" status >/dev/null 2>&1; then
    "$PG/pg_ctl" -D "$C/data" -m fast -w stop >/dev/null
  fi
  rm -f "$C/run/owner"
}

case "${1:-}" in
  down) down; echo "stack down"; exit 0 ;;
  reset) down; rm -rf "$C/data" "$C/jwt-secret"; echo "stack reset"; exit 0 ;;
  up) ;;
  *) echo "usage: stack.sh up|down|reset" >&2; exit 2 ;;
esac

down # never two of anything
# This `up` tears down only what it owns. A stack stopped from outside (`down`, `reset`) ends this
# script's `wait`, and its exit used to run `down` again a moment later, by then killing the NEXT
# stack's servers through the shared PID files. Now it acts only while it is still the owner.
OWNER="$$-$(date +%s%N)"
echo "$OWNER" > "$C/run/owner"
cleanup() { [ "$(cat "$C/run/owner" 2>/dev/null)" = "$OWNER" ] && down; }
trap cleanup EXIT

[ -s "$C/jwt-secret" ] || openssl rand -hex 32 > "$C/jwt-secret"
SECRET="$(cat "$C/jwt-secret")"

if [ ! -d "$C/data" ]; then
  "$PG/initdb" -D "$C/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
fi
"$PG/pg_ctl" -D "$C/data" -o "-p 54322 -k /tmp -c listen_addresses=127.0.0.1" -l "$C/logs/postgres.log" -w start >/dev/null
"$NODE" "$LIVE/db.mjs" init

# ---- GoTrue: Supabase's own auth server, configured as the setup guide (supabase/README.md) says ----
export GOTRUE_API_HOST=127.0.0.1
export PORT=54329
export API_EXTERNAL_URL=http://localhost:54321
export GOTRUE_DB_DRIVER=postgres
export DATABASE_URL="postgres://supabase_auth_admin:auth@127.0.0.1:54322/postgres"
export GOTRUE_DB_DATABASE_URL="$DATABASE_URL"
export GOTRUE_DB_MIGRATIONS_PATH="$C/auth/migrations"
export GOTRUE_SITE_URL="http://localhost:3000/sage/account"   # step 3: the Site URL is the account page
export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**"
export GOTRUE_JWT_SECRET="$SECRET"
export GOTRUE_JWT_EXP=3600
export GOTRUE_JWT_AUD=authenticated
export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_JWT_ADMIN_ROLES=service_role
export GOTRUE_DISABLE_SIGNUP=false
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
export GOTRUE_MAILER_AUTOCONFIRM=true                        # step 3: "Confirm email" off
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

(cd "$C/auth" && ./auth migrate) >"$C/logs/gotrue-migrate.log" 2>&1 || { cat "$C/logs/gotrue-migrate.log"; exit 1; }
"$NODE" "$LIVE/db.mjs" migrate

(cd "$C/auth" && exec ./auth serve) >"$C/logs/gotrue.log" 2>&1 &
echo $! > "$C/run/gotrue.pid"

cat > "$C/postgrest.conf" <<CONF
db-uri = "postgres://authenticator:authenticator@127.0.0.1:54322/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = 54330
CONF
"$C/postgrest/postgrest" "$C/postgrest.conf" >"$C/logs/postgrest.log" 2>&1 &
echo $! > "$C/run/postgrest.pid"

LIVE_JWT_SECRET="$SECRET" "$NODE" "$LIVE/gateway.mjs" >"$C/logs/gateway.log" 2>&1 &
echo $! > "$C/run/gateway.pid"

for _ in $(seq 1 80); do
  if curl -fs -o /dev/null http://127.0.0.1:54321/auth/v1/health && curl -fs -o /dev/null http://127.0.0.1:54330/; then
    echo "READY"
    wait # keep the stack alive for as long as the run that started it
    exit 0
  fi
  sleep 0.25
done
echo "the stack did not come up; logs:" >&2
tail -n 20 "$C"/logs/*.log >&2
exit 1
