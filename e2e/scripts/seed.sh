#!/usr/bin/env bash
# Seeds both WordPress containers with a known, deliberately outdated site.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_ports

PLUGINS=/var/www/html/wp-content/plugins
MU=/var/www/html/wp-content/mu-plugins

for d in wp_ssh wp_locked; do
  dc exec -T db mariadb -uroot -proot -e "DROP DATABASE IF EXISTS $d; CREATE DATABASE $d"
done

seed_site() { # seed_site <wp fn> <db> <url> <title>
  local wp=$1 db=$2 url=$3 title=$4
  $wp core download --version=6.5.2 --force
  $wp config create --dbname="$db" --dbuser=root --dbpass=root --dbhost=db --force --skip-check --extra-php <<'PHP'
define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', false);
define('WP_AUTO_UPDATE_CORE', false);
PHP
  $wp core install --url="$url" --title="$title" --admin_user=admin --admin_password=admin-e2e-pass \
    --admin_email=admin@example.test --skip-email
  $wp plugin install contact-form-7 --version=5.7 --activate
  $wp plugin install classic-editor --version=1.6.3 --activate
  $wp theme install twentytwentyfour --version=1.0 --force --activate
  for i in 1 2 3; do
    $wp post create --post_title="Sample post $i" --post_content="Body of sample post $i." --post_status=publish
  done
  for i in 1 2; do
    $wp post create --post_type=page --post_title="Sample page $i" --post_content="Body of page $i." --post_status=publish
  done
}

tar_in() { tar -C "$1" -c "$2"; }

# --- wp-ssh ---
seed_site wp_ssh wp_ssh "http://localhost:$AUTOWP_PORT_SSH_HTTP" "AutoWP E2E SSH"
tar_in "$E2E/fixtures/plugins" autowp-breaker | dc exec -T -u cpuser wp-ssh tar -x -C "$PLUGINS"
dc exec -T -u cpuser wp-ssh mkdir -p "$MU"
tar_in "$E2E/fixtures/mu-plugins" fake-updates.php | dc exec -T -u cpuser wp-ssh tar -x -C "$MU"
wp_ssh plugin activate autowp-breaker

# --- wp-locked ---
seed_site wp_locked wp_locked "http://127.0.0.1:$AUTOWP_PORT_LOCKED_HTTP" "AutoWP E2E Locked"
tar_in "$E2E/fixtures/plugins" autowp-breaker | dc run --rm -T wpcli-locked tar -x -C "$PLUGINS"
dc run --rm -T wpcli-locked mkdir -p "$MU"
tar_in "$E2E/fixtures/mu-plugins" fake-updates.php | dc run --rm -T wpcli-locked tar -x -C "$MU"
wp_locked plugin activate autowp-breaker
# HTTP-served probe proving exec() is disabled for web requests.
cat "$E2E/fixtures/autowp-probe.php" | dc run --rm -T wpcli-locked sh -c 'cat > /var/www/html/autowp-probe.php'

# --- agent (agent-php/; override the location with AUTOWP_AGENT_PHP_DIR) ---
rm -f "$TMP/agent-installed"
AGENT_DIR="${AUTOWP_AGENT_PHP_DIR:-$ROOT/agent-php}"
if [ -f "$AGENT_DIR/dist/agent.php" ] && [ -f "$AGENT_DIR/bin/install.php" ]; then
  VEC="$ROOT/packages/contracts/test-vectors.json"
  PUB=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ed25519']['publicKeyB64'])" "$VEC")
  KEYID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['keyId'])" "$VEC")
  # Run as www-data (uid 33) in a php container sharing the wp-locked volume; deploys <docroot>/auto-wp-agent/.
  # Only the docroot is a volume, so the agent's data dir has to live inside it (denied by .htaccess), and
  # the test site is plain http on loopback.
  docker run --rm -u 33:33 -v "autowp-e2e_locked-html:/var/www/html" -v "$AGENT_DIR:/agent-php:ro" php:8.4-cli \
    php /agent-php/bin/install.php --docroot /var/www/html --site-id site-agent --key-id "$KEYID" \
    --ed25519-public-key "$PUB" --allow-data-in-docroot --allow-insecure-http --force &&
    touch "$TMP/agent-installed"
else
  echo "agent-php not built; agent scenarios will be skipped"
fi
echo "seed done"
