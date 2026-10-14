#!/usr/bin/env bash
# Downloads the self-hosted Supabase components used by the local stack into
# ./.local/bin (git-ignored): PostgREST and Supabase Auth (GoTrue). Deno is
# installed from npm. PostgreSQL 15+ with btree_gist must already be installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/.local/bin"
mkdir -p "$BIN"
POSTGREST_VERSION="v12.2.3"
AUTH_VERSION="v2.180.0"
if [ ! -x "$BIN/postgrest" ]; then
  curl -fsSL "https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-linux-static-x64.tar.xz" | tar -xJ -C "$BIN"
fi
if [ ! -x "$BIN/auth" ]; then
  curl -fsSL "https://github.com/supabase/auth/releases/download/${AUTH_VERSION}/auth-${AUTH_VERSION}-x86.tar.gz" | tar -xz -C "$BIN"
fi
command -v deno >/dev/null 2>&1 || npm install -g deno@2.9.6
echo "local stack binaries ready in $BIN"
