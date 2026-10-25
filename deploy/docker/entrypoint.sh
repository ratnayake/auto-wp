#!/bin/sh
# Turns each file in /run/secrets/autowp/ into AUTOWP_SECRET_<NAME> (the file name is the secret name,
# so `secret:client1-agent-key` reads /run/secrets/autowp/client1-agent-key), then starts the server.
# Secret values are never passed on argv or logged.
set -eu

dir=/run/secrets/autowp
if [ -d "$dir" ]; then
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$name" in .* | README*) continue ;; esac
    var="AUTOWP_SECRET_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
    value=$(cat "$f")
    export "$var=$value"
  done
fi

if [ -f /etc/autowp-no-playwright ] && [ -z "${AUTOWP_PLAYWRIGHT:-}" ]; then
  export AUTOWP_PLAYWRIGHT=0
fi

exec node /app/apps/mcp-server/bin/auto-wp-mcp.mjs "$@"
