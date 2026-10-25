<?php

declare(strict_types=1);

namespace AutoWp\Agent\Fs;

use AutoWp\Agent\AgentException;

/**
 * Depth-first directory walker whose position is a small JSON-serialisable state, so a walk can be
 * continued in a later request. Never follows symlinks. Skips excluded entries and absolute paths for
 * which `$skip` returns true (agent dir, data dir, backup dir, the archive being written...).
 */
final class TreeWalker
{
    /** @var string */
    private $base;
    /** @var ExcludeMatcher */
    private $excludes;
    /** @var callable(string): bool */
    private $skip;
    /** @var array{stack: string[], pending: string[], pi: int} */
    private $state;

    /**
     * @param array{stack: string[], pending: string[], pi: int}|null $state
     * @param string[]|null $paths explicit relative entries to start from (instead of the whole base)
     */
    public function __construct(string $base, ExcludeMatcher $excludes, callable $skip, ?array $state = null, ?array $paths = null)
    {
        $this->base = rtrim($base, '/');
        $this->excludes = $excludes;
        $this->skip = $skip;
        if ($state !== null) {
            $this->state = $state;
        } elseif ($paths !== null) {
            $this->state = ['stack' => [], 'pending' => array_values($paths), 'pi' => 0];
        } else {
            $this->state = ['stack' => [''], 'pending' => [], 'pi' => 0];
        }
    }

    /** @return array{stack: string[], pending: string[], pi: int} */
    public function state(): array
    {
        // Compact the pending list so the persisted state does not grow with consumed entries.
        if ($this->state['pi'] > 0) {
            $this->state['pending'] = array_slice($this->state['pending'], $this->state['pi']);
            $this->state['pi'] = 0;
        }
        return $this->state;
    }

    /**
     * @return array{rel: string, abs: string, type: string, size: int, mode: int, mtime: int, link: string}|null
     */
    public function next(): ?array
    {
        while (true) {
            if ($this->state['pi'] < count($this->state['pending'])) {
                $rel = $this->state['pending'][$this->state['pi']++];
                $abs = $this->base . '/' . $rel;
                if (($this->skip)($abs)) {
                    continue;
                }
                $st = @lstat($abs);
                if ($st === false) {
                    continue; // vanished since listing
                }
                $type = self::typeOf((int) $st['mode']);
                if ($this->excludes->excluded($rel, $type === 'dir')) {
                    continue;
                }
                if ($type === 'dir') {
                    $this->state['stack'][] = $rel;
                }
                $link = '';
                if ($type === 'symlink') {
                    $l = @readlink($abs);
                    $link = $l === false ? '' : $l;
                }
                return [
                    'rel' => $rel,
                    'abs' => $abs,
                    'type' => $type,
                    'size' => $type === 'file' ? (int) $st['size'] : 0,
                    'mode' => (int) $st['mode'],
                    'mtime' => (int) $st['mtime'],
                    'link' => $link,
                ];
            }
            if ($this->state['stack'] === []) {
                return null;
            }
            $dirRel = array_pop($this->state['stack']);
            $dirAbs = $dirRel === '' ? $this->base : $this->base . '/' . $dirRel;
            $names = @scandir($dirAbs, SCANDIR_SORT_ASCENDING);
            if ($names === false) {
                throw AgentException::internal('cannot read directory: ' . ($dirRel === '' ? '.' : $dirRel));
            }
            $pending = [];
            foreach ($names as $name) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                $pending[] = $dirRel === '' ? $name : $dirRel . '/' . $name;
            }
            $this->state['pending'] = $pending;
            $this->state['pi'] = 0;
        }
    }

    public static function typeOf(int $mode): string
    {
        $fmt = $mode & 0170000;
        if ($fmt === 0100000) {
            return 'file';
        }
        if ($fmt === 0040000) {
            return 'dir';
        }
        if ($fmt === 0120000) {
            return 'symlink';
        }
        return 'other';
    }
}
