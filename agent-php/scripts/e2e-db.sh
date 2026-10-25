#!/usr/bin/env bash
# E2E: MariaDB 10.11 seeded with binary/unicode/NULL data; native db.dump (sliced) -> db.import into a
# fresh DB, compared by CHECKSUM TABLE and row counts; plus the mysqldump path. Runs against both DB
# drivers: mysqli (wordpress:cli-php8.3, which also has mariadb-dump) and PDO (php:8.3-cli + pdo_mysql).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
net="autowp-e2e-$$"
db="autowp-mariadb-$$"
cleanup() { docker rm -f "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap cleanup EXIT
docker network create "$net" >/dev/null
docker run -d --name "$db" --network "$net" -e MARIADB_ROOT_PASSWORD=root mariadb:10.11 >/dev/null
for i in $(seq 1 60); do
  docker exec "$db" mariadb -uroot -proot -e 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec -i "$db" mariadb -uroot -proot <<'SQL'
CREATE DATABASE src CHARACTER SET utf8mb4; CREATE DATABASE dst; CREATE DATABASE dst2;
CREATE USER 'wp'@'%' IDENTIFIED BY 'pa\'ss\\word';
GRANT ALL ON src.* TO 'wp'@'%'; GRANT ALL ON dst.* TO 'wp'@'%'; GRANT ALL ON dst2.* TO 'wp'@'%';
SET GLOBAL log_bin_trust_function_creators = 1;
SQL
docker exec -i "$db" mariadb --default-character-set=utf8mb4 -uroot -proot src < "$here/scripts/e2e/seed.sql"

run() {
  local img="$1" setup="$2"
  for d in src dst dst2; do docker exec "$db" mariadb -uroot -proot -e "DROP DATABASE IF EXISTS $d; CREATE DATABASE $d CHARACTER SET utf8mb4" ; done
  docker exec -i "$db" mariadb --default-character-set=utf8mb4 -uroot -proot src < "$here/scripts/e2e/seed.sql"
  echo "== $img"
  docker run --rm --network "$net" -v "$here:/agent:ro" "$img" sh -c "$setup && mkdir -p /tmp/w && php /agent/scripts/e2e/db-roundtrip.php /tmp/w $db"
}
run wordpress:cli-php8.3 "true"
[ -n "${ONLY_FIRST:-}" ] && exit 0
run php:8.3-cli "docker-php-ext-install pdo_mysql >/dev/null 2>&1 && apt-get update -qq >/dev/null && apt-get install -y -qq mariadb-client >/dev/null 2>&1"
