<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

use AutoWp\Agent\AgentException;

/**
 * Streaming tar writer (GNU format: ustar layout, `ustar  \0` magic, `././@LongLink` entries for names
 * or link targets longer than 100 bytes, base-256 sizes above 8 GiB). Readable by GNU tar, bsdtar,
 * node-tar and Python's tarfile.
 */
final class TarWriter
{
    public const BLOCK = 512;

    /** @var ByteSink */
    private $sink;

    public function __construct(ByteSink $sink)
    {
        $this->sink = $sink;
    }

    /**
     * @param string $type '0' file, '5' dir, '2' symlink
     */
    public function header(string $name, string $type, int $size, int $mode, int $mtime, string $link = ''): void
    {
        if ($type === '5' && substr($name, -1) !== '/') {
            $name .= '/';
        }
        if (strlen($link) > 100) {
            $this->sink->write(self::block('././@LongLink', 'K', strlen($link) + 1, 0644, 0, ''));
            $this->data($link . "\0");
        }
        if (strlen($name) > 100) {
            $this->sink->write(self::block('././@LongLink', 'L', strlen($name) + 1, 0644, 0, ''));
            $this->data($name . "\0");
        }
        $this->sink->write(self::block($name, $type, $type === '0' ? $size : 0, $mode, $mtime, $link));
    }

    /** Writes a small in-memory payload followed by its padding. */
    private function data(string $payload): void
    {
        $this->sink->write($payload);
        $this->sink->write(str_repeat("\0", self::padding(strlen($payload))));
    }

    public function write(string $bytes): void
    {
        $this->sink->write($bytes);
    }

    public function pad(int $size): void
    {
        $p = self::padding($size);
        if ($p > 0) {
            $this->sink->write(str_repeat("\0", $p));
        }
    }

    public function finish(): void
    {
        $this->sink->write(str_repeat("\0", self::BLOCK * 2));
    }

    public static function padding(int $size): int
    {
        return (self::BLOCK - $size % self::BLOCK) % self::BLOCK;
    }

    public static function block(string $name, string $type, int $size, int $mode, int $mtime, string $link): string
    {
        if (strlen($type) !== 1) {
            throw AgentException::internal('bad tar type');
        }
        $h = self::field(substr($name, 0, 100), 100)
            . self::octal($mode & 07777, 8)
            . self::octal(0, 8)
            . self::octal(0, 8)
            . self::size($size)
            . self::octal(max(0, min($mtime, 077777777777)), 12)
            . '        '
            . $type
            . self::field(substr($link, 0, 100), 100)
            . "ustar  \0"
            . self::field('', 32)
            . self::field('', 32)
            . str_repeat("\0", 8)
            . str_repeat("\0", 8)
            . str_repeat("\0", 155)
            . str_repeat("\0", 12);
        $sum = 0;
        for ($i = 0; $i < self::BLOCK; $i++) {
            $sum += ord($h[$i]);
        }
        $chk = sprintf('%06o', $sum) . "\0 ";
        return substr($h, 0, 148) . $chk . substr($h, 156);
    }

    private static function field(string $s, int $len): string
    {
        return str_pad($s, $len, "\0");
    }

    private static function octal(int $v, int $len): string
    {
        return str_pad(sprintf('%o', $v), $len - 1, '0', STR_PAD_LEFT) . "\0";
    }

    private static function size(int $size): string
    {
        if ($size < 077777777777) {
            return self::octal($size, 12);
        }
        // GNU base-256: high bit set in the first byte, big-endian value in the rest.
        $bytes = '';
        $v = $size;
        for ($i = 0; $i < 11; $i++) {
            $bytes = chr($v & 0xff) . $bytes;
            $v >>= 8;
        }
        return "\x80" . $bytes;
    }
}
