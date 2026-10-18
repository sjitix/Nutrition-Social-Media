#!/usr/bin/env bash
# The local live run's servers, fetched once as user-level binaries into a cache OUTSIDE the repo.
# No Docker and no sudo: neither exists on this laptop, and the whole point is a run anyone can repeat.
#
#   Postgres  zonky's portable build (relocatable, runs as any user)
#   GoTrue    supabase/auth's own release: the real sign-in server Supabase runs
#   PostgREST its own static release: the real REST layer Supabase runs
#   Node      to run the gateway and the mail catcher inside WSL (gateway.mjs)
#
# Idempotent: a piece already in place is not fetched again. Run inside WSL (scripts/account-live/run.mjs
# calls it for you).
set -euo pipefail

V_PG=17.11.0
V_AUTH=2.197.0
V_PGRST=16.4
V_NODE=24.13.1

C="$HOME/.cache/nutriflow-live"
mkdir -p "$C"
cd "$C"

fetch() {
  local url=$1 out=$2
  [ -s "$out" ] && return 0
  echo "fetching $url"
  curl -fsSL -o "$out.part" "$url"
  mv "$out.part" "$out"
}

if [ ! -x pg/bin/postgres ]; then
  fetch "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/$V_PG/embedded-postgres-binaries-linux-amd64-$V_PG.jar" pg.jar
  rm -rf pgjar pg && python3 -m zipfile -e pg.jar pgjar
  mkdir -p pg && tar -xJf pgjar/postgres-linux-x86_64.txz -C pg
fi

if [ ! -x auth/auth ]; then
  fetch "https://github.com/supabase/auth/releases/download/v$V_AUTH/auth-v$V_AUTH-amd64.tar.xz" auth.tar.xz
  rm -rf auth && mkdir -p auth && tar -xJf auth.tar.xz -C auth
fi

if [ ! -x postgrest/postgrest ]; then
  fetch "https://github.com/PostgREST/postgrest/releases/download/v$V_PGRST/postgrest-v$V_PGRST-linux-static-x86-64.tar.xz" postgrest.tar.xz
  rm -rf postgrest && mkdir -p postgrest && tar -xJf postgrest.tar.xz -C postgrest
fi

if [ ! -x node/bin/node ]; then
  fetch "https://nodejs.org/dist/v$V_NODE/node-v$V_NODE-linux-x64.tar.xz" node.tar.xz
  rm -rf node && mkdir -p node && tar -xJf node.tar.xz -C node --strip-components=1
fi

# The portable Postgres has no psql: db.mjs speaks SQL through the `pg` client instead, installed here,
# in the cache, so neither lane's package.json changes.
if [ ! -d node_modules/pg ]; then
  PATH="$C/node/bin:$PATH" npm install --prefix "$C" --no-audit --no-fund --silent pg@8
fi

echo "postgres:  $(pg/bin/postgres --version)"
echo "gotrue:    $(ls auth)"
echo "postgrest: $(postgrest/postgrest --version 2>&1 | head -1)"
echo "node:      $(node/bin/node --version)"
