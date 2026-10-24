#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
mkdir -p "$TMP" "$E2E/.cache/wp-cli"
START=$(date +%s)

# Free host ports (defaults 8080/8081/8090/2222; bumped if something else holds them).
if [ ! -f "$TMP/ports.env" ]; then
  # no subshells: pick_port records choices in $PICKED
  p1=$(pick_port 8080); PICKED="$PICKED$p1 "
  p2=$(pick_port 8081); PICKED="$PICKED$p2 "
  p3=$(pick_port 8090); PICKED="$PICKED$p3 "
  p4=$(pick_port 2222)
  printf 'AUTOWP_PORT_SSH_HTTP=%s\nAUTOWP_PORT_LOCKED_HTTP=%s\nAUTOWP_PORT_FEEDS=%s\nAUTOWP_PORT_SSH=%s\n' "$p1" "$p2" "$p3" "$p4" >"$TMP/ports.env"
fi
load_ports

[ -f "$TMP/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C autowp-e2e -f "$TMP/id_ed25519"
[ -f "$E2E/.cache/wp-cli/wp-cli.phar" ] ||
  curl -fsSL -o "$E2E/.cache/wp-cli/wp-cli.phar" https://github.com/wp-cli/builds/raw/gh-pages/phar/wp-cli.phar
"$E2E/scripts/build-fixtures.sh"

dc up -d --build --wait

# Pin the host key sshd generated at first start.
for _ in $(seq 1 20); do
  ssh-keyscan -p "$AUTOWP_PORT_SSH" -t ed25519 localhost 2>/dev/null >"$TMP/known_hosts" && [ -s "$TMP/known_hosts" ] && break
  sleep 1
done
[ -s "$TMP/known_hosts" ] || { echo "ssh-keyscan failed" >&2; exit 1; }
FPR=$(ssh-keygen -lf "$TMP/known_hosts" | awk '{print $2}')

"$E2E/scripts/seed.sh"

# ssh-agent with the key loaded (for the MCP server's SSH transport).
if [ -f "$TMP/agent.pid" ] && kill -0 "$(cat "$TMP/agent.pid")" 2>/dev/null; then :; else
  eval "$(ssh-agent -s -a "$TMP/agent.sock")" >/dev/null
  echo "$SSH_AGENT_PID" >"$TMP/agent.pid"
  ssh-add -q "$TMP/id_ed25519"
fi

VEC="$ROOT/packages/contracts/test-vectors.json"
SEED=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ed25519']['seedB64'])" "$VEC")
KEYID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['keyId'])" "$VEC")

cat >"$TMP/config.yaml" <<YAML
stateDir: $TMP/state
dataDir: $TMP/data
vulndb:
  wordfenceFeedUrl: http://127.0.0.1:$AUTOWP_PORT_FEEDS/wordfence-v3.json
sites:
  - id: site-ssh
    name: E2E SSH site
    url: http://localhost:$AUTOWP_PORT_SSH_HTTP
    transport:
      kind: ssh
      host: localhost
      port: $AUTOWP_PORT_SSH
      username: cpuser
      hostKeySha256: "$FPR"
      wpRoot: /var/www/html
  - id: site-agent
    name: E2E agent site (exec disabled)
    url: http://127.0.0.1:$AUTOWP_PORT_LOCKED_HTTP
    transport:
      kind: agent
      endpoint: http://127.0.0.1:$AUTOWP_PORT_LOCKED_HTTP/auto-wp-agent/agent.php
      keyId: $KEYID
      signingKeyRef: secret:site-agent-signing-key
      algorithm: ed25519
      insecureHttpLoopback: true
YAML

cat >"$TMP/env" <<ENV
AUTOWP_CONFIG=$TMP/config.yaml
AUTOWP_WORDFENCE_FEED_URL=http://127.0.0.1:$AUTOWP_PORT_FEEDS/wordfence-v3.json
AUTOWP_TEST_APPROVE=1
AUTOWP_SECRET_SITE_AGENT_SIGNING_KEY=$SEED
SSH_AUTH_SOCK=$TMP/agent.sock
AUTOWP_E2E=1
AUTOWP_E2E_AGENT=$([ -f "$TMP/agent-installed" ] && echo 1 || echo 0)
AUTOWP_E2E_DIR=$E2E
AUTOWP_E2E_KNOWN_HOSTS=$TMP/known_hosts
AUTOWP_E2E_KEY=$TMP/id_ed25519
AUTOWP_E2E_HOST_FPR=$FPR
AUTOWP_E2E_PORT_SSH_HTTP=$AUTOWP_PORT_SSH_HTTP
AUTOWP_E2E_PORT_LOCKED_HTTP=$AUTOWP_PORT_LOCKED_HTTP
AUTOWP_E2E_PORT_FEEDS=$AUTOWP_PORT_FEEDS
AUTOWP_E2E_PORT_SSH=$AUTOWP_PORT_SSH
ENV
chmod 600 "$TMP/env"
echo "e2e env up in $(( $(date +%s) - START ))s; source $TMP/env"
