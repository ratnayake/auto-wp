<?php

declare(strict_types=1);

namespace AutoWp\Agent\Security;

use AutoWp\Agent\Config;

/**
 * Verifies a signed web request exactly in the order of docs/agent-protocol.md (steps 1-6). Throws
 * AuthFailure on any failure; the caller maps that to HTTP 404 with an empty body.
 */
final class RequestVerifier
{
    public const SIG_VERSION = 'AUTOWP-SIG-V1';
    public const CLOCK_SKEW = 300;
    public const NONCE_PATTERN = '/^[A-Za-z0-9_-]{22}$/D';

    /** @var Config */
    private $config;
    /** @var NonceStore */
    private $nonces;
    /** @var callable(): int */
    private $clock;
    /** @var bool */
    private $forceCompat;

    public function __construct(Config $config, NonceStore $nonces, callable $clock, bool $forceCompat = false)
    {
        $this->config = $config;
        $this->nonces = $nonces;
        $this->clock = $clock;
        $this->forceCompat = $forceCompat;
    }

    /**
     * @param array<string, string> $headers lower-cased header name => value
     * @return string the authenticated key id
     */
    public function verify(string $method, string $path, array $headers, string $body, string $remoteIp): string
    {
        $now = ($this->clock)();

        // 1. IP allowlist, then the kill switch.
        if ($this->config->ipAllowlist !== [] && !IpMatcher::matches($remoteIp, $this->config->ipAllowlist)) {
            throw new AuthFailure('ip_not_allowed');
        }
        if ($this->config->expiresAt !== null && $now >= $this->config->expiresAt) {
            throw new AuthFailure('expired');
        }

        // 2. Method and size.
        if ($method !== 'POST') {
            throw new AuthFailure('method');
        }
        if (strlen($body) > $this->config->maxBodyBytes) {
            throw new AuthFailure('body_too_large');
        }

        // 3. Headers, nonce format, key id, site id.
        $site = $headers['x-autowp-site'] ?? null;
        $keyId = $headers['x-autowp-key-id'] ?? null;
        $alg = $headers['x-autowp-alg'] ?? null;
        $ts = $headers['x-autowp-timestamp'] ?? null;
        $nonce = $headers['x-autowp-nonce'] ?? null;
        $sigB64 = $headers['x-autowp-signature'] ?? null;
        if ($site === null || $keyId === null || $alg === null || $ts === null || $nonce === null
            || $sigB64 === null) {
            throw new AuthFailure('missing_header');
        }
        if (preg_match(self::NONCE_PATTERN, $nonce) !== 1) {
            throw new AuthFailure('nonce_format');
        }
        if (preg_match('/^[0-9]{1,12}$/D', $ts) !== 1) {
            throw new AuthFailure('timestamp_format');
        }
        if (!isset($this->config->keys[$keyId])) {
            throw new AuthFailure('unknown_key');
        }
        $key = $this->config->keys[$keyId];
        if ($alg !== $key['alg']) {
            throw new AuthFailure('alg_mismatch');
        }
        if ($this->config->siteId === '' || !hash_equals($this->config->siteId, $site)) {
            throw new AuthFailure('site_mismatch');
        }

        // 4. Clock skew.
        if (abs($now - (int) $ts) > self::CLOCK_SKEW) {
            throw new AuthFailure('clock_skew');
        }

        // 5. Signature.
        $sig = base64_decode($sigB64, true);
        if ($sig === false) {
            throw new AuthFailure('signature_format');
        }
        $canonical = self::canonical($method, $path, $ts, $nonce, $site, $body);
        if ($key['alg'] === 'ed25519') {
            $ok = Ed25519::verify($sig, $canonical, $key['key'], $this->forceCompat);
        } else {
            $ok = hash_equals(hash_hmac('sha256', $canonical, $key['key'], true), $sig);
        }
        if (!$ok) {
            throw new AuthFailure('bad_signature');
        }

        // 6. Replay.
        if (!$this->nonces->checkAndRecord($nonce, $now)) {
            throw new AuthFailure('replay');
        }
        return $keyId;
    }

    public static function canonical(string $method, string $path, string $ts, string $nonce, string $site, string $body): string
    {
        return implode("\n", [
            self::SIG_VERSION,
            strtoupper($method),
            $path,
            $ts,
            $nonce,
            $site,
            hash('sha256', $body),
        ]);
    }
}
