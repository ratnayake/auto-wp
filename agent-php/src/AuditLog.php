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
