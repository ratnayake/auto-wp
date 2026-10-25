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
        $fh = @fopen($this->file . '.lock', 'c');
        umask($old);
        if ($fh === false) {
            return false;
        }
        try {
            if (!flock($fh, LOCK_EX)) {
                return false;
            }
            $raw = is_file($this->file) ? @file_get_contents($this->file) : '';
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
                // Kept through the expiry second itself: TTL (600) is exactly 2 x the clock skew (300),
                // so a nonce must still be known at ts+300 seen from a clock 300 s behind.
                if (is_int($exp) && $exp >= $now) {
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
            // Atomic replace: a partial write (disk full, killed process) can never corrupt the store.
            try {
                DataDir::writeProtected($this->file, $json);
            } catch (\Throwable $e) {
                return false;
            }
            flock($fh, LOCK_UN);
            return true;
        } finally {
            fclose($fh);
        }
    }
}
