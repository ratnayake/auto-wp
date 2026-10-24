<?php

declare(strict_types=1);

namespace AutoWp\Agent\Security;

use AutoWp\Agent\DataDir;

/**
 * Replay protection: remembers nonces for TTL seconds in a flock()ed, header-protected JSON file.
 */
final class NonceStore
{
    public const TTL = 600;
    private const MAX_ENTRIES = 200000;

    /** @var string */
    private $file;
    /** @var int */
    private $ttl;

    public function __construct(string $file, int $ttl = self::TTL)
    {
        $this->file = $file;
        $this->ttl = $ttl;
    }

    /**
     * Atomically checks that the nonce is unseen and records it. Returns false on replay or when the
     * store cannot be used (fail closed).
     */
    public function checkAndRecord(string $nonce, int $now): bool
    {
        $old = umask(0077);
        $fh = @fopen($this->file, 'c+');
        umask($old);
        if ($fh === false) {
            return false;
        }
        try {
            if (!flock($fh, LOCK_EX)) {
                return false;
            }
            $raw = stream_get_contents($fh);
            $map = [];
            if (is_string($raw) && $raw !== '') {
                $decoded = json_decode(DataDir::stripHeader($raw), true);
                if (!is_array($decoded)) {
                    return false; // corrupted store: refuse rather than accept replays
                }
                $map = $decoded;
            }
            $fresh = [];
            foreach ($map as $n => $exp) {
                if (is_int($exp) && $exp > $now) {
                    $fresh[(string) $n] = $exp;
                }
            }
            if (isset($fresh[$nonce])) {
                return false;
            }
            if (count($fresh) >= self::MAX_ENTRIES) {
                return false;
            }
            $fresh[$nonce] = $now + $this->ttl;
            $json = json_encode($fresh, JSON_UNESCAPED_SLASHES);
            if ($json === false) {
                return false;
            }
            ftruncate($fh, 0);
            rewind($fh);
            $data = DataDir::HEADER . $json;
            if (fwrite($fh, $data) !== strlen($data)) {
                return false;
            }
            fflush($fh);
            flock($fh, LOCK_UN);
            return true;
        } finally {
            fclose($fh);
        }
    }
}
