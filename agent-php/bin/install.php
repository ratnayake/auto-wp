<?php

// CLI installer: deploys dist/agent.php into <docroot>/auto-wp-agent/ with config.php, deny rules and a
// private data dir (outside the docroot when possible).
//
//   php bin/install.php --docroot /home/u/public_html --site-id my-site --key-id k1 \
//       (--ed25519-public-key <base64> | --hmac-key-file <path>) [--wp-root <path>] \
//       [--allow-ip 203.0.113.7 ...] [--expires-at 2026-12-31T00:00:00Z] [--data-dir <path>] \
//       [--outside-docroot-dir <path>] [--agent <path to agent.php>] [--config-mode 0640] [--force]
//
// Secrets are never taken from argv: the HMAC key is read from a file (or "-" for stdin).
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

function fail(string $msg): void
{
    fwrite(STDERR, "install: $msg\n");
    exit(1);
}

$opts = ['allow-ip' => []];
$flags = ['force'];
for ($i = 1; $i < count($argv); $i++) {
    $a = $argv[$i];
    if (strncmp($a, '--', 2) !== 0) {
        fail("unexpected argument $a");
    }
    $k = substr($a, 2);
    if (in_array($k, $flags, true)) {
        $opts[$k] = true;
        continue;
    }
    if (!isset($argv[$i + 1])) {
        fail("missing value for $a");
    }
    $v = $argv[++$i];
    if ($k === 'allow-ip') {
        $opts['allow-ip'][] = $v;
    } else {
        $opts[$k] = $v;
    }
}

foreach (['docroot', 'site-id', 'key-id'] as $req) {
    if (!isset($opts[$req])) {
        fail("--$req is required");
    }
}
$docroot = realpath($opts['docroot']);
if ($docroot === false || !is_dir($docroot)) {
    fail('docroot does not exist');
}
$wpRoot = realpath($opts['wp-root'] ?? $docroot);
if ($wpRoot === false || !is_file($wpRoot . '/wp-load.php')) {
    fail('wp-root does not look like a WordPress install (no wp-load.php)');
}
if (preg_match('/^[A-Za-z0-9_.-]{1,100}$/D', $opts['site-id']) !== 1 || preg_match('/^[A-Za-z0-9_.-]{1,100}$/D', $opts['key-id']) !== 1) {
    fail('site-id and key-id must match [A-Za-z0-9_.-]{1,100}');
}

$key = null;
if (isset($opts['ed25519-public-key'])) {
    $raw = base64_decode($opts['ed25519-public-key'], true);
    if ($raw === false || strlen($raw) !== 32) {
        fail('--ed25519-public-key must be 32 bytes, base64');
    }
    $key = ['alg' => 'ed25519', 'publicKey' => base64_encode($raw)];
} elseif (isset($opts['hmac-key-file'])) {
    $content = $opts['hmac-key-file'] === '-' ? stream_get_contents(STDIN) : @file_get_contents($opts['hmac-key-file']);
    $raw = base64_decode(trim((string) $content), true);
    if ($raw === false || strlen($raw) < 32) {
        fail('the HMAC key file must contain >= 32 bytes, base64');
    }
    $key = ['alg' => 'hmac-sha256', 'secret' => base64_encode($raw)];
} else {
    fail('pass --ed25519-public-key or --hmac-key-file');
}

$expires = null;
if (isset($opts['expires-at'])) {
    $expires = ctype_digit($opts['expires-at']) ? (int) $opts['expires-at'] : strtotime($opts['expires-at']);
    if ($expires === false) {
        fail('invalid --expires-at');
    }
}
foreach ($opts['allow-ip'] as $ip) {
    $addr = explode('/', $ip, 2)[0];
    if (@inet_pton($addr) === false) {
        fail("invalid --allow-ip $ip");
    }
}

$agentSrc = $opts['agent'] ?? dirname(__DIR__) . '/dist/agent.php';
if (!is_file($agentSrc)) {
    fail('agent.php not found (run php bin/build.php)');
}
$agentDir = $docroot . '/auto-wp-agent';
if (is_dir($agentDir) && !isset($opts['force'])) {
    fail("$agentDir exists (use --force to overwrite)");
}
if (!is_dir($agentDir) && !mkdir($agentDir, 0755)) {
    fail('cannot create agent directory');
}

// Private data dir: outside the docroot when possible.
if (isset($opts['data-dir'])) {
    $dataDir = $opts['data-dir'];
} else {
    $parent = dirname($docroot);
    $dataDir = is_writable($parent) ? $parent . '/.auto-wp-agent-data' : $agentDir . '/.data';
}
$old = umask(0077);
if (!is_dir($dataDir) && !mkdir($dataDir, 0700, true)) {
    fail('cannot create data dir');
}
umask($old);
$dataDir = (string) realpath($dataDir);
$denyHtaccess = "# auto-wp agent data: never web-accessible\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
    . "<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n";
$denyWebConfig = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<configuration>\n  <system.webServer>\n    <security>\n"
    . "      <authorization>\n        <remove users=\"*\" roles=\"\" verbs=\"\" />\n        <add accessType=\"Deny\" users=\"*\" />\n"
    . "      </authorization>\n    </security>\n  </system.webServer>\n</configuration>\n";
if (strncmp($dataDir . '/', $docroot . '/', strlen($docroot) + 1) === 0) {
    file_put_contents($dataDir . '/.htaccess', $denyHtaccess);
    file_put_contents($dataDir . '/web.config', $denyWebConfig);
    file_put_contents($dataDir . '/index.php', "<?php http_response_code(404);\n");
    fwrite(STDERR, "warning: data dir is inside the docroot ($dataDir); deny rules written. Verify it returns 403/404 over HTTP.\n");
}

$config = [
    'siteId' => $opts['site-id'],
    'wpRoot' => $wpRoot,
    'docroot' => $docroot,
    'dataDir' => $dataDir,
    'keys' => [$opts['key-id'] => $key],
    'ipAllowlist' => array_values($opts['allow-ip']),
    'expires_at' => $expires,
];
if (isset($opts['outside-docroot-dir'])) {
    $od = realpath($opts['outside-docroot-dir']);
    if ($od === false) {
        fail('outside-docroot-dir does not exist');
    }
    $config['outsideDocrootDir'] = $od;
}

$configPhp = "<?php\n// auto-wp agent configuration (written by bin/install.php)\nreturn " . var_export($config, true) . ";\n";
$mode = octdec($opts['config-mode'] ?? '0640');
$tmp = $agentDir . '/config.php.tmp';
$old = umask(0077);
file_put_contents($tmp, $configPhp);
umask($old);
chmod($tmp, $mode);
rename($tmp, $agentDir . '/config.php');

copy($agentSrc, $agentDir . '/agent.php');
chmod($agentDir . '/agent.php', 0644);
file_put_contents($agentDir . '/index.php', "<?php http_response_code(404);\n");
file_put_contents($agentDir . '/.htaccess', "# auto-wp agent: deny everything except the entry points\n"
    . "<IfModule mod_authz_core.c>\n  Require all denied\n  <FilesMatch \"^(agent\\.php|index\\.php|web\\.config)$\">\n    Require all granted\n  </FilesMatch>\n</IfModule>\n"
    . "<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n  <FilesMatch \"^(agent\\.php|index\\.php|web\\.config)$\">\n    Order allow,deny\n    Allow from all\n  </FilesMatch>\n</IfModule>\n");
file_put_contents($agentDir . '/web.config', "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<configuration>\n  <system.webServer>\n"
    . "    <directoryBrowse enabled=\"false\" />\n    <security>\n      <requestFiltering>\n"
    . "        <hiddenSegments>\n          <add segment=\"config.php\" />\n          <add segment=\".data\" />\n        </hiddenSegments>\n"
    . "        <fileExtensions allowUnlisted=\"false\">\n          <add fileExtension=\".php\" allowed=\"true\" />\n        </fileExtensions>\n"
    . "      </requestFiltering>\n    </security>\n  </system.webServer>\n</configuration>\n");

echo "installed: $agentDir/agent.php\n";
echo 'sha256: ' . hash_file('sha256', $agentDir . '/agent.php') . "\n";
echo "data dir: $dataDir\n";
echo "endpoint path: /" . ltrim(substr($agentDir, strlen($docroot)), '/') . "/agent.php\n";
