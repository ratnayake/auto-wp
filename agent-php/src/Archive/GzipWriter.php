<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Fs\FsUtil;

/**
 * Writes gzip members (RFC 1952). A job that runs over several requests opens a new writer per slice,
 * and a writer also starts a new member every MEMBER_BYTES of input; the result is a valid multi-member
 * gzip file that gzip/tar/zlib read as one stream, and that GzipReader can resume from cheaply (it only
 * has to re-inflate from the start of the current member). The file is truncated back to `$resumeAt`
 * first, so a slice that died half-way is simply redone.
 */
final class GzipWriter implements ByteSink
{
    public const MEMBER_BYTES = 33554432;

    /** @var resource */
    private $fh;
    /** @var resource|\DeflateContext */
    private $ctx;
    /** @var int */
    private $level;
    /** @var int */
    private $written = 0;
    /** @var int input bytes in the current member */
    private $inMember = 0;
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
        $this->fh = $fh;
        $this->level = $level;
        $this->ctx = $this->newContext();
    }

    /** @return resource|\DeflateContext */
    private function newContext()
    {
        $ctx = deflate_init(ZLIB_ENCODING_GZIP, ['level' => $this->level]);
        if ($ctx === false) {
            throw AgentException::internal('deflate_init failed');
        }
        return $ctx;
    }

    public function write(string $data): void
    {
        if ($data === '') {
            return;
        }
        $this->written += strlen($data);
        $this->inMember += strlen($data);
        $out = deflate_add($this->ctx, $data, ZLIB_NO_FLUSH);
        if ($out === false) {
            throw AgentException::internal('deflate failed');
        }
        FsUtil::writeAll($this->fh, $out);
        if ($this->inMember >= self::MEMBER_BYTES) {
            $this->finishMember();
            $this->ctx = $this->newContext();
            $this->inMember = 0;
        }
    }

    /** Finishes the gzip member and returns the compressed file size. */
    public function close(): int
    {
        if ($this->closed) {
            throw AgentException::internal('writer already closed');
        }
        $this->closed = true;
        $this->finishMember();
        fflush($this->fh);
        $size = (int) ftell($this->fh);
        fclose($this->fh);
        return $size;
    }

    private function finishMember(): void
    {
        $out = deflate_add($this->ctx, '', ZLIB_FINISH);
        if ($out === false) {
            throw AgentException::internal('deflate failed');
        }
        FsUtil::writeAll($this->fh, $out);
    }

    /** Uncompressed bytes written in this session. */
    public function uncompressedBytes(): int
    {
        return $this->written;
    }
}
