#!/usr/bin/env bash
# E2E: php -S serving the built dist/agent.php; signed request -> 200, unsigned -> 404 (and more).
# Runs with the local php and in php:7.4-cli.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
php "$here/bin/build.php" --check
echo "== local $(php -r 'echo PHP_VERSION;')"
php "$here/scripts/e2e/web.php" 18765
for img in ${PHP_IMAGES:-php:7.4-cli}; do
  echo "== $img"
  docker run --rm -u "$(id -u):$(id -g)" -v "$repo:/repo:ro" "$img" php /repo/agent-php/scripts/e2e/web.php 18766
done
