<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

use AutoWp\Agent\AgentException;

/**
 * Appends one gzip member per writer session. A job that runs over several requests opens a new writer
 * per slice; the result is a valid multi-member gzip file (RFC 1952) that gzip/tar/zlib read as one stream.
 * The file is truncated back to `$resumeAt` first, so a slice that died half-way is simply redone.
 */
final class GzipWriter implements ByteSink
{
    /** @var resource */
    private $fh;
    /** @var resource|\DeflateContext */
    private $ctx;
    /** @var int */
    private $written = 0;
    /** @var bool */
    private $closed = false;

    public function __construct(string $file, int $resumeAt = 0, int $level = 6)
    {
        $old = umask(0077);
        $fh = @fopen($file, 'c+b');
        umask($old);
        if ($fh === false) {
            throw AgentException::internal('cannot open output file');
        }
        if (!ftruncate($fh, $resumeAt) || fseek($fh, $resumeAt) !== 0) {
            fclose($fh);
            throw AgentException::internal('cannot reposition output file');
        }
        $ctx = deflate_init(ZLIB_ENCODING_GZIP, ['level' => $level]);
        if ($ctx === false) {
            fclose($fh);
            throw AgentException::internal('deflate_init failed');
        }
        $this->fh = $fh;
        $this->ctx = $ctx;
    }

    public function write(string $data): void
    {
        if ($data === '') {
            return;
        }
        $this->written += strlen($data);
        $out = deflate_add($this->ctx, $data, ZLIB_NO_FLUSH);
        if ($out === false) {
            throw AgentException::internal('deflate failed');
        }
        $this->put($out);
    }

    /** Finishes the gzip member and returns the compressed file size. */
    public function close(): int
    {
        if ($this->closed) {
            throw AgentException::internal('writer already closed');
        }
        $this->closed = true;
        $out = deflate_add($this->ctx, '', ZLIB_FINISH);
        if ($out === false) {
            throw AgentException::internal('deflate failed');
        }
        $this->put($out);
        fflush($this->fh);
        $size = (int) ftell($this->fh);
        fclose($this->fh);
        return $size;
    }

    /** Uncompressed bytes written in this session. */
    public function uncompressedBytes(): int
    {
        return $this->written;
    }

    private function put(string $bytes): void
    {
        $len = strlen($bytes);
        $off = 0;
        while ($off < $len) {
            $n = fwrite($this->fh, $off === 0 ? $bytes : substr($bytes, $off));
            if ($n === false || $n === 0) {
                throw AgentException::internal('write failed (disk full?)');
            }
            $off += $n;
        }
    }
}
