#!/bin/sh
# Runs inside wordpress:cli (as root) with the agent mounted at /agent and WordPress at /wp.
set -eu
A="php /agent/dist/agent.php"
export HOME=/tmp
fail() { echo "FAIL: $*"; exit 1; }
cd /wp
wp config create --dbname=wp --dbuser=wp --dbpass=wp --dbhost="$DBHOST" --skip-check --allow-root --quiet
wp core install --url=http://localhost --title=t --admin_user=a --admin_password=p --admin_email=a@example.com --skip-email --allow-root --quiet
wp plugin activate akismet --allow-root --quiet

inv=$(echo '{"refresh":false}' | $A --cli wp.inventory --wp-root /wp)
echo "$inv" | php -r '$e=json_decode(stream_get_contents(STDIN),true); if(!$e["ok"]) {echo json_encode($e); exit(1);} $r=$e["result"];
  $p=array_column($r["plugins"],null,"slug"); if(!isset($p["akismet"]) || !$p["akismet"]["active"] || !isset($p["hello"])) exit(2);
  if($r["core"]["version"]==="" || $r["themes"]===[] ) exit(3); echo "ok: inventory core ",$r["core"]["version"]," plugins ",count($r["plugins"])," themes ",count($r["themes"]),"\n";' || fail "inventory: $inv"

echo '{"enabled":true}' | $A --cli wp.maintenance --wp-root /wp >/dev/null
echo '{"refresh":false}' | $A --cli wp.inventory --wp-root /wp | grep -q '"ok":true' || fail "inventory under maintenance"
echo "ok: bridge bypasses .maintenance"
echo '{"enabled":false}' | $A --cli wp.maintenance --wp-root /wp >/dev/null
[ ! -e /wp/.maintenance ] || fail ".maintenance not removed"

out=$(echo '{}' | $A --cli cache.flush --wp-root /wp)
echo "$out" | grep -q objectCache || fail "cache.flush: $out"
echo "ok: cache.flush $out"

# Network-dependent: pin an older akismet, then upgrade to the latest offered version.
if php -r 'exit(@file_get_contents("https://api.wordpress.org/core/version-check/1.7/") ? 0 : 1);'; then
  out=$(echo '{"type":"plugin","slug":"akismet","version":"5.0"}' | $A --cli wp.upgrade --wp-root /wp)
  echo "$out" | grep -q '"toVersion":"5.0"' || fail "pin akismet 5.0: $out"
  echo "ok: wp.upgrade pinned: $out"
  out=$(echo '{"type":"plugin","slug":"akismet"}' | $A --cli wp.upgrade --wp-root /wp)
  echo "$out" | grep -q '"fromVersion":"5.0"' || fail "upgrade akismet: $out"
  echo "$out" | grep -q '"toVersion":"5.0"' && fail "akismet not upgraded: $out"
  wp plugin is-active akismet --allow-root || fail "akismet deactivated by upgrade"
  echo "ok: wp.upgrade latest, plugin still active: $out"
  inv=$(echo '{"refresh":true}' | $A --cli wp.inventory --wp-root /wp)
  echo "$inv" | grep -q '"ok":true' || fail "refresh inventory: $inv"
  echo "ok: inventory with refresh"
else
  echo "skip: no network for wp.upgrade"
fi

mkdir -p /wp/wp-content/mu-plugins
echo '<?php this_function_does_not_exist();' > /wp/wp-content/mu-plugins/broken.php
out=$(echo '{"refresh":false}' | $A --cli wp.inventory --wp-root /wp)
echo "$out" | grep -q '"code":"wp_fatal"' || fail "broken site: $out"
echo "ok: broken site -> wp_fatal"
echo '{}' | $A --cli db.info --wp-root /wp | grep -q '"ok":true' || fail "core action with broken WP"
echo "ok: core actions keep working with a broken WordPress"
echo "ALL OK"
