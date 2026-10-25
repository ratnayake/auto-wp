#!/usr/bin/env bash
# Runs the PHPUnit suite inside php:7.4-cli and php:8.3-cli (the agent must work on PHP 7.4-8.4).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
[ -d "$here/vendor" ] || (cd "$here" && composer install --no-interaction --quiet)
for img in ${PHP_IMAGES:-php:7.4-cli php:8.3-cli}; do
  echo "== $img"
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$repo:/repo" -w /repo/agent-php "$img" \
    php vendor/bin/phpunit --colors=never
done
