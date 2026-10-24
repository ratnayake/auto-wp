<?php

declare(strict_types=1);

namespace AutoWp\Agent;

/**
 * Append-only, hash-chained JSON-lines audit log in the agent's data dir. Each line carries the sha256 of
 * the previous line, so truncation or edits in the middle are detectable. Never log secrets.
 */
final class AuditLog
{
    /** Rotate (keep one previous file) beyond this size, so log floods cannot fill the disk. */
    public const MAX_BYTES = 8388608;

    /** @var string */
    private $file;
    /** @var callable(): int */
    private $clock;

    public function __construct(string $file, callable $clock)
    {
        $this->file = $file;
        $this->clock = $clock;
    }

    /**
     * @param array<string, mixed> $fields
     */
    public function record(string $event, array $fields = []): void
    {
        $old = umask(0077);
        $fh = @fopen($this->file, 'c+');
        umask($old);
        if ($fh === false) {
            return; // auditing must never break the request
        }
        try {
            if (!flock($fh, LOCK_EX)) {
                return;
            }
            $size = fstat($fh)['size'];
            if ($size > self::MAX_BYTES) {
                $prevHash = $this->lastLineHash($fh, $size);
                @copy($this->file, preg_replace('/\.php$/', '', $this->file) . '.1.php');
                ftruncate($fh, 0);
                rewind($fh);
                fwrite($fh, DataDir::HEADER);
                $size = 0;
                $prev = $prevHash;
            } elseif ($size === 0) {
                fwrite($fh, DataDir::HEADER);
                $prev = str_repeat('0', 64);
            } else {
                $prev = $this->lastLineHash($fh, $size);
            }
            $entry = ['ts' => gmdate('Y-m-d\TH:i:s\Z', ($this->clock)()), 'event' => $event] + $fields
                + ['prev' => $prev];
            fseek($fh, 0, SEEK_END);
            fwrite($fh, Json::encode($entry) . "\n");
            fflush($fh);
            flock($fh, LOCK_UN);
        } finally {
            fclose($fh);
        }
    }

    /**
     * Like record(), but at most one line per key per $window seconds; suppressed occurrences are
     * counted and reported on the next line for that key. Used for unauthenticated hits, so floods
     * cannot fill the disk or push real entries out of the log.
     *
     * @param array<string, mixed> $fields
     */
    public function recordThrottled(string $event, string $key, array $fields, int $window = 60): void
    {
        $now = ($this->clock)();
        $key = hash('sha256', $key);
        $file = $this->file . '.throttle';
        $old = umask(0077);
        $lock = @fopen($file . '.lock', 'c');
        umask($old);
        if ($lock === false || !flock($lock, LOCK_EX)) {
            return;
        }
        $suppressed = 0;
        $write = true;
        try {
            $raw = DataDir::readProtected($file);
            $map = $raw === null ? [] : json_decode($raw, true);
            if (!is_array($map)) {
                $map = [];
            }
            foreach ($map as $k => $v) {
                if (!is_array($v) || $now - (int) $v[0] >= $window) {
                    if (is_array($v) && (int) $v[1] > 0 && $k === $key) {
                        $suppressed = (int) $v[1];
                    }
                    unset($map[$k]);
                }
            }
            if (isset($map[$key])) {
                $map[$key][1]++;
                $write = false;
            } elseif (count($map) >= 5000) {
                $map['overflow'] = [$now, (int) ($map['overflow'][1] ?? 0) + 1];
                $write = false;
            } else {
                $map[$key] = [$now, 0];
            }
            try {
                DataDir::writeProtected($file, (string) json_encode($map));
            } catch (\Throwable $e) {
                // auditing must never break the request
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        if ($write) {
            $this->record($event, $fields + ($suppressed > 0 ? ['suppressed' => $suppressed] : []));
        }
    }

    /**
     * @param resource $fh
     */
    private function lastLineHash($fh, int $size): string
    {
        $read = min($size, 65536);
        fseek($fh, $size - $read);
        $tail = (string) fread($fh, $read);
        $tail = rtrim($tail, "\n");
        $pos = strrpos($tail, "\n");
        $line = $pos === false ? $tail : substr($tail, $pos + 1);
        return hash('sha256', $line);
    }
}
