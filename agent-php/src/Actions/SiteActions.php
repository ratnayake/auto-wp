<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\DataDir;
use AutoWp\Agent\Fs\FsUtil;

/** wp.maintenance, logs.tail, lock.acquire, lock.release */
final class SiteActions
{
    public const BYPASS_PATTERN = '/^[A-Za-z0-9_-]{16,128}$/D';

    /**
     * @param array{enabled: bool, bypassToken: string|null} $p
     * @return array{enabled: bool}
     */
    public static function maintenance(array $p, Context $ctx): array
    {
        $file = $ctx->config->wpRoot . '/.maintenance';
        if (!$p['enabled']) {
            if ((file_exists($file) || is_link($file)) && !@unlink($file)) {
                throw AgentException::internal('cannot remove .maintenance');
            }
            return ['enabled' => false];
        }
        $token = $p['bypassToken'];
        if ($token !== null) {
            // The token is embedded in PHP source, so only a conservative alphabet is accepted.
            if (preg_match(self::BYPASS_PATTERN, $token) !== 1) {
                throw AgentException::invalidParams('bypassToken must match [A-Za-z0-9_-]{16,128}');
            }
            $php = "<?php \$upgrading = (isset(\$_COOKIE['autowp_bypass']) && hash_equals('" . $token
                . "', (string) \$_COOKIE['autowp_bypass'])) ? 0 : time();\n";
        } else {
            $php = "<?php \$upgrading = time();\n";
        }
        if (is_link($file)) {
            @unlink($file);
        }
        $tmp = $file . '.autowp-' . bin2hex(random_bytes(6));
        if (@file_put_contents($tmp, $php) === false || !@rename($tmp, $file)) {
            @unlink($tmp);
            throw AgentException::internal('cannot write .maintenance');
        }
        @chmod($file, 0644);
        return ['enabled' => true];
    }

    /**
     * @param array{path: string, fromOffset: int, maxBytes: int} $p
     * @return array{data: string, nextOffset: int, size: int, rotated: bool}
     */
    public static function logsTail(array $p, Context $ctx): array
    {
        $abs = $ctx->jail->resolve($p['path']);
        if (!is_file($abs)) {
            throw AgentException::notFound('log file not found');
        }
        $fh = @fopen($abs, 'rb');
        if ($fh === false) {
            throw AgentException::internal('cannot open log');
        }
        try {
            $size = (int) fstat($fh)['size'];
            $offset = $p['fromOffset'];
            $rotated = false;
            if ($size < $offset) {
                $rotated = true;
                $offset = 0;
            }
            $max = min($p['maxBytes'], 8388608);
            $data = '';
            if ($offset < $size) {
                fseek($fh, $offset);
                $data = (string) fread($fh, min($max, $size - $offset));
                if ($offset + strlen($data) < $size) {
                    $data = self::trimPartialUtf8($data);
                }
            }
        } finally {
            fclose($fh);
        }
        return ['data' => $data, 'nextOffset' => $offset + strlen($data), 'size' => $size, 'rotated' => $rotated];
    }

    /** Drops an incomplete UTF-8 sequence at the end so the next read starts on a character boundary. */
    public static function trimPartialUtf8(string $s): string
    {
        $len = strlen($s);
        for ($back = 1; $back <= min(3, $len); $back++) {
            $b = ord($s[$len - $back]);
            if (($b & 0xC0) === 0x80) {
                continue; // continuation byte
            }
            if ($b >= 0xC0) {
                $need = $b >= 0xF0 ? 4 : ($b >= 0xE0 ? 3 : 2);
                if ($back < $need) {
                    return substr($s, 0, $len - $back);
                }
            }
            break;
        }
        return $s;
    }

    /**
     * @param array{runId: string, ttlSec: int} $p
     * @return array{acquired: bool, holder?: string, expiresAt?: string}
     */
    public static function lockAcquire(array $p, Context $ctx): array
    {
        return self::withLockFile($ctx, function ($fh, ?array $cur) use ($p, $ctx): array {
            $now = $ctx->now();
            if ($cur !== null && $cur['runId'] !== $p['runId'] && $cur['expires'] > $now) {
                return ['acquired' => false, 'holder' => $cur['runId'], 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $cur['expires'])];
            }
            $exp = $now + $p['ttlSec'];
            self::rewrite($fh, ['runId' => $p['runId'], 'expires' => $exp, 'acquiredAt' => $now]);
            return ['acquired' => true, 'holder' => $p['runId'], 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $exp)];
        });
    }

    /**
     * @param array{runId: string} $p
     * @return array{released: bool}
     */
    public static function lockRelease(array $p, Context $ctx): array
    {
        return self::withLockFile($ctx, function ($fh, ?array $cur) use ($p): array {
            if ($cur === null || $cur['runId'] !== $p['runId']) {
                return ['released' => false];
            }
            ftruncate($fh, 0);
            return ['released' => true];
        });
    }

    /**
     * @param callable(resource, array{runId: string, expires: int}|null): array<string, mixed> $fn
     * @return array<string, mixed>
     */
    private static function withLockFile(Context $ctx, callable $fn): array
    {
        $dir = $ctx->config->wpRoot . '/' . WalkSupport::BACKUP_DIR;
        if (is_link($dir)) {
            throw AgentException::jail('backup directory is a symlink');
        }
        if (!is_dir($dir)) {
            FsUtil::mkdirs($dir, 0750);
            self::protectBackupDir($dir);
        }
        $file = $dir . '/.lock';
        if (is_link($file)) {
            throw AgentException::jail('lock file is a symlink');
        }
        $fh = @fopen($file, 'c+');
        if ($fh === false) {
            throw AgentException::internal('cannot open lock file');
        }
        try {
            if (!flock($fh, LOCK_EX)) {
                throw new AgentException('locked', 'cannot lock');
            }
            $raw = stream_get_contents($fh);
            $cur = null;
            if (is_string($raw) && trim($raw) !== '') {
                $d = json_decode($raw, true);
                if (is_array($d) && isset($d['runId'], $d['expires']) && is_string($d['runId'])) {
                    $cur = ['runId' => $d['runId'], 'expires' => (int) $d['expires']];
                }
            }
            $out = $fn($fh, $cur);
            fflush($fh);
            flock($fh, LOCK_UN);
            return $out;
        } finally {
            fclose($fh);
        }
    }

    /** @param resource $fh */
    private static function rewrite($fh, array $data): void
    {
        ftruncate($fh, 0);
        rewind($fh);
        FsUtil::writeAll($fh, (string) json_encode($data));
    }

    /** Same deny files the backup unit writes; harmless if they already exist. */
    public static function protectBackupDir(string $dir): void
    {
        (new DataDir($dir))->ensure();
    }
}
