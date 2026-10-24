#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
load_ports
dc --profile tools down -v --remove-orphans || true
[ -f "$TMP/agent.pid" ] && kill "$(cat "$TMP/agent.pid")" 2>/dev/null || true
rm -rf "$TMP"
