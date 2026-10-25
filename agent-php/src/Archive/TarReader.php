<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

use AutoWp\Agent\AgentException;

/**
 * Streaming tar reader: ustar, GNU (`L`/`K` long names, base-256 sizes) and PAX (`x` path/linkpath/size;
 * `g` ignored). Verifies header checksums. Entry data is consumed with readData()/skipData() before the
 * next call to next().
 */
final class TarReader
{
    /** @var ByteSource */
    private $src;
    /** @var int data bytes of the current entry not yet consumed */
    private $remaining = 0;
    /** @var int padding after the current entry's data */
    private $padding = 0;
    /** @var bool */
    private $ended = false;

    public function __construct(ByteSource $src)
    {
        $this->src = $src;
    }

    /**
     * Resumes inside an entry's data (after a checkpoint taken mid-entry).
     */
    public function resumeInData(int $remaining, int $padding): void
    {
        $this->remaining = $remaining;
        $this->padding = $padding;
    }

    public function remaining(): int
    {
        return $this->remaining;
    }

    public function pendingPadding(): int
    {
        return $this->padding;
    }

    public function ended(): bool
    {
        return $this->ended;
    }

    /**
     * @return array{name: string, type: string, size: int, mode: int, mtime: int, link: string}|null
     *         null at the end-of-archive marker
     */
    public function next(): ?array
    {
        $this->skipData();
        $longName = null;
        $longLink = null;
        $pax = [];
        while (true) {
            $block = $this->readExact(TarWriter::BLOCK, true);
            if ($block === null) {
                throw AgentException::internal('tar archive ended without an end-of-archive marker');
            }
            if ($block === str_repeat("\0", TarWriter::BLOCK)) {
                // End of archive: a second zero block normally follows; tolerate its absence.
                $this->readExact(TarWriter::BLOCK, true);
                $this->ended = true;
                return null;
            }
            $h = self::parseHeader($block);
            $type = $h['type'];
            if ($type === 'L' || $type === 'K' || $type === 'x' || $type === 'g') {
                if ($h['size'] > 1048576) {
                    throw AgentException::internal('tar meta header is too large');
                }
                $payload = $this->readExact($h['size'], false);
                $this->readExact(TarWriter::padding($h['size']), false);
                if ($type === 'L') {
                    $longName = rtrim((string) $payload, "\0");
                } elseif ($type === 'K') {
                    $longLink = rtrim((string) $payload, "\0");
                } elseif ($type === 'x') {
                    $pax = self::parsePax((string) $payload) + $pax;
                }
                continue;
            }
            $name = $h['name'];
            if (isset($pax['path'])) {
                $name = $pax['path'];
            } elseif ($longName !== null) {
                $name = $longName;
            }
            $link = $h['link'];
            if (isset($pax['linkpath'])) {
                $link = $pax['linkpath'];
            } elseif ($longLink !== null) {
                $link = $longLink;
            }
            $size = $h['size'];
            if (isset($pax['size']) && ctype_digit($pax['size'])) {
                $size = (int) $pax['size'];
            }
            if ($type === "\0") {
                $type = '0';
            }
            if ($type === '0' && substr($name, -1) === '/') {
                $type = '5'; // old tars mark directories with a trailing slash only
            }
            // Only regular files carry data (hard links, symlinks, dirs, devices have size 0 in practice).
            $dataSize = in_array($type, ['0', '7'], true) || !in_array($type, ['1', '2', '3', '4', '5', '6'], true)
                ? $size : 0;
            $this->remaining = $dataSize;
            $this->padding = TarWriter::padding($dataSize);
            return [
                'name' => $name,
                'type' => $type === '7' ? '0' : $type,
                'size' => $dataSize,
                'mode' => $h['mode'],
                'mtime' => $h['mtime'],
                'link' => $link,
            ];
        }
    }

    /** Reads up to $max bytes of the current entry's data; '' when it is exhausted. */
    public function readData(int $max): string
    {
        if ($this->remaining === 0) {
            return '';
        }
        $want = min($max, $this->remaining);
        $chunk = $this->src->read($want);
        if (strlen($chunk) !== $want) {
            throw AgentException::internal('tar entry data is truncated');
        }
        $this->remaining -= $want;
        if ($this->remaining === 0) {
            $this->readExact($this->padding, false);
            $this->padding = 0;
        }
        return $chunk;
    }

    public function skipData(): void
    {
        while ($this->remaining > 0) {
            $this->readData(1048576);
        }
        if ($this->padding > 0) {
            $this->readExact($this->padding, false);
            $this->padding = 0;
        }
    }

    private function readExact(int $n, bool $allowEof): ?string
    {
        if ($n === 0) {
            return '';
        }
        $buf = '';
        while (strlen($buf) < $n) {
            $chunk = $this->src->read($n - strlen($buf));
            if ($chunk === '') {
                break;
            }
            $buf .= $chunk;
        }
        if (strlen($buf) === $n) {
            return $buf;
        }
        if ($allowEof && $buf === '') {
            return null;
        }
        throw AgentException::internal('tar archive is truncated');
    }

    /**
     * @return array{name: string, type: string, size: int, mode: int, mtime: int, link: string}
     */
    public static function parseHeader(string $b): array
    {
        $stored = self::parseNumeric(substr($b, 148, 8));
        $unsigned = 0;
        $signed = 0;
        for ($i = 0; $i < TarWriter::BLOCK; $i++) {
            $c = ($i >= 148 && $i < 156) ? 32 : ord($b[$i]);
            $unsigned += $c;
            $signed += $c > 127 ? $c - 256 : $c;
        }
        if ($stored !== $unsigned && $stored !== $signed) {
            throw AgentException::internal('tar header checksum mismatch');
        }
        $name = self::cstr(substr($b, 0, 100));
        $magic = substr($b, 257, 6);
        if ($magic === "ustar\0") {
            $prefix = self::cstr(substr($b, 345, 155));
            if ($prefix !== '') {
                $name = $prefix . '/' . $name;
            }
        }
        return [
            'name' => $name,
            'mode' => self::parseNumeric(substr($b, 100, 8)),
            'size' => self::parseNumeric(substr($b, 124, 12)),
            'mtime' => self::parseNumeric(substr($b, 136, 12)),
            'type' => $b[156],
            'link' => self::cstr(substr($b, 157, 100)),
        ];
    }

    private static function cstr(string $s): string
    {
        $p = strpos($s, "\0");
        return $p === false ? $s : substr($s, 0, $p);
    }

    private static function parseNumeric(string $f): int
    {
        if ($f !== '' && (ord($f[0]) & 0x80) !== 0) {
            if (ord($f[0]) === 0xff) {
                throw AgentException::internal('negative tar number');
            }
            $v = ord($f[0]) & 0x7f;
            for ($i = 1, $n = strlen($f); $i < $n; $i++) {
                if ($v > (PHP_INT_MAX >> 8)) {
                    throw AgentException::internal('tar number overflow');
                }
                $v = ($v << 8) | ord($f[$i]);
            }
            return $v;
        }
        $t = trim($f, " \0");
        if ($t === '') {
            return 0;
        }
        if (preg_match('/^[0-7]+$/D', $t) !== 1) {
            throw AgentException::internal('invalid tar header number');
        }
        return (int) octdec($t);
    }

    /** @return array<string, string> */
    private static function parsePax(string $p): array
    {
        $out = [];
        $off = 0;
        $len = strlen($p);
        while ($off < $len) {
            $sp = strpos($p, ' ', $off);
            if ($sp === false) {
                break;
            }
            $recLen = (int) substr($p, $off, $sp - $off);
            if ($recLen <= 0 || $off + $recLen > $len) {
                throw AgentException::internal('invalid PAX header');
            }
            $rec = substr($p, $sp + 1, $recLen - ($sp - $off) - 2);
            $eq = strpos($rec, '=');
            if ($eq !== false) {
                $out[substr($rec, 0, $eq)] = substr($rec, $eq + 1);
            }
            $off += $recLen;
        }
        return $out;
    }
}
