<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

use AutoWp\Agent\AgentException;

/**
 * Streaming gzip reader that understands multi-member files, verifies every member's CRC/length (via
 * zlib) and detects truncation. It can checkpoint a logical (uncompressed) position as
 * (member start offset, offset inside member) and resume from it in a later request, which is cheap for
 * the many-small-members files our own writers produce.
 */
final class GzipReader implements ByteSource
{
    private const IN_CHUNK = 16384;

    /** @var resource */
    private $fh;
    /** @var resource|\InflateContext|null */
    private $ctx;
    /** @var string */
    private $in = '';
    /** @var string */
    private $out = '';
    /** @var int uncompressed bytes produced so far (logical position of the end of $out) */
    private $produced;
    /** @var array<int, array{0:int,1:int}> [logical start, compressed start] of each member seen */
    private $members = [];
    /** @var int compressed offset of the first byte in $in */
    private $inOffset;
    /** @var bool */
    private $eof = false;
    /** @var int bytes still to discard after a resume */
    private $discard = 0;

    /**
     * @param array{memberOffset?: int, inMember?: int, logical?: int}|null $resume
     */
    public function __construct(string $file, ?array $resume = null)
    {
        $fh = @fopen($file, 'rb');
        if ($fh === false) {
            throw AgentException::notFound('cannot open archive');
        }
        $this->fh = $fh;
        $memberOffset = (int) ($resume['memberOffset'] ?? 0);
        $inMember = (int) ($resume['inMember'] ?? 0);
        $logical = (int) ($resume['logical'] ?? 0);
        if ($memberOffset > 0 && fseek($fh, $memberOffset) !== 0) {
            throw AgentException::internal('cannot seek archive');
        }
        $this->inOffset = $memberOffset;
        $this->produced = $logical - $inMember;
        $this->discard = $inMember;
    }

    public function __destruct()
    {
        if (is_resource($this->fh)) {
            fclose($this->fh);
        }
    }

    /** Reads up to $n bytes; returns '' only at the clean end of the stream. */
    public function read(int $n): string
    {
        while (strlen($this->out) < $n && !$this->eof) {
            $this->fill();
        }
        $chunk = (string) substr($this->out, 0, $n);
        $this->out = (string) substr($this->out, strlen($chunk));
        return $chunk;
    }

    /** Logical position of the next byte read() would return. */
    public function position(): int
    {
        return $this->produced - strlen($this->out);
    }

    /**
     * @return array{memberOffset: int, inMember: int, logical: int}
     */
    public function checkpoint(): array
    {
        return $this->checkpointAt($this->position());
    }

    /**
     * Checkpoint for an already-read logical position (e.g. the end of the last executed statement).
     *
     * @return array{memberOffset: int, inMember: int, logical: int}
     */
    public function checkpointAt(int $pos): array
    {
        $best = null;
        foreach ($this->members as $m) {
            if ($m[0] <= $pos) {
                $best = $m;
            }
        }
        if ($best === null) {
            throw AgentException::internal('checkpoint before first member');
        }
        return ['memberOffset' => $best[1], 'inMember' => $pos - $best[0], 'logical' => $pos];
    }

    private function fill(): void
    {
        if ($this->in === '') {
            $chunk = fread($this->fh, self::IN_CHUNK);
            if ($chunk === false || $chunk === '') {
                if ($this->ctx !== null) {
                    throw AgentException::internal('gzip stream is truncated');
                }
                $this->eof = true;
                return;
            }
            $this->in = $chunk;
        }
        if ($this->ctx === null) {
            if (ltrim($this->in, "\0") === '') {
                // Trailing zero padding after the last member is tolerated.
                $this->inOffset += strlen($this->in);
                $this->in = '';
                return;
            }
            if (strlen($this->in) < 2) {
                $more = fread($this->fh, self::IN_CHUNK);
                if (is_string($more)) {
                    $this->in .= $more;
                }
            }
            if (strncmp($this->in, "\x1f\x8b", 2) !== 0) {
                throw AgentException::internal('not a gzip stream (bad magic)');
            }
            $ctx = inflate_init(ZLIB_ENCODING_GZIP);
            if ($ctx === false) {
                throw AgentException::internal('inflate_init failed');
            }
            $this->ctx = $ctx;
            $this->members[] = [$this->produced, $this->inOffset];
        }
        $before = inflate_get_read_len($this->ctx);
        $data = @inflate_add($this->ctx, $this->in, ZLIB_SYNC_FLUSH);
        if ($data === false) {
            throw AgentException::internal('gzip data is corrupt');
        }
        $consumed = inflate_get_read_len($this->ctx) - $before;
        $status = inflate_get_status($this->ctx);
        if ($status === ZLIB_STREAM_END) {
            $this->ctx = null;
        } elseif ($consumed < strlen($this->in) && $data === '') {
            throw AgentException::internal('gzip data is corrupt');
        }
        $this->in = (string) substr($this->in, $consumed);
        $this->inOffset += $consumed;
        if ($this->discard > 0) {
            $drop = min($this->discard, strlen($data));
            $this->discard -= $drop;
            $this->produced += $drop;
            $data = (string) substr($data, $drop);
        }
        $this->produced += strlen($data);
        $this->out .= $data;
    }
}
