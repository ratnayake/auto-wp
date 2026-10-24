<?php

declare(strict_types=1);

namespace AutoWp\Agent\Fs;

/**
 * Glob excludes, relative to the walked directory, gitignore-style:
 * - a pattern without `/` matches the basename at any depth (`*.log`, `node_modules`);
 * - a pattern containing `/` is anchored to the base (`wp-content/cache`, `/wp-content/uploads/*.zip`);
 * - a trailing `/` matches directories only;
 * - `*` and `?` do not cross `/`, `**` does; `[abc]`/`[!abc]` are character classes.
 * An excluded directory is not descended into.
 */
final class ExcludeMatcher
{
    /** @var array<int, array{re: string, dirOnly: bool, base: bool}> */
    private $rules = [];

    /**
     * @param string[] $patterns
     */
    public function __construct(array $patterns)
    {
        foreach ($patterns as $p) {
            $p = trim($p);
            if (strncmp($p, './', 2) === 0) {
                $p = substr($p, 2);
            }
            if ($p === '' || $p === '/') {
                continue;
            }
            $dirOnly = substr($p, -1) === '/';
            $p = rtrim($p, '/');
            $anchored = strpos($p, '/') !== false;
            $p = ltrim($p, '/');
            if ($p === '') {
                continue;
            }
            $this->rules[] = ['re' => '#^' . self::globToRegex($p) . '$#sD', 'dirOnly' => $dirOnly, 'base' => !$anchored];
        }
    }

    public function excluded(string $rel, bool $isDir): bool
    {
        $base = basename($rel);
        foreach ($this->rules as $r) {
            if ($r['dirOnly'] && !$isDir) {
                continue;
            }
            if (preg_match($r['re'], $r['base'] ? $base : $rel) === 1) {
                return true;
            }
        }
        return false;
    }

    public static function globToRegex(string $glob): string
    {
        $re = '';
        $n = strlen($glob);
        for ($i = 0; $i < $n; $i++) {
            $c = $glob[$i];
            if ($c === '*') {
                if ($i + 1 < $n && $glob[$i + 1] === '*') {
                    $i++;
                    // `**/` also matches zero directories.
                    if ($i + 1 < $n && $glob[$i + 1] === '/') {
                        $i++;
                        $re .= '(?:.*/)?';
                    } else {
                        $re .= '.*';
                    }
                } else {
                    $re .= '[^/]*';
                }
            } elseif ($c === '?') {
                $re .= '[^/]';
            } elseif ($c === '[') {
                $end = strpos($glob, ']', $i + 2);
                if ($end === false) {
                    $re .= '\\[';
                    continue;
                }
                $cls = substr($glob, $i + 1, $end - $i - 1);
                $neg = $cls !== '' && ($cls[0] === '!' || $cls[0] === '^');
                if ($neg) {
                    $cls = substr($cls, 1);
                }
                $re .= '[' . ($neg ? '^' : '') . str_replace(['\\', ']', '#'], ['\\\\', '\\]', '\\#'], $cls) . ']';
                $i = $end;
            } else {
                $re .= preg_quote($c, '#');
            }
        }
        return $re;
    }
}
