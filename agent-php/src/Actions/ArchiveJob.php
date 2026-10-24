<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipWriter;
use AutoWp\Agent\Archive\TarWriter;
use AutoWp\Agent\Context;
use AutoWp\Agent\Fs\ExcludeMatcher;
use AutoWp\Agent\Fs\FsUtil;
use AutoWp\Agent\Fs\TreeWalker;
use AutoWp\Agent\Jobs\JobHandler;
use AutoWp\Agent\Security\PathJail;

/**
 * fs.archive: .tar.gz of sourceDir. Uses `tar` (argv via proc_open, file list from our own walker so
 * excludes behave identically) when binaries are allowed in this mode; otherwise the native streaming
 * ustar+gzip writer, resumable per slice and even mid-file.
 */
final class ArchiveJob implements JobHandler
{
    private const CHUNK = 1048576;

    public function init(array $params, Context $ctx): array
    {
        $src = $ctx->jail->resolve($params['sourceDir']);
        if (!is_dir($src)) {
            throw AgentException::notFound('sourceDir is not a directory');
        }
        $dest = $ctx->jail->resolve($params['dest']);
        if (is_dir($dest)) {
            throw AgentException::invalidParams('dest is a directory');
        }
        FsUtil::mkdirs(dirname($dest));
        $paths = null;
        if ($params['paths'] !== null) {
            $paths = [];
            foreach ($params['paths'] as $p) {
                $rel = PathJail::safeRelative($p);
                $ctx->jail->resolveNoFollow($src . '/' . $rel);
                $paths[] = $rel;
            }
        }
        $useTar = $ctx->mayUseBinaries() && $ctx->binaries->find('tar') !== null;
        return [
            'src' => $src,
            'dest' => $dest,
            'excludes' => $params['excludes'],
            'paths' => $paths,
            'walker' => null,
            'gz' => 0,
            'cur' => null,
            'fileCount' => 0,
            'bytes' => 0,
            'method' => $useTar ? 'tar' : 'native',
        ];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        if ($state['method'] === 'tar') {
            return $this->runTar($state, $ctx);
        }
        $walker = new TreeWalker(
            $state['src'],
            new ExcludeMatcher($state['excludes']),
            WalkSupport::skipper($ctx, [$state['dest']]),
            $state['walker'],
            $state['paths']
        );
        $gz = new GzipWriter($state['dest'], $state['gz']);
        $tar = new TarWriter($gz);
        $finished = false;
        try {
            // At least one unit of work per slice, so even a tiny budget makes progress.
            do {
                if ($state['cur'] !== null) {
                    $this->copyFile($state, $tar, $deadline);
                    continue;
                }
                $e = $walker->next();
                if ($e === null) {
                    $tar->finish();
                    $finished = true;
                    break;
                }
                $this->addEntry($state, $tar, $e);
            } while (microtime(true) < $deadline);
        } finally {
            $state['walker'] = $walker->state();
            $state['gz'] = $gz->close();
        }
        if (!$finished) {
            return null;
        }
        return [
            'fileCount' => $state['fileCount'],
            'bytes' => $state['bytes'],
            'archiveBytes' => $state['gz'],
            'sha256' => FsUtil::sha256File($state['dest']),
        ];
    }

    /**
     * @param array<string, mixed> $state
     * @param array{rel: string, abs: string, type: string, size: int, mode: int, mtime: int, link: string} $e
     */
    private function addEntry(array &$state, TarWriter $tar, array $e): void
    {
        $mode = $e['mode'] & 07777;
        if ($e['type'] === 'dir') {
            $tar->header($e['rel'], '5', 0, $mode, $e['mtime']);
            return;
        }
        if ($e['type'] === 'symlink') {
            $tar->header($e['rel'], '2', 0, $mode, $e['mtime'], $e['link']);
            $state['fileCount']++;
            return;
        }
        if ($e['type'] !== 'file') {
            return; // sockets, fifos, devices
        }
        if (!is_readable($e['abs'])) {
            throw AgentException::internal('cannot read file: ' . $e['rel']);
        }
        $tar->header($e['rel'], '0', $e['size'], $mode, $e['mtime']);
        $state['fileCount']++;
        $state['bytes'] += $e['size'];
        $state['cur'] = ['abs' => $e['abs'], 'rel' => $e['rel'], 'size' => $e['size'], 'off' => 0];
    }

    /**
     * Copies (part of) the current file. Exactly the size announced in the header is written: a file
     * that shrank meanwhile is zero-padded, one that grew is cut.
     *
     * @param array<string, mixed> $state
     */
    private function copyFile(array &$state, TarWriter $tar, float $deadline): void
    {
        $cur = $state['cur'];
        $fh = @fopen($cur['abs'], 'rb');
        if ($fh !== false && $cur['off'] > 0 && fseek($fh, $cur['off']) !== 0) {
            fclose($fh);
            $fh = false;
        }
        try {
            while ($cur['off'] < $cur['size']) {
                $want = min(self::CHUNK, $cur['size'] - $cur['off']);
                $chunk = $fh === false ? '' : (string) fread($fh, $want);
                if ($chunk === '') {
                    $chunk = str_repeat("\0", $want);
                }
                $tar->write($chunk);
                $cur['off'] += strlen($chunk);
                if (microtime(true) >= $deadline) {
                    break;
                }
            }
        } finally {
            if ($fh !== false) {
                fclose($fh);
            }
        }
        if ($cur['off'] >= $cur['size']) {
            $tar->pad($cur['size']);
            $state['cur'] = null;
        } else {
            $state['cur'] = $cur;
        }
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, mixed>
     */
    private function runTar(array &$state, Context $ctx): array
    {
        @set_time_limit(0);
        $walker = new TreeWalker(
            $state['src'],
            new ExcludeMatcher($state['excludes']),
            WalkSupport::skipper($ctx, [$state['dest']]),
            null,
            $state['paths']
        );
        $tmpDir = $ctx->data->ensure('tmp');
        $list = $tmpDir . '/tar-list-' . bin2hex(random_bytes(8));
        $errFile = $list . '.err';
        $fh = fopen($list, 'wb');
        if ($fh === false) {
            throw AgentException::internal('cannot create file list');
        }
        try {
            while (($e = $walker->next()) !== null) {
                if (!in_array($e['type'], ['file', 'dir', 'symlink'], true)) {
                    continue;
                }
                if ($e['type'] !== 'dir') {
                    $state['fileCount']++;
                    $state['bytes'] += $e['size'];
                }
                // "./" prefix: names starting with "-" must never be read as options.
                FsUtil::writeAll($fh, './' . $e['rel'] . "\0");
            }
            fclose($fh);
            $fh = null;
            @unlink($state['dest']);
            $pipes = [];
            $proc = $ctx->binaries->open(
                ['tar', '-c', '-z', '-f', $state['dest'], '-C', $state['src'], '--no-recursion', '--null', '-T', $list],
                [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', $errFile, 'w']],
                $pipes
            );
            $code = proc_close($proc);
            if ($code !== 0 && !($code === 1 && $this->isGnuTar($ctx))) {
                $err = substr((string) @file_get_contents($errFile), 0, 400);
                throw AgentException::internal('tar failed (exit ' . $code . '): ' . trim($err));
            }
        } finally {
            if (is_resource($fh)) {
                fclose($fh);
            }
            @unlink($list);
            @unlink($errFile);
        }
        @chmod($state['dest'], 0600);
        clearstatcache(true, $state['dest']);
        return [
            'fileCount' => $state['fileCount'],
            'bytes' => $state['bytes'],
            'archiveBytes' => (int) filesize($state['dest']),
            'sha256' => FsUtil::sha256File($state['dest']),
        ];
    }

    private function isGnuTar(Context $ctx): bool
    {
        return strpos($ctx->binaries->version('tar'), 'GNU tar') !== false;
    }

    public function progress(array $state): array
    {
        return ['done' => $state['fileCount'], 'message' => 'archived ' . $state['bytes'] . ' bytes'];
    }
}
