<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipReader;
use AutoWp\Agent\Archive\PlainReader;
use AutoWp\Agent\Archive\TarReader;
use AutoWp\Agent\Context;
use AutoWp\Agent\Fs\FsUtil;
use AutoWp\Agent\Jobs\JobHandler;
use AutoWp\Agent\Security\PathJail;

/**
 * fs.extract: native, resumable .tar(.gz) extraction with entry path-traversal protection:
 * - entry names must be relative and free of `..` (otherwise the job fails with path_jail);
 * - nothing is ever written through a symlink (existing symlinks in the way are replaced or refused);
 * - symlink entries are only created when their target stays inside destDir; hard links are copied;
 * - agent-reserved paths are skipped; setuid/setgid/sticky bits are dropped.
 */
final class ExtractJob implements JobHandler
{
    private const CHUNK = 1048576;

    public function init(array $params, Context $ctx): array
    {
        $archive = $ctx->jail->resolve($params['archive']);
        if (!is_file($archive)) {
            throw AgentException::notFound('archive not found');
        }
        $dest = $ctx->jail->resolve($params['destDir']);
        FsUtil::mkdirs($dest);
        $dest = (string) realpath($dest);
        return [
            'archive' => $archive,
            'dest' => $dest,
            'overwrite' => $params['overwrite'],
            'gzip' => PlainReader::isGzip($archive),
            'pos' => null,
            'cur' => null,
            'fileCount' => 0,
            'entries' => 0,
            'size' => (int) filesize($archive),
        ];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        $src = $state['gzip'] ? new GzipReader($state['archive'], $state['pos']) : new PlainReader($state['archive'], $state['pos']);
        $tar = new TarReader($src);
        $out = null;
        if ($state['cur'] !== null) {
            $tar->resumeInData($state['cur']['remaining'], $state['cur']['padding']);
            $out = $this->openOutput($state['cur']['abs'], $state['cur']['off']);
        }
        try {
            while (true) {
                if ($state['cur'] !== null) {
                    if ($out === null) {
                        $out = $this->openOutput($state['cur']['abs'], $state['cur']['off']);
                    }
                    $chunk = $tar->readData(self::CHUNK);
                    FsUtil::writeAll($out, $chunk);
                    $state['cur']['off'] += strlen($chunk);
                    if ($tar->remaining() === 0) {
                        fclose($out);
                        $out = null;
                        $this->finishFile($state['cur']);
                        $state['cur'] = null;
                    }
                } else {
                    $e = $tar->next();
                    if ($e === null) {
                        // Drain the rest so a corrupt gzip trailer is still noticed.
                        while ($src->read(65536) !== '') {
                        }
                        return ['fileCount' => $state['fileCount']];
                    }
                    $state['entries']++;
                    $this->handleEntry($state, $ctx, $tar, $e);
                }
                if (microtime(true) >= $deadline) {
                    break;
                }
            }
        } finally {
            if ($out !== null) {
                fclose($out);
            }
        }
        $state['pos'] = $src->checkpoint();
        if ($state['cur'] !== null) {
            $state['cur']['remaining'] = $tar->remaining();
            $state['cur']['padding'] = $tar->pendingPadding();
        }
        return null;
    }

    /**
     * @param array<string, mixed> $state
     * @param array{name: string, type: string, size: int, mode: int, mtime: int, link: string} $e
     */
    private function handleEntry(array &$state, Context $ctx, TarReader $tar, array $e): void
    {
        $name = $e['name'];
        if ($name === '.' || $name === './') {
            return;
        }
        $rel = PathJail::safeRelative($name);
        $dest = $state['dest'];
        $target = $dest . '/' . $rel;
        if ($ctx->jail->isForbidden($target) || !$ctx->jail->isWithinRoots($target)) {
            return;
        }
        $this->ensureParents($ctx, $dest, $rel);
        $exists = file_exists($target) || is_link($target);

        switch ($e['type']) {
            case '5':
                if (is_link($target) || ($exists && !is_dir($target))) {
                    if (!$state['overwrite']) {
                        return;
                    }
                    if (!@unlink($target)) {
                        throw AgentException::internal('cannot replace ' . $rel);
                    }
                }
                if (!is_dir($target) && !@mkdir($target, 0755) && !is_dir($target)) {
                    throw AgentException::internal('cannot create directory ' . $rel);
                }
                @chmod($target, ($e['mode'] & 0777) | 0700);
                return;
            case '0':
                if ($exists) {
                    if (!$state['overwrite']) {
                        return;
                    }
                    if (is_dir($target) && !is_link($target)) {
                        throw AgentException::internal('a directory is in the way of ' . $rel);
                    }
                    // Unlink first: never write through a symlink or into a hard-linked inode.
                    if (!@unlink($target)) {
                        throw AgentException::internal('cannot replace ' . $rel);
                    }
                }
                $state['fileCount']++;
                $state['cur'] = [
                    'abs' => $target,
                    'off' => 0,
                    'mode' => $e['mode'] & 0777,
                    'mtime' => $e['mtime'],
                    'remaining' => $e['size'],
                    'padding' => 0,
                ];
                $fh = $this->openOutput($target, 0);
                fclose($fh);
                if ($e['size'] === 0) {
                    $this->finishFile($state['cur']);
                    $state['cur'] = null;
                }
                return;
            case '2':
                if (!self::linkStaysInside($rel, $e['link'])) {
                    $ctx->audit->record('extract.skip_symlink', ['entry' => substr($rel, 0, 200)]);
                    return;
                }
                if ($exists) {
                    if (!$state['overwrite'] || (is_dir($target) && !is_link($target))) {
                        return;
                    }
                    @unlink($target);
                }
                if (@symlink($e['link'], $target)) {
                    $state['fileCount']++;
                }
                return;
            case '1':
                try {
                    $linkRel = PathJail::safeRelative($e['link']);
                } catch (AgentException $ex) {
                    return;
                }
                $from = $dest . '/' . $linkRel;
                if (!is_file($from) || is_link($from) || ($exists && !$state['overwrite'])) {
                    return;
                }
                if (is_link($target)) {
                    @unlink($target);
                }
                if (@copy($from, $target)) {
                    $state['fileCount']++;
                }
                return;
            default:
                return; // devices, fifos, sparse and vendor types are skipped
        }
    }

    /** Creates the entry's parent directories inside $dest, refusing to traverse symlinks. */
    private function ensureParents(Context $ctx, string $dest, string $rel): void
    {
        $segs = explode('/', $rel);
        array_pop($segs);
        $cur = $dest;
        foreach ($segs as $seg) {
            $cur .= '/' . $seg;
            if (is_link($cur)) {
                // A symlinked directory is only traversed when it resolves inside the jail.
                $real = realpath($cur);
                if ($real === false || !is_dir($real) || !$ctx->jail->isWithinRoots($real) || $ctx->jail->isForbidden($real)) {
                    throw AgentException::jail('archive entry would be written through a symlink');
                }
                continue;
            }
            if (is_dir($cur)) {
                continue;
            }
            if (file_exists($cur)) {
                throw AgentException::internal('a file is in the way of a directory in the archive');
            }
            if (!@mkdir($cur, 0755) && !is_dir($cur)) {
                throw AgentException::internal('cannot create directory');
            }
        }
    }

    /** True if a relative symlink placed at $rel and pointing to $link resolves inside the base. */
    public static function linkStaysInside(string $rel, string $link): bool
    {
        if ($link === '' || $link[0] === '/' || strpos($link, "\0") !== false) {
            return false;
        }
        $depth = substr_count($rel, '/');
        $parts = $depth > 0 ? explode('/', dirname($rel)) : [];
        foreach (explode('/', $link) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                if ($parts === []) {
                    return false;
                }
                array_pop($parts);
                continue;
            }
            $parts[] = $seg;
        }
        return true;
    }

    /** @return resource */
    private function openOutput(string $abs, int $offset)
    {
        if (is_link($abs)) {
            throw AgentException::jail('refusing to write through a symlink');
        }
        $fh = @fopen($abs, $offset === 0 ? 'wb' : 'c+b');
        if ($fh === false) {
            throw AgentException::internal('cannot write extracted file');
        }
        if ($offset > 0 && (!ftruncate($fh, $offset) || fseek($fh, $offset) !== 0)) {
            fclose($fh);
            throw AgentException::internal('cannot resume extracted file');
        }
        return $fh;
    }

    /** @param array<string, mixed> $cur */
    private function finishFile(array $cur): void
    {
        @chmod($cur['abs'], $cur['mode']);
        @touch($cur['abs'], max(0, (int) $cur['mtime']));
    }

    public function progress(array $state): array
    {
        $done = isset($state['pos']['memberOffset']) ? $state['pos']['memberOffset'] : ($state['pos']['logical'] ?? 0);
        return ['done' => $done, 'total' => $state['size'], 'message' => $state['fileCount'] . ' files extracted'];
    }
}
