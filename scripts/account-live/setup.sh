#!/usr/bin/env bash
# The local live run's servers, fetched once as user-level binaries into a cache OUTSIDE the repo.
# No Docker and no sudo: neither exists on this laptop, and the whole point is a run anyone can repeat.
#
#   Postgres  zonky's portable build (relocatable, runs as any user)
#   GoTrue    supabase/auth's own release: the real sign-in server Supabase runs
#   PostgREST its own static release: the real REST layer Supabase runs
#   Node      to run the gateway and the mail catcher inside WSL (gateway.mjs), and db.mjs
#
# Every archive is pinned by version AND by SHA-256, and checked before anything in it runs. Each sum was
# checked against its publisher's own: nodejs.org's SHASUMS256.txt, the digests GitHub lists on the
# GoTrue and PostgREST releases, and Maven Central's .sha256 for the Postgres jar. A pin is the version
# that runs: the archive's name carries it, and each piece is unpacked into a temporary folder, stamped
# with its version LAST, then moved into place. So a bumped pin fetches the new version, and a piece
# left half-unpacked (a full disk, `wsl --shutdown` mid-way) is never taken for a finished one.
#
# Run inside WSL by scripts/account-live/run.mjs, with LIVE_REPO set (the repo as WSL sees it).
set -euo pipefail

[ "$(uname -m)" = x86_64 ] || { echo "setup.sh: the live run's servers are x86-64 builds, and this is $(uname -m)" >&2; exit 1; }
for t in curl tar xz python3 openssl flock sha256sum; do
  command -v "$t" >/dev/null || { echo "setup.sh: '$t' is missing inside WSL (sudo apt install $t)" >&2; exit 1; }
done

LIVE="${LIVE_REPO:?LIVE_REPO is not set}/scripts/account-live"

V_PG=17.11.0  SUM_PG=0dd7b72b6f335b8ecfb355fa24c5781e8a93edd09880bb77eb52ebbf29b3e96d
V_AUTH=2.197.0 SUM_AUTH=b5c2991d1df760c9b099c1c2395a94bd1c2f83ed58901934921997179dc9f7ea
V_PGRST=16.4  SUM_PGRST=b47ecc82fce1dcebbbc4183d839e52f07f7630c9d7ad0f54db753d1939299354
V_NODE=24.13.1 SUM_NODE=30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089

C="$HOME/.cache/nutriflow-live"
mkdir -p "$C/archives"
chmod 700 "$C"
cd "$C"
rm -f pg.jar auth.tar.xz postgrest.tar.xz node.tar.xz # unversioned archives from before the pins counted

# url, archive name, sha256: download unless a copy with exactly that sum is already here.
fetch() {
  local url=$1 out="archives/$2" sum=$3
  if [ -s "$out" ] && echo "$sum  $out" | sha256sum -c --quiet - >/dev/null 2>&1; then return 0; fi
  echo "setup: fetching $url"
  curl -fsSL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o "$out.part" "$url"
  if ! echo "$sum  $out.part" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -f "$out.part"
    echo "setup.sh: $url does not match its pinned SHA-256, so nothing in it will run" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}
have() { [ "$(cat "$1/.version" 2>/dev/null)" = "$2" ]; }
# The stamp is written last and the folder swapped in whole: a piece is in place only when complete.
place() { echo "$2" > "$1.new/.version"; rm -rf "$1"; mv "$1.new" "$1"; }

if ! have pg "$V_PG"; then
  fetch "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/$V_PG/embedded-postgres-binaries-linux-amd64-$V_PG.jar" "pg-$V_PG.jar" "$SUM_PG"
  rm -rf pg.new pgjar
  mkdir -p pg.new
  python3 -m zipfile -e "archives/pg-$V_PG.jar" pgjar
  tar -xJf pgjar/postgres-linux-x86_64.txz -C pg.new
  rm -rf pgjar
  place pg "$V_PG"
fi

if ! have auth "$V_AUTH"; then
  fetch "https://github.com/supabase/auth/releases/download/v$V_AUTH/auth-v$V_AUTH-amd64.tar.xz" "auth-$V_AUTH.tar.xz" "$SUM_AUTH"
  rm -rf auth.new
  mkdir -p auth.new
  tar -xJf "archives/auth-$V_AUTH.tar.xz" -C auth.new
  place auth "$V_AUTH"
fi

if ! have postgrest "$V_PGRST"; then
  fetch "https://github.com/PostgREST/postgrest/releases/download/v$V_PGRST/postgrest-v$V_PGRST-linux-static-x86-64.tar.xz" "postgrest-$V_PGRST.tar.xz" "$SUM_PGRST"
  rm -rf postgrest.new
  mkdir -p postgrest.new
  tar -xJf "archives/postgrest-$V_PGRST.tar.xz" -C postgrest.new
  place postgrest "$V_PGRST"
fi

if ! have node "$V_NODE"; then
  fetch "https://nodejs.org/dist/v$V_NODE/node-v$V_NODE-linux-x64.tar.xz" "node-$V_NODE.tar.xz" "$SUM_NODE"
  rm -rf node.new
  mkdir -p node.new
  tar -xJf "archives/node-$V_NODE.tar.xz" -C node.new --strip-components=1
  place node "$V_NODE"
fi

# The portable Postgres has no psql: db.mjs speaks SQL through the `pg` client instead. It is installed
# into the cache from the lockfile committed beside this script: exact versions, every package checked
# against the lock's integrity hash, install scripts off. Neither lane's package.json changes.
LOCK_SUM="$(sha256sum "$LIVE/pg.package-lock.json" | cut -d' ' -f1)"
if [ "$(cat .pg-client 2>/dev/null)" != "$LOCK_SUM" ]; then
  rm -f .pg-client
  cp "$LIVE/pg.package.json" package.json
  cp "$LIVE/pg.package-lock.json" package-lock.json
  PATH="$C/node/bin:$PATH" npm ci --ignore-scripts --no-audit --no-fund --silent
  echo "$LOCK_SUM" > .pg-client
fi

echo "postgres:  $(pg/bin/postgres --version)"
echo "gotrue:    $(cd auth && ./auth version 2>&1 | head -n 1)"
echo "postgrest: $(postgrest/postgrest --version 2>&1 | head -n 1)"
echo "node:      $(node/bin/node --version)"
echo "pg client: $(node/bin/node -p 'require("./node_modules/pg/package.json").version')"
