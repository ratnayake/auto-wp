<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\Fs\FsUtil;

/** fs.stat, fs.list, fs.readChunk, fs.writeChunk, fs.mkdir, fs.rename, fs.remove */
final class FsActions
{
    public const MAX_CHUNK = 8388608;

    /**
     * @param array{path: string} $p
     * @return array<string, mixed>|null
     */
    public static function stat(array $p, Context $ctx): ?array
    {
        $abs = $ctx->jail->resolveNoFollow($p['path']);
        return FsUtil::stat($abs, FsUtil::display($p['path']));
    }

    /**
     * @param array{path: string} $p
     * @return array<int, array<string, mixed>>
     */
    public static function list(array $p, Context $ctx): array
    {
        $abs = $ctx->jail->resolve($p['path']);
        if (!is_dir($abs)) {
            throw AgentException::notFound('not a directory');
        }
        $names = @scandir($abs, SCANDIR_SORT_ASCENDING);
        if ($names === false) {
            throw AgentException::internal('cannot read directory');
        }
        $display = FsUtil::display($p['path']);
        $out = [];
        foreach ($names as $n) {
            if ($n === '.' || $n === '..') {
                continue;
            }
            $childAbs = $abs . '/' . $n;
            if ($ctx->jail->isForbidden($childAbs)) {
                continue;
            }
            $st = FsUtil::stat($childAbs, $display === '.' ? $n : rtrim($display, '/') . '/' . $n);
            if ($st !== null) {
                $out[] = $st;
            }
        }
        return $out;
    }

    /**
     * @param array{path: string, offset: int, length: int} $p
     * @return array{dataB64: string, eof: bool, size: int}
     */
    public static function readChunk(array $p, Context $ctx): array
    {
        $abs = $ctx->jail->resolve($p['path']);
        if (!is_file($abs)) {
            throw AgentException::notFound('file not found');
        }
        $fh = @fopen($abs, 'rb');
        if ($fh === false) {
            throw AgentException::internal('cannot open file');
        }
        try {
            $size = (int) fstat($fh)['size'];
            $data = '';
            if ($p['offset'] < $size) {
                if (fseek($fh, $p['offset']) !== 0) {
                    throw AgentException::internal('cannot seek');
                }
                $want = min($p['length'], self::MAX_CHUNK);
                while (strlen($data) < $want) {
                    $chunk = fread($fh, $want - strlen($data));
                    if ($chunk === false || $chunk === '') {
                        break;
                    }
                    $data .= $chunk;
                }
            }
        } finally {
            fclose($fh);
        }
        return [
            'dataB64' => base64_encode($data),
            'eof' => $p['offset'] + strlen($data) >= $size,
            'size' => $size,
        ];
    }

    /**
     * @param array{path: string, offset: int, dataB64: string, truncate: bool, mode: int|null} $p
     * @return array{bytesWritten: int}
     */
    public static function writeChunk(array $p, Context $ctx): array
    {
        $abs = $ctx->jail->resolve($p['path']);
        $data = base64_decode($p['dataB64'], true);
        if ($data === false) {
            throw AgentException::invalidParams('dataB64 is not valid base64');
        }
        if (strlen($data) > self::MAX_CHUNK) {
            throw AgentException::invalidParams('chunk too large');
        }
        if (is_dir($abs)) {
            throw AgentException::invalidParams('path is a directory');
        }
        FsUtil::mkdirs(dirname($abs));
        $fh = @fopen($abs, 'c+b');
        if ($fh === false) {
            throw AgentException::internal('cannot open file for writing');
        }
        try {
            if (!flock($fh, LOCK_EX)) {
                throw AgentException::internal('cannot lock file');
            }
            if ($p['truncate'] && !ftruncate($fh, $p['offset'])) {
                throw AgentException::internal('cannot truncate');
            }
            if (fseek($fh, $p['offset']) !== 0) {
                throw AgentException::internal('cannot seek');
            }
            FsUtil::writeAll($fh, $data);
            fflush($fh);
            flock($fh, LOCK_UN);
        } finally {
            fclose($fh);
        }
        if ($p['mode'] !== null) {
            @chmod($abs, $p['mode'] & 0777);
        }
        return ['bytesWritten' => strlen($data)];
    }

    /**
     * @param array{path: string, recursive: bool, mode: int|null} $p
     */
    public static function mkdir(array $p, Context $ctx): object
    {
        $abs = $ctx->jail->resolve($p['path']);
        $mode = ($p['mode'] ?? 0755) & 0777;
        if (is_dir($abs)) {
            return (object) [];
        }
        if (file_exists($abs)) {
            throw AgentException::invalidParams('path exists and is not a directory');
        }
        if ($p['recursive']) {
            FsUtil::mkdirs($abs, $mode);
        } elseif (!@mkdir($abs, $mode)) {
            throw is_dir(dirname($abs)) ? AgentException::internal('cannot create directory')
                : AgentException::notFound('parent directory does not exist');
        }
        @chmod($abs, $mode);
        return (object) [];
    }

    /**
     * @param array{from: string, to: string} $p
     */
    public static function rename(array $p, Context $ctx): object
    {
        $from = $ctx->jail->resolveNoFollow($p['from']);
        $to = $ctx->jail->resolveNoFollow($p['to']);
        if (!file_exists($from) && !is_link($from)) {
            throw AgentException::notFound('source does not exist');
        }
        self::assertNotRoot($from, $ctx);
        if (is_dir($from) && !is_link($from) && $ctx->jail->containsForbidden($from)) {
            throw AgentException::jail('directory contains agent files');
        }
        if (!is_dir(dirname($to))) {
            throw AgentException::notFound('target directory does not exist');
        }
        if (!@rename($from, $to)) {
            throw AgentException::internal('rename failed');
        }
        return (object) [];
    }

    /**
     * @param array{path: string, recursive: bool} $p
     */
    public static function remove(array $p, Context $ctx): object
    {
        $abs = $ctx->jail->resolveNoFollow($p['path']);
        if (!file_exists($abs) && !is_link($abs)) {
            return (object) [];
        }
        self::assertNotRoot($abs, $ctx);
        if (is_dir($abs) && !is_link($abs)) {
            if ($p['recursive']) {
                if ($ctx->jail->containsForbidden($abs)) {
                    throw AgentException::jail('directory contains agent files');
                }
                FsUtil::removeTree($abs);
            } elseif (!@rmdir($abs)) {
                throw AgentException::internal('cannot remove directory (not empty?)');
            }
            return (object) [];
        }
        if (!@unlink($abs)) {
            throw AgentException::internal('cannot remove file');
        }
        return (object) [];
    }

    private static function assertNotRoot(string $abs, Context $ctx): void
    {
        $roots = [$ctx->config->wpRoot];
        if ($ctx->config->outsideDocrootDir !== null) {
            $roots[] = $ctx->config->outsideDocrootDir;
        }
        if (in_array($abs, $roots, true)) {
            throw AgentException::jail('refusing to move or remove an allowed root');
        }
    }
}
