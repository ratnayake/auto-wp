<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Config;
use AutoWp\Agent\Security\AuthFailure;
use AutoWp\Agent\Security\NonceStore;
use AutoWp\Agent\Security\RequestVerifier;

final class RequestVerifierTest extends TestCase
{
    /** @return array<string, array{0: string, 1: bool}> */
    public function algs(): array
    {
        return [
            'ed25519 (ext-sodium)' => ['ed25519', false],
            'ed25519 (sodium_compat)' => ['ed25519', true],
            'hmac-sha256' => ['hmac-sha256', false],
        ];
    }

    private function verifier(string $alg, bool $compat, ?string $nonceFile = null, array $extra = []): RequestVerifier
    {
        $v = self::vectors();
        $dir = $this->tmpDir();
        $key = $alg === 'ed25519'
            ? ['alg' => 'ed25519', 'publicKey' => $v['ed25519']['publicKeyB64']]
            : ['alg' => 'hmac-sha256', 'secret' => $v['hmac']['keyB64']];
        $config = Config::fromArray($extra + [
            'siteId' => 'site-agent',
            'wpRoot' => $dir,
            'dataDir' => $dir . '/data',
            'keys' => [$v['keyId'] => $key],
        ]);
        $now = (int) $v['serverTime'];
        return new RequestVerifier($config, new NonceStore($nonceFile ?? $dir . '/nonces.php'), static function () use ($now): int {
            return $now;
        }, $compat);
    }

    /**
     * @param array<string, mixed> $r
     * @return array<string, string>
     */
    private static function headers(array $r, string $alg, ?string $keyId = null): array
    {
        $v = self::vectors();
        return [
            'x-autowp-site' => $r['siteId'],
            'x-autowp-key-id' => $keyId ?? $v['keyId'],
            'x-autowp-alg' => $alg,
            'x-autowp-timestamp' => (string) $r['timestamp'],
            'x-autowp-nonce' => $r['nonce'],
            'x-autowp-signature' => $alg === 'ed25519' ? $r['ed25519SignatureB64'] : $r['hmacSha256SignatureB64'],
        ];
    }

    /** @dataProvider algs */
    public function testCanonicalStringsMatchVectors(string $alg, bool $compat): void
    {
        foreach (self::vectors()['requests'] as $r) {
            $c = RequestVerifier::canonical($r['method'], $r['path'], (string) $r['timestamp'], $r['nonce'], $r['siteId'], $r['body']);
            self::assertSame($r['canonical'], $c, $r['name']);
        }
    }

    /** @dataProvider algs */
    public function testAcceptsEveryVectorRequest(string $alg, bool $compat): void
    {
        foreach (self::vectors()['requests'] as $r) {
            $verifier = $this->verifier($alg, $compat);
            $keyId = $verifier->verify($r['method'], $r['path'], self::headers($r, $alg), $r['body'], '127.0.0.1');
            self::assertSame(self::vectors()['keyId'], $keyId, $r['name']);
        }
    }

    /** @dataProvider algs */
    public function testRejectionCases(string $alg, bool $compat): void
    {
        foreach (self::vectors()['rejections'] as $case) {
            $r = $case['request'];
            $verifier = $this->verifier($alg, $compat);
            $headers = self::headers($r, $alg, $case['keyId'] ?? null);
            $call = static function () use ($verifier, $r, $headers): void {
                $verifier->verify($r['method'], $r['path'], $headers, $r['body'], '127.0.0.1');
            };
            if ($case['expect'] === 'accept') {
                $call();
                self::assertTrue(true);
                continue;
            }
            if ($case['expect'] === 'reject-second') {
                $call();
            }
            try {
                $call();
                self::fail('expected rejection: ' . $case['name']);
            } catch (AuthFailure $e) {
                self::assertNotSame('', $e->getReason(), $case['name']);
            }
        }
    }

    public function testRejectsAlgorithmConfusion(): void
    {
        $r = self::vectors()['requests'][0];
        $verifier = $this->verifier('ed25519', false);
        $h = self::headers($r, 'hmac-sha256');
        $this->expectException(AuthFailure::class);
        $verifier->verify('POST', $r['path'], $h, $r['body'], '127.0.0.1');
    }

    public function testIpAllowlistAndExpiryComeFirst(): void
    {
        $r = self::vectors()['requests'][0];
        $now = (int) self::vectors()['serverTime'];
        foreach ([['ipAllowlist' => ['10.0.0.0/8']], ['expires_at' => $now]] as $extra) {
            $verifier = $this->verifier('ed25519', false, null, $extra);
            try {
                $verifier->verify('POST', $r['path'], self::headers($r, 'ed25519'), $r['body'], '127.0.0.1');
                self::fail('expected rejection');
            } catch (AuthFailure $e) {
                self::assertContains($e->getReason(), ['ip_not_allowed', 'expired']);
            }
        }
        $ok = $this->verifier('ed25519', false, null, ['ipAllowlist' => ['127.0.0.0/8', '::1'], 'expires_at' => $now + 1]);
        $ok->verify('POST', $r['path'], self::headers($r, 'ed25519'), $r['body'], '127.0.0.1');
        self::assertTrue(true);
    }

    public function testRejectsGetAndOversizeAndMissingHeaders(): void
    {
        $r = self::vectors()['requests'][0];
        $cases = [
            ['GET', self::headers($r, 'ed25519'), $r['body']],
            ['POST', array_diff_key(self::headers($r, 'ed25519'), ['x-autowp-nonce' => 1]), $r['body']],
            ['POST', self::headers($r, 'ed25519'), str_repeat('x', 1025)],
        ];
        foreach ($cases as [$method, $h, $body]) {
            $verifier = $this->verifier('ed25519', false, null, ['maxBodyBytes' => 1024]);
            try {
                $verifier->verify($method, $r['path'], $h, $body, '127.0.0.1');
                self::fail('expected rejection');
            } catch (AuthFailure $e) {
                self::assertTrue(true);
            }
        }
    }

    public function testRejectsWrongPath(): void
    {
        $r = self::vectors()['requests'][0];
        $this->expectException(AuthFailure::class);
        $this->verifier('ed25519', false)->verify('POST', '/other/agent.php', self::headers($r, 'ed25519'), $r['body'], '127.0.0.1');
    }
}
