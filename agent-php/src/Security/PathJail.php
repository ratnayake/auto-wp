<?php

declare(strict_types=1);

namespace AutoWp\Agent\Security;

use AutoWp\Agent\AgentException;

/**
 * Resolves client paths and confines them to the allowed roots (WP root and the optional outside-docroot
 * directory). Relative paths resolve against the WP root. Symlinks are resolved with realpath() for the
 * existing part of the path; the non-existent tail is normalised lexically. The agent's own directory,
 * its data dir and its config are always forbidden.
 */
final class PathJail
{
    /** @var string[] realpath'd allowed roots */
    private $roots = [];
    /** @var string[] realpath'd (or normalised) forbidden paths */
    private $forbidden = [];
    /** @var string */
    private $base;

    /**
     * @param string[] $roots
     * @param string[] $forbidden
     */
    public function __construct(string $base, array $roots, array $forbidden)
    {
        $realBase = realpath($base);
        if ($realBase === false) {
            throw new \InvalidArgumentException('jail base does not exist');
        }
        $this->base = $realBase;
        foreach ($roots as $r) {
            $rr = realpath($r);
            if ($rr !== false) {
                $this->roots[] = $rr;
            }
        }
        foreach ($forbidden as $f) {
            $rf = realpath($f);
            $this->forbidden[] = $rf !== false ? $rf : self::normalize($f);
        }
    }

    public function base(): string
    {
        return $this->base;
    }

    /**
     * Resolves a path following a final symlink (use for reads, writes and directory listings).
     */
    public function resolve(string $path): string
    {
        $abs = $this->absolute($path);
        $real = $this->realish($abs);
        $this->assertAllowed($real);
        return $real;
    }

    /**
     * Resolves the parent directory but keeps the final component as-is (use for lstat, remove and
     * rename, which act on a symlink itself rather than its target).
     */
    public function resolveNoFollow(string $path): string
    {
        $abs = $this->absolute($path);
        if ($abs === '/') {
            throw AgentException::jail();
        }
        $parent = $this->realish(dirname($abs));
        $name = basename($abs);
        $full = $parent === '/' ? '/' . $name : $parent . '/' . $name;
        $this->assertAllowed($full);
        // A symlink final component must not point at a forbidden location either.
        if (is_link($full)) {
            $target = realpath($full);
            if ($target !== false) {
                $this->assertNotForbidden($target);
            }
        }
        return $full;
    }

    /** True if a forbidden path lies inside `$dir` (so recursive operations on `$dir` must skip it). */
    public function containsForbidden(string $dir): bool
    {
        foreach ($this->forbidden as $f) {
            if (self::isInside($f, $dir) && $f !== $dir) {
                return true;
            }
        }
        return false;
    }

    public function isForbidden(string $abs): bool
    {
        foreach ($this->forbidden as $f) {
            if (self::isInside($abs, $f)) {
                return true;
            }
        }
        return false;
    }

    /** @return string[] */
    public function forbiddenPaths(): array
    {
        return $this->forbidden;
    }

    public function isWithinRoots(string $abs): bool
    {
        foreach ($this->roots as $r) {
            if (self::isInside($abs, $r)) {
                return true;
            }
        }
        return false;
    }

    private function absolute(string $path): string
    {
        if ($path === '' || strpos($path, "\0") !== false) {
            throw AgentException::jail('invalid path');
        }
        if (strlen($path) > 4096) {
            throw AgentException::jail('path too long');
        }
        if ($path[0] !== '/') {
            $path = $this->base . '/' . $path;
        }
        return self::normalize($path);
    }

    /** realpath() the longest existing prefix, then append the (lexically normalised) remainder. */
    private function realish(string $abs): string
    {
        $real = realpath($abs);
        if ($real !== false) {
            return $real;
        }
        $tail = [];
        $cur = $abs;
        while (true) {
            $parent = dirname($cur);
            array_unshift($tail, basename($cur));
            if ($parent === $cur) {
                throw AgentException::jail();
            }
            $cur = $parent;
            $r = realpath($cur);
            if ($r !== false) {
                // A dangling symlink in the tail could later be created through; refuse it.
                $probe = $r;
                foreach ($tail as $seg) {
                    $probe = ($probe === '/' ? '' : $probe) . '/' . $seg;
                    if (is_link($probe)) {
                        throw AgentException::jail('dangling symlink in path');
                    }
                }
                return $probe;
            }
        }
    }

    private function assertAllowed(string $real): void
    {
        if (!$this->isWithinRoots($real)) {
            throw AgentException::jail();
        }
        $this->assertNotForbidden($real);
    }

    private function assertNotForbidden(string $real): void
    {
        if ($this->isForbidden($real)) {
            throw AgentException::jail('path is reserved for the agent');
        }
    }

    public static function isInside(string $path, string $root): bool
    {
        if ($root === '/') {
            return true;
        }
        return $path === $root || strncmp($path, $root . '/', strlen($root) + 1) === 0;
    }

    /**
     * Lexical normalisation of an absolute POSIX path. `..` above the filesystem root is refused.
     */
    public static function normalize(string $path): string
    {
        if (strpos($path, "\0") !== false) {
            throw AgentException::jail('invalid path');
        }
        $out = [];
        foreach (explode('/', $path) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                if ($out === []) {
                    throw AgentException::jail();
                }
                array_pop($out);
                continue;
            }
            $out[] = $seg;
        }
        return '/' . implode('/', $out);
    }

    /**
     * Validates a path that must stay relative (archive entries, `paths` lists): no absolute paths, no
     * `..`, no NUL. Returns the normalised relative form (no leading/trailing slash).
     */
    public static function safeRelative(string $rel): string
    {
        if ($rel === '' || strpos($rel, "\0") !== false || $rel[0] === '/') {
            throw AgentException::jail('invalid relative path');
        }
        $out = [];
        foreach (explode('/', $rel) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                throw AgentException::jail('relative path escapes its base');
            }
            $out[] = $seg;
        }
        if ($out === []) {
            throw AgentException::jail('empty relative path');
        }
        return implode('/', $out);
    }
}
