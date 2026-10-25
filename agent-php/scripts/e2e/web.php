<?php
// E2E: install dist/agent.php with bin/install.php into a temp docroot, serve it with `php -S`, and talk
// to it with requests signed by the test-vector Ed25519 seed. Usage: php web.php [port]
declare(strict_types=1);

$agentPhp = dirname(__DIR__, 2);
$vectors = json_decode((string) file_get_contents(dirname($agentPhp) . '/packages/contracts/test-vectors.json'), true);
$port = (int) ($argv[1] ?? 18765);
$base = sys_get_temp_dir() . '/autowp-web-' . bin2hex(random_bytes(4));
$docroot = "$base/public_html";
mkdir("$docroot/wp-content/uploads", 0755, true);
file_put_contents("$docroot/wp-load.php", "<?php\nundefined_function_to_simulate_a_broken_site();\n");
file_put_contents("$docroot/wp-config.php", "<?php define('DB_NAME','x'); define('DB_USER','x'); define('DB_PASSWORD','x'); define('DB_HOST','127.0.0.1:1');\n");
file_put_contents("$docroot/wp-content/uploads/hello.txt", str_repeat('hello ', 1000));

function check(bool $c, string $msg): void
{
    if (!$c) {
        fwrite(STDERR, "FAIL: $msg\n");
        exit(1);
    }
    echo "ok: $msg\n";
}

exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg("$agentPhp/bin/install.php") . ' --docroot ' . escapeshellarg($docroot)
    . ' --site-id site-agent --key-id ' . escapeshellarg($vectors['keyId'])
    . ' --ed25519-public-key ' . escapeshellarg($vectors['ed25519']['publicKeyB64'])
    . ' --allow-ip 127.0.0.1 --allow-ip ::1 --allow-insecure-http --expires-at ' . (time() + 3600) . ' 2>&1', $out, $rc);
echo implode("\n", $out), "\n";
check($rc === 0, 'installer succeeded');
check(hash_file('sha256', "$docroot/auto-wp-agent/agent.php") === hash_file('sha256', "$agentPhp/dist/agent.php"), 'deployed agent matches dist');
check(is_dir("$base/.auto-wp-agent-data"), 'data dir created outside the docroot');
check(strpos((string) file_get_contents("$docroot/auto-wp-agent/.htaccess"), 'Require all denied') !== false, '.htaccess written');
check(strpos((string) file_get_contents("$docroot/auto-wp-agent/config.php"), 'publicKey') === false, 'docroot config.php is only a pointer; keys live in the data dir');

$server = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $docroot], [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', "$base/server.log", 'w']], $pipes);
register_shutdown_function(static function () use ($server): void {
    proc_terminate($server);
});
for ($i = 0; $i < 50 && @fsockopen('127.0.0.1', $port) === false; $i++) {
    usleep(100000);
}

$kp = sodium_crypto_sign_seed_keypair(base64_decode($vectors['ed25519']['seedB64']));
$sk = sodium_crypto_sign_secretkey($kp);
$path = '/auto-wp-agent/agent.php';

/** @return array{0: int, 1: string, 2: array<string, string>} */
function post(int $port, string $path, string $body, array $headers, string $method = 'POST'): array
{
    $h = "Content-Type: application/json\r\n";
    foreach ($headers as $k => $v) {
        $h .= "$k: $v\r\n";
    }
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => $h, 'content' => $body, 'ignore_errors' => true, 'timeout' => 60]]);
    $resp = (string) @file_get_contents("http://127.0.0.1:$port$path", false, $ctx);
    preg_match('#HTTP/\S+ (\d+)#', $http_response_header[0] ?? '', $m);
    return [(int) ($m[1] ?? 0), $resp];
}

$signed = static function (array $payload, ?string $nonce = null) use ($sk, $path): array {
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES);
    $ts = (string) time();
    $nonce = $nonce ?? rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '=');
    $canon = implode("\n", ['AUTOWP-SIG-V1', 'POST', $path, $ts, $nonce, 'site-agent', hash('sha256', $body)]);
    return [$body, [
        'X-AutoWP-Site' => 'site-agent', 'X-AutoWP-Key-Id' => 'test-key-1', 'X-AutoWP-Alg' => 'ed25519',
        'X-AutoWP-Timestamp' => $ts, 'X-AutoWP-Nonce' => $nonce,
        'X-AutoWP-Signature' => base64_encode(sodium_crypto_sign_detached($canon, $sk)),
    ]];
};

[$body, $h] = $signed(['action' => 'probe', 'params' => new stdClass()]);
[$st, $resp] = post($port, $path, $body, $h);
$env = json_decode($resp, true);
check($st === 200 && ($env['ok'] ?? false) === true, "signed probe -> 200 ok");
check(($env['result']['agentSha256'] ?? '') === hash_file('sha256', "$agentPhp/dist/agent.php"), 'probe reports agent sha256');

[$st, $resp] = post($port, $path, $body, $h);
check($st === 404 && $resp === '', 'replayed request -> 404, empty body');

[$st, $resp] = post($port, $path, $body, ['Content-Type' => 'application/json']);
check($st === 404 && $resp === '', 'unsigned request -> 404, empty body');

[$b2, $h2] = $signed(['action' => 'probe', 'params' => new stdClass()]);
$h2['X-AutoWP-Signature'] = base64_encode(str_repeat("\0", 64));
[$st, $resp] = post($port, $path, $b2, $h2);
check($st === 404 && $resp === '', 'bad signature -> 404, empty body');

[$st, $resp] = post($port, $path, '', [], 'GET');
check($st === 404 && $resp === '', 'GET -> 404, empty body');

[$st, $resp] = post($port, '/auto-wp-agent/', '', [], 'GET');
check($st === 404, 'directory index -> 404');

[$body, $h] = $signed(['action' => 'fs.readChunk', 'params' => ['path' => '../.auto-wp-agent-data/audit.log.php', 'offset' => 0, 'length' => 100]]);
$env = json_decode(post($port, $path, $body, $h)[1], true);
check(($env['error']['code'] ?? '') === 'path_jail', 'data dir is jailed');

[$body, $h] = $signed(['action' => 'fs.archive', 'params' => ['sourceDir' => 'wp-content', 'dest' => 'auto-wp-backup/t/files.tar.gz']]);
$env = json_decode(post($port, $path, $body, $h)[1], true);
if (isset($env['job'])) {
    for ($i = 0; $i < 100; $i++) {
        [$body, $h] = $signed(['action' => 'job.status', 'params' => ['jobId' => $env['job']['jobId']]]);
        $s = json_decode(post($port, $path, $body, $h)[1], true);
        if ($s['result']['state'] !== 'running') {
            $env = ['ok' => true, 'result' => $s['result']['result']];
            break;
        }
    }
}
check(($env['result']['fileCount'] ?? 0) === 1, 'fs.archive over HTTP');
[$body, $h] = $signed(['action' => 'fs.testArchive', 'params' => ['path' => 'auto-wp-backup/t/files.tar.gz']]);
$env = json_decode(post($port, $path, $body, $h)[1], true);
check(($env['result']['ok'] ?? false) === true && $env['result']['entries'] === 2, 'fs.testArchive over HTTP');

[$body, $h] = $signed(['action' => 'wp.inventory', 'params' => ['refresh' => false]]);
[$st, $resp] = post($port, $path, $body, $h);
$env = json_decode($resp, true);
check($st === 200 && ($env['error']['code'] ?? '') === 'wp_fatal', 'broken WordPress -> wp_fatal JSON (' . $st . ' ' . ($env['error']['message'] ?? $resp) . ')');

[$body, $h] = $signed(['action' => 'cache.flush', 'params' => new stdClass()]);
$env = json_decode(post($port, $path, $body, $h)[1], true);
check(($env['ok'] ?? false) === true, 'cache.flush tolerates broken WordPress');

$audit = (string) file_get_contents("$base/.auto-wp-agent-data/auth-failures.log.php")
    . (string) file_get_contents("$base/.auto-wp-agent-data/audit.log.php");
check(strpos($audit, '"reason":"replay"') !== false && strpos($audit, '"reason":"bad_signature"') !== false, 'auth failures are audited');
check(strpos($audit, 'Signature') === false, 'audit log holds no signatures');
// HTTPS is required unless the config allows plain HTTP.
$cfgFile = "$base/.auto-wp-agent-data/config.php";
file_put_contents($cfgFile, str_replace("'allowInsecureHttp' => true", "'allowInsecureHttp' => false", (string) file_get_contents($cfgFile)));
[$body, $h] = $signed(['action' => 'probe', 'params' => new stdClass()]);
[$st, $resp] = post($port, $path, $body, $h);
check($st === 404 && $resp === '', 'plain HTTP without allowInsecureHttp -> 404');
echo "ALL OK\n";
