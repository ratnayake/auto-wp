# Shared by up.sh / seed.sh / down.sh. Source, don't execute.
E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$E2E/.." && pwd)"
TMP="$E2E/.tmp"
export COMPOSE_PROJECT_NAME=autowp-e2e
export COMPOSE_PROGRESS=quiet
dc() { docker compose -f "$E2E/docker-compose.yml" "$@"; }

port_free() { # IPv4 and IPv6 listeners; ss sees both, /dev/tcp is the fallback
  if command -v ss >/dev/null; then ! ss -ltnH "sport = :$1" | grep -q .; return; fi
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && ! (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null
}
PICKED=" "
PICKED_PORT=""
pick_port() { # pick_port <preferred>: sets PICKED_PORT to the first free, not-yet-picked port >= <preferred>. No subshell.
  local p=$1
  until port_free "$p" && [[ "$PICKED" != *" $p "* ]]; do p=$((p + 1)); done
  PICKED="$PICKED$p "
  PICKED_PORT=$p
}
load_ports() { [ -f "$TMP/ports.env" ] && . "$TMP/ports.env"; : "${AUTOWP_PORT_SSH_HTTP:=8080}" "${AUTOWP_PORT_LOCKED_HTTP:=8081}" "${AUTOWP_PORT_FEEDS:=8090}" "${AUTOWP_PORT_SSH:=2222}"; export AUTOWP_PORT_SSH_HTTP AUTOWP_PORT_LOCKED_HTTP AUTOWP_PORT_FEEDS AUTOWP_PORT_SSH; }

wp_ssh() { dc exec -T -u cpuser wp-ssh wp --path=/var/www/html "$@"; }
wp_locked() { dc run --rm -T wpcli-locked wp --path=/var/www/html "$@"; }
