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
 * - nothing is ever written through a symlink; symlinked parent dirs must resolve inside destDir (or,
 *   when they pre-date the extraction, inside the jail); every target is re-checked after realpath;
 * - files are written to a temporary sibling and renamed into place when complete;
 * - symlink and hard-link entries are skipped (and counted in `skippedLinks`) unless the config sets
 *   `extractLinks`; then links are created last and every one that resolves outside destDir or into an
 *   agent-reserved path is removed; hard links are copied from inside destDir only;
 * - modes are masked with 0755 (no setuid/setgid/sticky, nothing group/world-writable);
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
            'delayed' => [],
            'skippedLinks' => 0,
            'allowLinks' => $ctx->config->extractLinks,
        ];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        $src = $state['gzip'] ? new GzipReader($state['archive'], $state['pos']) : new PlainReader($state['archive'], $state['pos']);
        $tar = new TarReader($src);
        $out = null;
        if ($state['cur'] !== null) {
            $tar->resumeInData($state['cur']['remaining'], $state['cur']['padding']);
            $out = $this->openOutput($state['cur']['tmp'], $state['cur']['off']);
        }
        try {
            while (true) {
                if ($state['cur'] !== null) {
                    if ($out === null) {
                        $out = $this->openOutput($state['cur']['tmp'], $state['cur']['off']);
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
                        $this->createDelayedLinks($state, $ctx);
                        return ['fileCount' => $state['fileCount'], 'skippedLinks' => $state['skippedLinks']];
                    }
                    $state['entries']++;
                    $this->handleEntry($state, $ctx, $tar, $e);
                    if ($state['cur'] === null) {
                        // Skipped or data-less entry: consume its data now, so a checkpoint taken
                        // below always sits on an entry boundary.
                        $tar->skipData();
                    }
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
        $this->ensureParents($ctx, $state, $rel);
        // Check where the entry really lands (parents may be symlinked directories).
        $realParent = realpath(dirname($target));
        if ($realParent === false) {
            throw AgentException::internal('cannot resolve the parent of ' . $rel);
        }
        $realTarget = $realParent . '/' . PathJail::baseName($target);
        if ($ctx->jail->isForbidden($realTarget) || !$ctx->jail->isWithinRoots($realTarget)) {
            throw AgentException::jail('archive entry resolves outside the allowed roots');
        }
        $target = $realTarget;
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
                @chmod($target, ($e['mode'] & 0755) | 0700);
                return;
            case '0':
                if ($exists) {
                    if (!$state['overwrite']) {
                        return;
                    }
                    if (is_dir($target) && !is_link($target)) {
                        throw AgentException::internal('a directory is in the way of ' . $rel);
                    }
                }
                // Written to a temporary sibling and renamed into place when complete: never writes
                // through a symlink or into a hard-linked inode, and a slice killed mid-file leaves
                // no truncated file behind (important with overwrite=false).
                $state['fileCount']++;
                $state['cur'] = [
                    'abs' => $target,
                    'tmp' => dirname($target) . '/.' . substr(PathJail::baseName($target), 0, 200) . '.autowp-part',
                    'off' => 0,
                    'mode' => $e['mode'] & 0755, // never world/group-writable, never setuid
                    'mtime' => $e['mtime'],
                    'remaining' => $e['size'],
                    'padding' => 0,
                ];
                $fh = $this->openOutput($state['cur']['tmp'], 0);
                fclose($fh);
                if ($e['size'] === 0) {
                    $this->finishFile($state['cur']);
                    $state['cur'] = null;
                }
                return;
            case '2':
                // Links are refused unless the operator enabled them (config extractLinks). Even then
                // they are created only after every other entry (like GNU tar's delayed links) and
                // re-validated as a set, so a later entry cannot change what an earlier link means.
                if (!$state['allowLinks'] || !self::linkStaysInside($rel, $e['link']) || count($state['delayed']) >= 100000) {
                    $state['skippedLinks']++;
                    $ctx->audit->record('extract.skip_link', ['entry' => substr($rel, 0, 200)]);
                    return;
                }
                if ($exists && (!$state['overwrite'] || (is_dir($target) && !is_link($target)))) {
                    return;
                }
                $state['delayed'][] = [$target, $e['link']];
                return;
            case '1':
                $from = false;
                if ($state['allowLinks']) {
                    try {
                        $from = realpath($dest . '/' . PathJail::safeRelative($e['link']));
                    } catch (AgentException $ex) {
                        $from = false;
                    }
                }
                if ($from === false || !PathJail::isInside($from, $dest) || $ctx->jail->isForbidden($from)
                    || !$ctx->jail->isWithinRoots($from) || !is_file($from)) {
                    $state['skippedLinks']++;
                    $ctx->audit->record('extract.skip_link', ['entry' => substr($rel, 0, 200)]);
                    return;
                }
                if ($exists && (!$state['overwrite'] || (is_dir($target) && !is_link($target)))) {
                    return;
                }
                // Copy to a temporary sibling and rename into place (never into a shared inode).
                $cur = ['abs' => $target, 'tmp' => dirname($target) . '/.' . substr(PathJail::baseName($target), 0, 200) . '.autowp-part',
                    'mode' => $e['mode'] & 0755, 'mtime' => $e['mtime']];
                if (is_link($cur['tmp'])) {
                    @unlink($cur['tmp']);
                }
                if (!@copy($from, $cur['tmp'])) {
                    throw AgentException::internal('cannot copy hard-linked entry ' . $rel);
                }
                $this->finishFile($cur);
                $state['fileCount']++;
                return;
            default:
                return; // devices, fifos, sparse and vendor types are skipped
        }
    }

    /** Creates the entry's parent directories inside $dest, refusing to traverse symlinks. */
    /** @param array<string, mixed> $state */
    private function ensureParents(Context $ctx, array $state, string $rel): void
    {
        $dest = $state['dest'];
        $segs = explode('/', $rel);
        array_pop($segs);
        $cur = $dest;
        foreach ($segs as $seg) {
            $cur .= '/' . $seg;
            if (is_link($cur)) {
                // A symlinked directory is traversed only when it resolves inside destDir and not into
                // an agent-reserved path; anything else aborts the extraction.
                $real = realpath($cur);
                $ok = $real !== false && is_dir($real) && !$ctx->jail->isForbidden($real) && PathJail::isInside($real, $dest);
                if (!$ok) {
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

    /**
     * Creates the deferred symlinks, then removes every created link that resolves outside destDir,
     * into an agent-reserved path, or nowhere, until the set is stable.
     *
     * @param array<string, mixed> $state
     */
    private function createDelayedLinks(array &$state, Context $ctx): void
    {
        $created = [];
        foreach ($state['delayed'] as [$target, $link]) {
            $parent = realpath(dirname($target));
            if ($parent === false || !PathJail::isInside($parent, $state['dest']) || $ctx->jail->isForbidden($parent)) {
                $state['skippedLinks']++;
                continue;
            }
            if (is_link($target) || is_file($target)) {
                @unlink($target);
            }
            if (!file_exists($target) && @symlink($link, $target)) {
                $created[] = $target;
            } else {
                $state['skippedLinks']++;
            }
        }
        $state['delayed'] = [];
        do {
            $removed = false;
            foreach ($created as $i => $target) {
                $real = realpath($target);
                if ($real === false || !PathJail::isInside($real, $state['dest']) || $ctx->jail->isForbidden($real)
                    || !$ctx->jail->isWithinRoots($real)) {
                    @unlink($target);
                    unset($created[$i]);
                    $state['skippedLinks']++;
                    $removed = true;
                }
            }
        } while ($removed);
        $state['fileCount'] += count($created);
    }

    /**
     * Resolves $path like the kernel would (realpath of the longest existing prefix, lexical for the
     * rest) and checks it stays inside $base.
     */
    public static function resolvesInside(string $path, string $base): bool
    {
        $parts = explode('/', $path);
        $tail = [];
        while ($parts !== []) {
            $prefix = implode('/', $parts);
            $real = $prefix === '' ? '/' : realpath($prefix);
            if ($real !== false) {
                try {
                    $full = PathJail::normalize($real . '/' . implode('/', $tail));
                } catch (AgentException $e) {
                    return false;
                }
                return PathJail::isInside($full, $base);
            }
            array_unshift($tail, (string) array_pop($parts));
        }
        return false;
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
        @chmod($cur['tmp'], $cur['mode']);
        @touch($cur['tmp'], max(0, (int) $cur['mtime']));
        if (is_link($cur['abs'])) {
            @unlink($cur['abs']);
        }
        if (!@rename($cur['tmp'], $cur['abs'])) {
            @unlink($cur['tmp']);
            throw AgentException::internal('cannot move extracted file into place');
        }
    }

    public function progress(array $state): array
    {
        $done = isset($state['pos']['memberOffset']) ? $state['pos']['memberOffset'] : ($state['pos']['logical'] ?? 0);
        return ['done' => $done, 'total' => $state['size'], 'message' => $state['fileCount'] . ' files extracted'];
    }
}
