<?php

declare(strict_types=1);

namespace AutoWp\Agent;

/**
 * Agent configuration. On disk it is a PHP file returning an array (written by bin/install.php with
 * var_export), never anything else.
 */
final class Config
{
    public const DEFAULT_MAX_BODY = 16777216;
    public const DEFAULT_SLICE_SECONDS = 20;

    /** @var string */
    public $siteId;
    /** @var string Absolute, realpath'd WordPress root. */
    public $wpRoot;
    /** @var string */
    public $docroot;
    /** @var string|null */
    public $outsideDocrootDir;
    /** @var string */
    public $dataDir;
    /** @var array<string, array{alg: string, key: string}> keyId => alg + raw key bytes */
    public $keys = [];
    /** @var string[] */
    public $ipAllowlist = [];
    /** @var int|null Unix seconds after which every web request is refused. */
    public $expiresAt;
    /** @var int */
    public $maxBodyBytes = self::DEFAULT_MAX_BODY;
    /** @var int */
    public $sliceSeconds = self::DEFAULT_SLICE_SECONDS;
    /** @var bool Allow tar/mysqldump in web mode (they cannot be time-sliced). */
    public $webUseBinaries = false;
    /** @var bool Master switch for tar/mysqldump (false = always use the native implementations). */
    public $useBinaries = true;
    /** @var bool fs.extract creates symlink/hard-link entries (validated) instead of skipping them. */
    public $extractLinks = false;
    /** @var bool Accept web requests over plain HTTP (otherwise HTTPS is required). */
    public $allowInsecureHttp = false;
    /** @var bool Treat `X-Forwarded-Proto: https` as HTTPS (only behind a trusted proxy). */
    public $trustForwardedProto = false;
    /** @var string|null HTTP_HOST to present to WordPress in CLI bridge mode. */
    public $siteHost;
    /** @var string|null Path of the config file this was loaded from. */
    public $path;

    /**
     * @param array<string, mixed> $a
     */
    public static function fromArray(array $a, ?string $path = null): self
    {
        $c = new self();
        $c->path = $path;
        $c->siteId = self::str($a, 'siteId', '');
        $wpRoot = self::str($a, 'wpRoot', '');
        if ($wpRoot === '') {
            throw new \InvalidArgumentException('config: wpRoot is required');
        }
        $real = realpath($wpRoot);
        if ($real === false || !is_dir($real)) {
            throw new \InvalidArgumentException('config: wpRoot does not exist');
        }
        $c->wpRoot = $real;
        $docroot = self::str($a, 'docroot', '');
        $c->docroot = $docroot !== '' && realpath($docroot) !== false ? (string) realpath($docroot) : $real;
        $outside = self::str($a, 'outsideDocrootDir', '');
        if ($outside !== '') {
            $r = realpath($outside);
            if ($r === false || !is_dir($r)) {
                throw new \InvalidArgumentException('config: outsideDocrootDir does not exist');
            }
            $c->outsideDocrootDir = $r;
        }
        $dataDir = self::str($a, 'dataDir', '');
        if ($dataDir === '') {
            throw new \InvalidArgumentException('config: dataDir is required');
        }
        $c->dataDir = rtrim($dataDir, '/');

        $keys = $a['keys'] ?? [];
        if (!is_array($keys)) {
            throw new \InvalidArgumentException('config: keys must be a map');
        }
        foreach ($keys as $id => $k) {
            if (!is_string($id) || !is_array($k)) {
                throw new \InvalidArgumentException('config: invalid key entry');
            }
            $alg = (string) ($k['alg'] ?? '');
            if ($alg === 'ed25519') {
                $raw = base64_decode((string) ($k['publicKey'] ?? ''), true);
                if ($raw === false || strlen($raw) !== 32) {
                    throw new \InvalidArgumentException('config: ed25519 publicKey must be 32 bytes base64');
                }
            } elseif ($alg === 'hmac-sha256') {
                $raw = base64_decode((string) ($k['secret'] ?? ''), true);
                if ($raw === false || strlen($raw) < 32) {
                    throw new \InvalidArgumentException('config: hmac secret must be >= 32 bytes base64');
                }
            } else {
                throw new \InvalidArgumentException('config: unsupported key alg');
            }
            $c->keys[$id] = ['alg' => $alg, 'key' => $raw];
        }

        $allow = $a['ipAllowlist'] ?? [];
        if (!is_array($allow)) {
            throw new \InvalidArgumentException('config: ipAllowlist must be a list');
        }
        foreach ($allow as $ip) {
            $c->ipAllowlist[] = (string) $ip;
        }

        $exp = $a['expires_at'] ?? ($a['expiresAt'] ?? null);
        if (is_int($exp)) {
            $c->expiresAt = $exp;
        } elseif (is_string($exp) && $exp !== '') {
            $t = ctype_digit($exp) ? (int) $exp : strtotime($exp);
            if ($t === false) {
                throw new \InvalidArgumentException('config: expires_at is not a valid time');
            }
            $c->expiresAt = $t;
        }

        if (isset($a['maxBodyBytes'])) {
            $c->maxBodyBytes = max(1024, (int) $a['maxBodyBytes']);
        }
        if (isset($a['sliceSeconds'])) {
            $c->sliceSeconds = max(2, min(120, (int) $a['sliceSeconds']));
        }
        $c->webUseBinaries = (bool) ($a['webUseBinaries'] ?? false);
        $c->useBinaries = (bool) ($a['useBinaries'] ?? true);
        $c->extractLinks = (bool) ($a['extractLinks'] ?? false);
        $c->allowInsecureHttp = (bool) ($a['allowInsecureHttp'] ?? false);
        $c->trustForwardedProto = (bool) ($a['trustForwardedProto'] ?? false);
        $host = self::str($a, 'siteHost', '');
        $c->siteHost = $host !== '' ? $host : null;
        return $c;
    }

    public static function load(string $path): self
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new \InvalidArgumentException('config file not readable');
        }
        $data = self::requireIsolated($path);
        if (!is_array($data)) {
            throw new \InvalidArgumentException('config file must return an array');
        }
        $real = realpath($path);
        return self::fromArray($data, $real === false ? $path : $real);
    }

    /**
     * @return mixed
     */
    private static function requireIsolated(string $path)
    {
        return require $path;
    }

    /**
     * @param array<string, mixed> $a
     */
    private static function str(array $a, string $k, string $default): string
    {
        if (!isset($a[$k])) {
            return $default;
        }
        if (!is_string($a[$k])) {
            throw new \InvalidArgumentException('config: ' . $k . ' must be a string');
        }
        return $a[$k];
    }
}
