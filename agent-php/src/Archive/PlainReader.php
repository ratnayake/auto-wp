<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

use AutoWp\Agent\AgentException;

/** Uncompressed file source with the same checkpoint shape as GzipReader. */
final class PlainReader implements ByteSource
{
    /** @var resource */
    private $fh;
    /** @var string */
    private $buf = '';
    /** @var int */
    private $pos;

    /**
     * @param array{logical?: int}|null $resume
     */
    public function __construct(string $file, ?array $resume = null)
    {
        $fh = @fopen($file, 'rb');
        if ($fh === false) {
            throw AgentException::notFound('cannot open file');
        }
        $this->fh = $fh;
        $this->pos = (int) ($resume['logical'] ?? 0);
        if ($this->pos > 0 && fseek($fh, $this->pos) !== 0) {
            throw AgentException::internal('cannot seek file');
        }
    }

    public function __destruct()
    {
        if (is_resource($this->fh)) {
            fclose($this->fh);
        }
    }

    public function read(int $n): string
    {
        while (strlen($this->buf) < $n) {
            $chunk = fread($this->fh, max(65536, $n));
            if ($chunk === false || $chunk === '') {
                break;
            }
            $this->buf .= $chunk;
        }
        $out = (string) substr($this->buf, 0, $n);
        $this->buf = (string) substr($this->buf, strlen($out));
        $this->pos += strlen($out);
        return $out;
    }

    public function position(): int
    {
        return $this->pos;
    }

    /** @return array{logical: int} */
    public function checkpoint(): array
    {
        return ['logical' => $this->pos];
    }

    /** @return array{logical: int} */
    public function checkpointAt(int $pos): array
    {
        return ['logical' => $pos];
    }

    public static function isGzip(string $file): bool
    {
        $fh = @fopen($file, 'rb');
        if ($fh === false) {
            return false;
        }
        $magic = fread($fh, 2);
        fclose($fh);
        return $magic === "\x1f\x8b";
    }
}
