#!/usr/bin/env bash
# E2E: the WordPress bridge (wp.inventory / wp.upgrade / cache.flush / wp_fatal) against a real
# WordPress (source from wordpress:php8.3-apache) on MariaDB 10.11, via dist/agent.php in CLI mode.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
net="autowp-wp-$$"; db="autowp-wpdb-$$"; vol="autowp-wpsrc-$$"
cleanup() { docker rm -f "$db" >/dev/null 2>&1 || true; docker volume rm "$vol" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$net" >/dev/null
docker volume create "$vol" >/dev/null
docker run -d --name "$db" --network "$net" -e MARIADB_ROOT_PASSWORD=root -e MARIADB_DATABASE=wp -e MARIADB_USER=wp -e MARIADB_PASSWORD=wp mariadb:10.11 >/dev/null
docker run --rm -v "$vol:/out" wordpress:php8.3-apache sh -c 'cp -a /usr/src/wordpress/. /out/'
for i in $(seq 1 60); do docker exec "$db" mariadb -uwp -pwp -e 'SELECT 1' wp >/dev/null 2>&1 && break; sleep 1; done
docker run --rm --network "$net" -u 0 -e DBHOST="$db" -v "$vol:/wp" -v "$here:/agent:ro" wordpress:cli-php8.3 sh /agent/scripts/e2e/wp-bridge.sh
