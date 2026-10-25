<?php

declare(strict_types=1);

namespace AutoWp\Agent\Fs;

use AutoWp\Agent\AgentException;

final class FsUtil
{
    /**
     * FileStat (contracts) for an absolute path, without following a final symlink. Null if missing.
     *
     * @return array{path: string, type: string, size: int, mode: int, mtimeMs: int|float}|null
     */
    public static function stat(string $abs, string $display): ?array
    {
        clearstatcache(true, $abs);
        $st = @lstat($abs);
        if ($st === false) {
            return null;
        }
        $mode = (int) $st['mode'];
        return [
            'path' => $display,
            'type' => TreeWalker::typeOf($mode),
            'size' => max(0, (int) $st['size']),
            'mode' => $mode,
            'mtimeMs' => (int) $st['mtime'] * 1000,
        ];
    }

    /** The client-facing form of a path: normalised, relative if it was given relative. */
    public static function display(string $input): string
    {
        $isAbs = $input !== '' && $input[0] === '/';
        $parts = [];
        foreach (explode('/', $input) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                array_pop($parts);
                continue;
            }
            $parts[] = $seg;
        }
        $joined = implode('/', $parts);
        return $isAbs ? '/' . $joined : ($joined === '' ? '.' : $joined);
    }

    /** Creates missing directories of $dir (absolute, already jailed), never through a symlink. */
    public static function mkdirs(string $dir, int $mode = 0755): void
    {
        if (is_dir($dir) && !is_link($dir)) {
            return;
        }
        $parent = dirname($dir);
        if ($parent !== $dir) {
            self::mkdirs($parent, $mode);
        }
        if (is_link($dir)) {
            throw AgentException::jail('refusing to create a directory through a symlink');
        }
        if (!is_dir($dir) && !@mkdir($dir, $mode) && !is_dir($dir)) {
            throw AgentException::internal('cannot create directory');
        }
    }

    /** Recursively deletes a directory without following symlinks. */
    public static function removeTree(string $path): void
    {
        if (is_link($path) || !is_dir($path)) {
            if (file_exists($path) || is_link($path)) {
                if (!@unlink($path)) {
                    throw AgentException::internal('cannot remove file');
                }
            }
            return;
        }
        $names = @scandir($path);
        if ($names === false) {
            throw AgentException::internal('cannot read directory');
        }
        foreach ($names as $n) {
            if ($n === '.' || $n === '..') {
                continue;
            }
            self::removeTree($path . '/' . $n);
        }
        if (!@rmdir($path)) {
            throw AgentException::internal('cannot remove directory');
        }
    }

    /** Writes all of $data to $fh. */
    public static function writeAll($fh, string $data): void
    {
        $len = strlen($data);
        $off = 0;
        while ($off < $len) {
            $n = fwrite($fh, $off === 0 ? $data : substr($data, $off));
            if ($n === false || $n === 0) {
                throw AgentException::internal('write failed (disk full?)');
            }
            $off += $n;
        }
    }

    public static function sha256File(string $abs): string
    {
        $h = hash_file('sha256', $abs);
        if ($h === false) {
            throw AgentException::internal('cannot hash file');
        }
        return $h;
    }
}
