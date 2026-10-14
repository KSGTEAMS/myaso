#!/usr/bin/env bash
# Shop platform on one Yandex Cloud VM: self-hosted Supabase (official
# docker setup, pinned release) + this app's migrations, Edge Functions and
# static site behind Caddy (automatic HTTPS). Run as root on the VM from a
# checkout of this repository. See YANDEX-CLOUD.md.
#
#   app.sh install <domain> [--email you@example.ru] [--mirror https://mirror.example]
#                                                       first installation
#   app.sh update                                       after `git pull`: functions, migrations, shops, site
#   app.sh publish <slug> [tenant:publish flags]        publish one shop (e.g. --live)
#   app.sh verify <slug>                                end-to-end checks of one shop
#   app.sh migrate | build | restart | status | logs [service] | backup | keys
set -euo pipefail

SUPABASE_REF="${SUPABASE_REF:-self-hosted/v0.8.2}"
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm}"
COMPOSE_FILES="docker-compose.yml:docker-compose.caddy.yml:docker-compose.app.yml${EXTRA_COMPOSE:+:$EXTRA_COMPOSE}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

env_get() { grep -E "^$1=" "$2" | head -n1 | cut -d= -f2-; }
env_set() { # env_set KEY VALUE FILE  (adds the key when missing)
  local k="$1" v="$2" f="$3"
  if grep -qE "^$k=" "$f"; then
    local esc; esc=$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')
    sed -i -E "s|^$k=.*$|$k=$esc|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

dc() { (cd "$SUPA_DIR" && COMPOSE_FILE="$COMPOSE_FILES" docker compose "$@"); }

network() { docker inspect supabase-db -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}'; }

# Run a repository script in a throwaway Node container attached to the
# Supabase network, talking to the gateway directly (no public round trip).
node_run() {
  local senv="$SUPA_DIR/.env" net; net=$(network)
  [ -n "$net" ] || die "Supabase network not found — is the stack running?"
  docker run --rm --network "$net" \
    -v "$REPO_DIR":/app -w /app \
    -v myaso-npm-cache:/root/.npm \
    -e SUPABASE_URL=http://api-gw:8000 \
    -e SUPABASE_ANON_KEY="$(env_get ANON_KEY "$senv")" \
    -e SUPABASE_SERVICE_ROLE_KEY="$(env_get SERVICE_ROLE_KEY "$senv")" \
    -e PUBLIC_APP_URL="$(env_get SITE_URL "$senv")" \
    "$NODE_IMAGE" bash -lc "$*"
}

ensure_deps() {
  [ -f "$REPO_DIR/node_modules/.package-lock.json" ] && [ "$REPO_DIR/node_modules/.package-lock.json" -nt "$REPO_DIR/package-lock.json" ] && return
  log "Installing npm dependencies (once per lockfile change)"
  node_run "npm ci --no-audit --no-fund"
}

vapid_keys() { # prints PUB PRIV (base64url) using openssl only
  local tmp; tmp=$(mktemp -d)
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/k.pem" 2>/dev/null
  local pub priv
  pub=$(openssl ec -in "$tmp/k.pem" -pubout -outform DER 2>/dev/null | tail -c 65 | base64 -w0 | tr '+/' '-_' | tr -d '=')
  priv=$(openssl ec -in "$tmp/k.pem" -outform DER 2>/dev/null | head -c 39 | tail -c 32 | base64 -w0 | tr '+/' '-_' | tr -d '=')
  rm -rf "$tmp"
  printf '%s %s\n' "$pub" "$priv"
}

sync_functions() {
  log "Installing Edge Functions"
  local fdir="$SUPA_DIR/volumes/functions"
  rm -rf "$fdir/_shared" "$fdir/public-api" "$fdir/ai-chat" "$fdir/notify-dispatch"
  for f in _shared public-api ai-chat notify-dispatch; do
    cp -r "$REPO_DIR/supabase/functions/$f" "$fdir/$f"
  done
  # The self-hosted runtime uses one import map for all functions.
  cat > "$fdir/deno.jsonc" <<JSON
{
  "imports": {
    "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
    "@supabase/server": "npm:@supabase/server@^1",
$(sed -n '/"imports"/,/}/p' "$REPO_DIR/supabase/functions/deno.json" | grep -E '^\s*"[^"]+":\s*"' | sed -e 's/,\s*$//' -e 's/$/,/' | sed '$ s/,$//')
  }
}
JSON
}

# Docker Hub limits anonymous pulls per IP; retry patiently instead of failing.
pull_images() {
  for attempt in 1 2 3 4 5 6; do
    if dc pull -q; then return 0; fi
    log "Image download failed (attempt $attempt/6), retrying in 60s — Docker Hub may be rate limiting"
    sleep 60
  done
  die "could not download images; configure a registry mirror: app.sh install <domain> --mirror <url>"
}

set_mirror() { # /etc/docker/daemon.json registry-mirrors
  local url="$1" f=/etc/docker/daemon.json
  mkdir -p /etc/docker
  if [ -s "$f" ] && command -v jq >/dev/null; then
    jq --arg m "$url" '.["registry-mirrors"] = [$m]' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  else
    printf '{ "registry-mirrors": ["%s"] }\n' "$url" > "$f"
  fi
  systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
  log "Docker registry mirror: $url"
}

wait_db() {
  log "Waiting for the database"
  for _ in $(seq 1 90); do
    dc exec -T db pg_isready -U postgres -h localhost >/dev/null 2>&1 && return
    sleep 2
  done
  die "database did not become ready"
}

psql_db() { dc exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }

cmd_migrate() {
  wait_db
  log "Applying migrations"
  psql_db -q -c "create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);" >/dev/null
  local applied; applied=$(psql_db -At -c "select version from supabase_migrations.schema_migrations")
  local n=0
  for f in "$REPO_DIR"/supabase/migrations/*.sql; do
    local base version name
    base=$(basename "$f" .sql); version=${base%%_*}; name=${base#*_}
    if grep -qx "$version" <<<"$applied"; then continue; fi
    log "  $base"
    { echo "begin;"; cat "$f"; echo ";"
      echo "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name');"
      echo "commit;"; } | psql_db -q >/dev/null
    n=$((n + 1))
  done
  log "  $n new migration(s)"
  # Cron -> notify-dispatch needs the gateway URL and the shared secret in Vault.
  local secret; secret=$(env_get CRON_SECRET "$SUPA_DIR/app/functions.env")
  psql_db -q >/dev/null <<SQL
do \$\$
begin
  if exists (select 1 from pg_extension where extname = 'supabase_vault') then
    if exists (select 1 from vault.secrets where name = 'project_url') then
      perform vault.update_secret((select id from vault.secrets where name = 'project_url'), 'http://api-gw:8000');
    else
      perform vault.create_secret('http://api-gw:8000', 'project_url');
    end if;
    if exists (select 1 from vault.secrets where name = 'cron_secret') then
      perform vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '$secret');
    else
      perform vault.create_secret('$secret', 'cron_secret');
    end if;
  end if;
end \$\$;
SQL
}

cmd_build() {
  ensure_deps
  log "Building the site"
  local senv="$SUPA_DIR/.env" fenv="$SUPA_DIR/app/functions.env"
  node_run "VITE_SUPABASE_URL='$(env_get SITE_URL "$senv")' \
            VITE_SUPABASE_ANON_KEY='$(env_get ANON_KEY "$senv")' \
            VITE_VAPID_PUBLIC_KEY='$(env_get VAPID_PUBLIC_KEY "$fenv")' \
            npm run build"
  # Copy new files first, then remove pages/assets that no longer exist.
  # Old hashed bundles stay one day so open tabs and old workers still load.
  local site="$SUPA_DIR/app/site"
  mkdir -p "$site"
  cp -a "$REPO_DIR/dist/." "$site/"
  (cd "$site" && find . -type f ! -path './assets/*') | while read -r rel; do
    [ -e "$REPO_DIR/dist/$rel" ] || rm -f "$site/$rel"
  done
  (cd "$site" && find ./assets -type f -mtime +1 2>/dev/null) | while read -r rel; do
    [ -e "$REPO_DIR/dist/$rel" ] || rm -f "$site/$rel"
  done
  log "Site deployed to $SUPA_DIR/app/site"
}

publish_all() {
  ensure_deps
  log "Publishing shops from tenants/registry.json"
  node_run "node -e \"for (const t of require('./tenants/registry.json').tenants) console.log(t.slug + ' ' + t.status)\"" \
    | tr -d '\r' | while read -r slug status; do
      [ -n "$slug" ] || continue
      if [ "$status" = "live" ]; then
        node_run "npx tsx scripts/tenant-publish.ts $slug --invite-owner --live --no-registry" || die "publish $slug failed"
      else
        node_run "npx tsx scripts/tenant-publish.ts $slug --invite-owner --demo --no-registry" || die "publish $slug failed"
      fi
    done
}

cmd_install() {
  local domain="${1:-}"; shift || true
  local email="" mirror=""
  while [ $# -gt 0 ]; do case "$1" in
    --email) email="$2"; shift 2 ;;
    --mirror) mirror="$2"; shift 2 ;;
    *) die "unknown option $1" ;; esac; done
  [ -n "$domain" ] || die "usage: app.sh install <domain> [--email you@example.ru]"
  [ "$(id -u)" = "0" ] || die "run as root (sudo)"

  if [ -n "$mirror" ]; then command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh; set_mirror "$mirror"; fi
  if [ ! -f "$SUPA_DIR/.env" ]; then
    log "Installing Supabase ($SUPABASE_REF) into $SUPA_DIR via the official setup script"
    local tmp; tmp=$(mktemp -d)
    curl -fsSL "https://raw.githubusercontent.com/supabase/supabase/$SUPABASE_REF/docker/setup.sh" -o "$tmp/setup.sh"
    (cd "$(dirname "$SUPA_DIR")" && sh "$tmp/setup.sh" -y --ref "$SUPABASE_REF" --project-dir "$(basename "$SUPA_DIR")")
  else
    log "Supabase already present in $SUPA_DIR — keeping its secrets"
  fi
  command -v docker >/dev/null || die "docker is missing after setup"

  local senv="$SUPA_DIR/.env" site="https://$domain"
  case "$domain" in localhost|localhost:*|http://*) site="http://${domain#http://}" ;; esac
  log "Configuring $senv"
  env_set COMPOSE_FILE "$COMPOSE_FILES" "$senv"
  env_set PROXY_DOMAIN "$domain" "$senv"
  env_set SUPABASE_PUBLIC_URL "$site" "$senv"
  env_set API_EXTERNAL_URL "$site/auth/v1" "$senv"
  env_set SITE_URL "$site" "$senv"
  env_set ADDITIONAL_REDIRECT_URLS "$site" "$senv"
  env_set DISABLE_SIGNUP true "$senv"            # owners are created by owner:invite only
  env_set ENABLE_ANONYMOUS_USERS false "$senv"
  env_set ENABLE_PHONE_SIGNUP false "$senv"
  env_set ENABLE_EMAIL_AUTOCONFIRM false "$senv"
  env_set FUNCTIONS_VERIFY_JWT false "$senv"      # functions check tokens/membership themselves
  [ -n "$email" ] && env_set CERTBOT_EMAIL "$email" "$senv"

  mkdir -p "$SUPA_DIR/app/caddy" "$SUPA_DIR/app/site"
  cp "$REPO_DIR/deploy/yandex/Caddyfile" "$SUPA_DIR/app/caddy/Caddyfile"
  cp "$REPO_DIR/deploy/yandex/docker-compose.app.yml" "$SUPA_DIR/docker-compose.app.yml"
  [ -f "$SUPA_DIR/app/site/index.html" ] || printf '<!doctype html><title>…</title>' > "$SUPA_DIR/app/site/index.html"

  local fenv="$SUPA_DIR/app/functions.env"
  if [ ! -f "$fenv" ]; then
    log "Generating application secrets ($fenv)"
    cp "$REPO_DIR/deploy/yandex/functions.env.example" "$fenv"
    read -r pub priv < <(vapid_keys)
    env_set VAPID_PUBLIC_KEY "$pub" "$fenv"
    env_set VAPID_PRIVATE_KEY "$priv" "$fenv"
    env_set CRON_SECRET "$(openssl rand -hex 32)" "$fenv"
    env_set IP_HASH_SALT "$(openssl rand -hex 16)" "$fenv"
    [ -n "$email" ] && env_set VAPID_SUBJECT "mailto:$email" "$fenv"
  fi
  env_set PUBLIC_APP_URL "$site" "$fenv"
  env_set ALLOWED_ORIGINS "$site" "$fenv"
  chmod 600 "$fenv" "$senv"

  sync_functions
  log "Starting containers (first start downloads images, a few minutes)"
  [ "${SKIP_PULL:-0}" = 1 ] || pull_images
  dc up -d
  cmd_migrate
  publish_all
  cmd_build
  dc restart caddy functions >/dev/null
  log "Done. Shops:"
  node_run "node -e \"for (const t of require('./tenants/registry.json').tenants) console.log('  $site/s/' + t.slug + '/   cabinet: $site/s/' + t.slug + '/owner/')\""
  log "Owner passwords were printed above by tenant:publish (only when an account is created)."
}

cmd_update() {
  sync_functions
  dc up -d
  cmd_migrate
  publish_all
  cmd_build
  dc restart functions caddy >/dev/null
  log "Updated."
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  update) cmd_update ;;
  migrate) cmd_migrate ;;
  build) cmd_build ;;
  publish) shift; [ -n "${1:-}" ] || die "usage: app.sh publish <slug> [flags]"; ensure_deps; node_run "npx tsx scripts/tenant-publish.ts $*" ;;
  verify) shift; [ -n "${1:-}" ] || die "usage: app.sh verify <slug>"; ensure_deps
          node_run "npx tsx scripts/tenant-verify.ts $1 --site $(env_get SITE_URL "$SUPA_DIR/.env")" ;;
  invite) shift; ensure_deps; node_run "npx tsx scripts/owner-invite.ts $*" ;;
  restart) dc up -d; dc restart functions caddy ;;
  status) dc ps ;;
  logs) shift; dc logs --tail 200 -f "$@" ;;
  backup)
    mkdir -p /opt/backups
    f="/opt/backups/db-$(date +%Y%m%d-%H%M).dump"
    dc exec -T db pg_dump -U postgres -Fc postgres > "$f"
    find /opt/backups -name 'db-*.dump' -mtime +14 -delete
    log "Backup: $f" ;;
  keys)
    echo "SITE_URL=$(env_get SITE_URL "$SUPA_DIR/.env")"
    echo "ANON_KEY=$(env_get ANON_KEY "$SUPA_DIR/.env")"
    echo "SERVICE_ROLE_KEY=<in $SUPA_DIR/.env — keep secret>"
    echo "Studio: ssh -L 3000:127.0.0.1:3000 <vm>  then http://localhost:3000"
    echo "Studio login: $(env_get DASHBOARD_USERNAME "$SUPA_DIR/.env") / see DASHBOARD_PASSWORD in $SUPA_DIR/.env" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
