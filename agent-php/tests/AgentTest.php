<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Actions\SiteActions;
use AutoWp\Agent\Agent;
use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\Jobs\JobHandler;
use AutoWp\Agent\Jobs\JobRunner;
use AutoWp\Agent\Security\RequestVerifier;

final class AgentTest extends TestCase
{
    /** @return array{0: Agent, 1: array<string, mixed>} */
    private function webAgent(): array
    {
        $v = self::vectors();
        $now = (int) $v['serverTime'];
        $s = $this->site(
            ['keys' => [$v['keyId'] => ['alg' => 'ed25519', 'publicKey' => $v['ed25519']['publicKeyB64']]]],
            Context::MODE_WEB,
            static function () use ($now): int {
                return $now;
            }
        );
        return [new Agent($s['ctx']), $s];
    }

    /** @param array<string, mixed> $r */
    private static function server(array $r, ?string $sig = null): array
    {
        return [
            'REQUEST_METHOD' => $r['method'],
            'REQUEST_URI' => $r['path'] . '?ignored=1',
            'REMOTE_ADDR' => '203.0.113.9',
            'HTTP_X_AUTOWP_SITE' => $r['siteId'],
            'HTTP_X_AUTOWP_KEY_ID' => self::vectors()['keyId'],
            'HTTP_X_AUTOWP_ALG' => 'ed25519',
            'HTTP_X_AUTOWP_TIMESTAMP' => (string) $r['timestamp'],
            'HTTP_X_AUTOWP_NONCE' => $r['nonce'],
            'HTTP_X_AUTOWP_SIGNATURE' => $sig ?? $r['ed25519SignatureB64'],
        ];
    }

    /** Signs an arbitrary body with the test-vector seed. */
    private static function sign(string $body, string $nonce): array
    {
        $v = self::vectors();
        $kp = sodium_crypto_sign_seed_keypair((string) base64_decode($v['ed25519']['seedB64']));
        $r = ['method' => 'POST', 'path' => '/auto-wp-agent/agent.php', 'siteId' => 'site-agent', 'timestamp' => $v['serverTime'], 'nonce' => $nonce, 'body' => $body];
        $c = RequestVerifier::canonical('POST', $r['path'], (string) $r['timestamp'], $nonce, 'site-agent', $body);
        $r['ed25519SignatureB64'] = base64_encode(sodium_crypto_sign_detached($c, sodium_crypto_sign_secretkey($kp)));
        return $r;
    }

    public function testSignedVectorRequestsAreServed(): void
    {
        [$agent, $s] = $this->webAgent();
        foreach (self::vectors()['requests'] as $r) {
            [$status, $body] = $agent->handleWeb(self::server($r), $r['body']);
            self::assertSame(200, $status, $r['name']);
            $env = json_decode($body, true);
            self::assertIsArray($env);
            if ($r['name'] === 'probe') {
                self::assertTrue($env['ok']);
                self::assertSame($s['wp'], $env['result']['wpRoot']);
                self::assertIsArray($env['result']['binaries']);
            }
            if ($r['name'] === 'unicode-body') {
                self::assertSame(['ok' => true, 'result' => null], $env);
            }
            if ($r['name'] === 'db-dump') {
                self::assertFalse($env['ok']);
                self::assertSame('capability', $env['error']['code']); // no wp-config.php here
            }
        }
        $log = (string) file_get_contents($s['root'] . '/data/audit.log.php');
        self::assertStringContainsString('"action":"probe"', $log);
    }

    public function testUnsignedTamperedAndReplayedGet404WithEmptyBody(): void
    {
        [$agent] = $this->webAgent();
        $r = self::vectors()['requests'][0];
        $unsigned = self::server($r);
        unset($unsigned['HTTP_X_AUTOWP_SIGNATURE']);
        self::assertSame([404, ''], $agent->handleWeb($unsigned, $r['body']));
        self::assertSame([404, ''], $agent->handleWeb(self::server($r), $r['body'] . ' '));
        self::assertSame(200, $agent->handleWeb(self::server($r), $r['body'])[0]);
        self::assertSame([404, ''], $agent->handleWeb(self::server($r), $r['body']));
        $get = self::server($r);
        $get['REQUEST_METHOD'] = 'GET';
        self::assertSame([404, ''], $agent->handleWeb($get, $r['body']));
    }

    public function testStep7ErrorsAreJson(): void
    {
        [$agent] = $this->webAgent();
        $cases = [
            ['{"action":"nope","params":{}}', 'unknown_action'],
            ['{"action":"fs.stat","params":{"path":"x","extra":1}}', 'invalid_params'],
            ['{"action":"fs.stat","params":{"path":"../../etc/passwd"}}', 'path_jail'],
            ['{"action":"fs.readChunk","params":{"path":"x","offset":0,"length":9999999999}}', 'invalid_params'],
            ['not json', 'bad_request'],
        ];
        foreach ($cases as $i => [$body, $code]) {
            $r = self::sign($body, str_pad('n' . $i, 22, 'x'));
            [$status, $out] = $agent->handleWeb(self::server($r), $body);
            self::assertSame(200, $status);
            $env = json_decode($out, true);
            self::assertFalse($env['ok'], $body);
            self::assertSame($code, $env['error']['code'], $body);
        }
    }

    public function testFsRoundTripThroughDispatch(): void
    {
        $s = $this->site();
        $agent = new Agent($s['ctx']);
        $data = random_bytes(5000);
        $agent->dispatch('fs.writeChunk', ['path' => 'wp-content/x/file.bin', 'offset' => 0, 'dataB64' => base64_encode(substr($data, 0, 3000)), 'truncate' => true]);
        $agent->dispatch('fs.writeChunk', ['path' => 'wp-content/x/file.bin', 'offset' => 3000, 'dataB64' => base64_encode(substr($data, 3000))]);
        $r = $agent->dispatch('fs.readChunk', ['path' => 'wp-content/x/file.bin', 'offset' => 1000, 'length' => 10000])['result'];
        self::assertSame(substr($data, 1000), base64_decode($r['dataB64']));
        self::assertTrue($r['eof']);
        self::assertSame(5000, $r['size']);
        $list = $agent->dispatch('fs.list', ['path' => '.'])['result'];
        self::assertSame(['wp-content'], array_column($list, 'path'), 'agent dir is hidden from listings');
        $agent->dispatch('fs.rename', ['from' => 'wp-content/x/file.bin', 'to' => 'wp-content/y.bin']);
        self::assertSame('file', $agent->dispatch('fs.stat', ['path' => 'wp-content/y.bin'])['result']['type']);
        $sha = $agent->dispatch('fs.sha256', ['path' => 'wp-content/y.bin'])['result'];
        self::assertSame(hash('sha256', $data), $sha['sha256']);
        $agent->dispatch('fs.remove', ['path' => 'wp-content', 'recursive' => true]);
        self::assertNull($agent->dispatch('fs.stat', ['path' => 'wp-content'])['result']);
        foreach ([['fs.remove', ['path' => '.', 'recursive' => true]], ['fs.rename', ['from' => '.', 'to' => '../x']]] as [$a, $p]) {
            try {
                $agent->dispatch($a, $p);
                self::fail("$a must refuse");
            } catch (AgentException $e) {
                self::assertSame('path_jail', $e->getErrorCode());
            }
        }
        self::assertFileExists($s['wp'] . '/auto-wp-agent/agent.php');
    }

    public function testJobRunnerSlicesAndStatus(): void
    {
        $s = $this->site([], Context::MODE_WEB);
        $h = new class implements JobHandler {
            public function init(array $params, Context $ctx): array
            {
                return ['n' => 0, 'name' => "bin\xff\xfename"];
            }

            public function step(array &$state, Context $ctx, float $deadline)
            {
                $state['n']++;
                return $state['n'] >= 3 ? ['n' => $state['n'], 'name' => bin2hex($state['name'])] : null;
            }

            public function progress(array $state): array
            {
                return ['done' => $state['n'], 'total' => 3];
            }
        };
        $runner = new JobRunner($s['ctx'], ['fs.count' => $h]);
        $start = $runner->start('fs.count', []);
        $id = $start['job']['jobId'];
        self::assertMatchesRegularExpression('/^[a-f0-9]{32}$/', $id);
        self::assertSame('running', $runner->status($id)['state']);
        $done = $runner->status($id);
        self::assertSame('done', $done['state']);
        self::assertSame(['n' => 3, 'name' => bin2hex("bin\xff\xfename")], $done['result']);
        $this->expectException(AgentException::class);
        $runner->status('../../etc/passwd');
    }

    public function testMaintenanceFile(): void
    {
        $s = $this->site();
        $token = str_repeat('Ab3_', 6);
        SiteActions::maintenance(['enabled' => true, 'bypassToken' => $token], $s['ctx']);
        $php = (string) file_get_contents($s['wp'] . '/.maintenance');
        self::assertSame("<?php \$upgrading = (isset(\$_COOKIE['autowp_bypass']) && hash_equals('$token', (string) \$_COOKIE['autowp_bypass'])) ? 0 : time();\n", $php);
        $lint = shell_exec(escapeshellarg(PHP_BINARY) . ' -l ' . escapeshellarg($s['wp'] . '/.maintenance') . ' 2>&1');
        self::assertStringContainsString('No syntax errors', (string) $lint);
        SiteActions::maintenance(['enabled' => true, 'bypassToken' => null], $s['ctx']);
        self::assertSame("<?php \$upgrading = time();\n", file_get_contents($s['wp'] . '/.maintenance'));
        try {
            SiteActions::maintenance(['enabled' => true, 'bypassToken' => "x'); system('id'); //"], $s['ctx']);
            self::fail('injection must be refused');
        } catch (AgentException $e) {
            self::assertSame('invalid_params', $e->getErrorCode());
        }
        SiteActions::maintenance(['enabled' => false, 'bypassToken' => null], $s['ctx']);
        self::assertFileDoesNotExist($s['wp'] . '/.maintenance');
    }

    public function testLogsTailWithRotation(): void
    {
        $s = $this->site();
        file_put_contents($s['wp'] . '/debug.log', "line1\nline2 ünï\n");
        $r = SiteActions::logsTail(['path' => 'debug.log', 'fromOffset' => 0, 'maxBytes' => 13], $s['ctx']);
        self::assertSame("line1\nline2 \xc3", substr("line1\nline2 ü", 0, 13));
        self::assertSame("line1\nline2 ", $r['data'], 'partial UTF-8 sequence is held back');
        $r2 = SiteActions::logsTail(['path' => 'debug.log', 'fromOffset' => $r['nextOffset'], 'maxBytes' => 100], $s['ctx']);
        self::assertSame("ünï\n", $r2['data']);
        self::assertFalse($r2['rotated']);
        file_put_contents($s['wp'] . '/debug.log', "new\n");
        $r3 = SiteActions::logsTail(['path' => 'debug.log', 'fromOffset' => $r2['nextOffset'], 'maxBytes' => 100], $s['ctx']);
        self::assertTrue($r3['rotated']);
        self::assertSame("new\n", $r3['data']);
        self::assertSame(4, $r3['nextOffset']);
    }

    public function testLocks(): void
    {
        $now = 1000;
        $s = $this->site([], Context::MODE_CLI, static function () use (&$now): int {
            return $now;
        });
        $a = SiteActions::lockAcquire(['runId' => 'run-a', 'ttlSec' => 60], $s['ctx']);
        self::assertTrue($a['acquired']);
        $b = SiteActions::lockAcquire(['runId' => 'run-b', 'ttlSec' => 60], $s['ctx']);
        self::assertFalse($b['acquired']);
        self::assertSame('run-a', $b['holder']);
        self::assertFalse(SiteActions::lockRelease(['runId' => 'run-b'], $s['ctx'])['released']);
        $now = 1061;
        self::assertTrue(SiteActions::lockAcquire(['runId' => 'run-b', 'ttlSec' => 60], $s['ctx'])['acquired']);
        self::assertTrue(SiteActions::lockRelease(['runId' => 'run-b'], $s['ctx'])['released']);
        self::assertFileExists($s['wp'] . '/auto-wp-backup/.htaccess');
    }
}
