<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

/**
 * Incremental SQL statement splitter for dump files, aware of '…', "…" and `…` quoting (with backslash
 * escapes), `-- `, `#` and `/* … *\/` comments (executable `/*! … *\/` comments count as code) and the
 * mysql client's `DELIMITER` command. Each statement reports the logical byte offset just past its
 * delimiter so an import can resume exactly there.
 */
final class SqlSplitter
{
    private const NORMAL = 0;
    private const SQUOTE = 1;
    private const DQUOTE = 2;
    private const BTICK = 3;
    private const LINE = 4;
    private const BLOCK = 5;

    /** @var string */
    private $buf = '';
    /** @var int scan position in $buf */
    private $i = 0;
    /** @var int start of the current statement in $buf */
    private $start = 0;
    /** @var int logical offset of $buf[0] */
    private $base;
    /** @var int */
    private $state = self::NORMAL;
    /** @var bool */
    private $hasCode = false;
    /** @var string */
    private $delim;

    public function __construct(int $startOffset = 0, string $delimiter = ';')
    {
        $this->base = $startOffset;
        $this->delim = $delimiter;
    }

    public function delimiter(): string
    {
        return $this->delim;
    }

    /**
     * @return array<int, array{sql: string, end: int, delim: string}>
     */
    public function feed(string $chunk): array
    {
        $this->buf .= $chunk;
        $out = $this->scan(false);
        $this->compact();
        return $out;
    }

    /**
     * Flushes a trailing statement that has no delimiter.
     *
     * @return array<int, array{sql: string, end: int, delim: string}>
     */
    public function finish(): array
    {
        $out = $this->scan(true);
        $rest = trim((string) substr($this->buf, $this->start));
        if ($this->hasCode && $rest !== '') {
            $out[] = ['sql' => $rest, 'end' => $this->base + strlen($this->buf), 'delim' => $this->delim];
        }
        $this->base += strlen($this->buf);
        $this->buf = '';
        $this->i = $this->start = 0;
        $this->hasCode = false;
        $this->state = self::NORMAL;
        return $out;
    }

    /** Comments before any code are not part of the statement. */
    private function dropLeadingComment(): void
    {
        if (!$this->hasCode) {
            $this->start = $this->i;
        }
    }

    private function compact(): void
    {
        if ($this->start > 0) {
            $this->buf = (string) substr($this->buf, $this->start);
            $this->i -= $this->start;
            $this->base += $this->start;
            $this->start = 0;
        }
    }

    /**
     * @return array<int, array{sql: string, end: int, delim: string}>
     */
    private function scan(bool $final): array
    {
        $out = [];
        $buf = &$this->buf;
        while (true) {
            $n = strlen($buf);
            if ($this->i >= $n) {
                break;
            }
            $limit = $final ? $n : $n - max(2, strlen($this->delim));
            switch ($this->state) {
                case self::NORMAL:
                    if (!$this->hasCode) {
                        $this->i += strspn($buf, " \t\r\n", $this->i);
                        if ($this->i >= $n) {
                            break 2;
                        }
                        $c0 = $buf[$this->i];
                        if ($c0 === 'D' || $c0 === 'd') {
                            if (!$final && $n - $this->i < 10) {
                                break 2;
                            }
                            if (strncasecmp((string) substr($buf, $this->i, 9), 'delimiter', 9) === 0
                                && ($n - $this->i === 9 || ctype_space($buf[$this->i + 9]))) {
                                $nl = strpos($buf, "\n", $this->i);
                                if ($nl === false && !$final) {
                                    break 2;
                                }
                                $lineEnd = $nl === false ? $n : $nl;
                                $line = trim((string) substr($buf, $this->i + 9, $lineEnd - $this->i - 9));
                                $parts = preg_split('/\s+/', $line);
                                $new = is_array($parts) ? (string) $parts[0] : '';
                                if ($new !== '') {
                                    $this->delim = $new;
                                }
                                $this->i = $nl === false ? $n : $nl + 1;
                                $this->start = $this->i;
                                continue 2;
                            }
                        }
                    }
                    $stop = "'\"`#-/" . $this->delim[0];
                    $skip = strcspn($buf, $stop, $this->i);
                    if ($skip > 0) {
                        if (!$this->hasCode && strspn($buf, " \t\r\n", $this->i, $skip) < $skip) {
                            $this->hasCode = true;
                        }
                        $this->i += $skip;
                        continue 2;
                    }
                    if ($this->i >= $limit) {
                        break 2; // need lookahead
                    }
                    $c = $buf[$this->i];
                    $dl = strlen($this->delim);
                    if ($c === $this->delim[0] && substr_compare($buf, $this->delim, $this->i, $dl) === 0) {
                        if ($this->hasCode) {
                            $sql = trim((string) substr($buf, $this->start, $this->i - $this->start));
                            $out[] = ['sql' => $sql, 'end' => $this->base + $this->i + $dl, 'delim' => $this->delim];
                        }
                        $this->i += $dl;
                        $this->start = $this->i;
                        $this->hasCode = false;
                        continue 2;
                    }
                    $next = $this->i + 1 < $n ? $buf[$this->i + 1] : '';
                    if ($c === "'") {
                        $this->state = self::SQUOTE;
                        $this->hasCode = true;
                        $this->i++;
                    } elseif ($c === '"') {
                        $this->state = self::DQUOTE;
                        $this->hasCode = true;
                        $this->i++;
                    } elseif ($c === '`') {
                        $this->state = self::BTICK;
                        $this->hasCode = true;
                        $this->i++;
                    } elseif ($c === '#') {
                        $this->state = self::LINE;
                        $this->i++;
                    } elseif ($c === '-' && $next === '-'
                        && ($this->i + 2 >= $n || ord($buf[$this->i + 2]) <= 32)) {
                        $this->state = self::LINE;
                        $this->i += 2;
                    } elseif ($c === '/' && $next === '*') {
                        if ($this->i + 2 < $n && $buf[$this->i + 2] === '!') {
                            $this->hasCode = true; // executable comment
                        }
                        $this->state = self::BLOCK;
                        $this->i += 2;
                    } else {
                        $this->hasCode = true;
                        $this->i++;
                    }
                    break;
                case self::SQUOTE:
                case self::DQUOTE:
                    $q = $this->state === self::SQUOTE ? "'" : '"';
                    $this->i += strcspn($buf, '\\' . $q, $this->i);
                    if ($this->i >= $n) {
                        break 2;
                    }
                    if ($buf[$this->i] === '\\') {
                        if ($this->i + 1 >= $n && !$final) {
                            break 2;
                        }
                        $this->i += 2;
                    } else {
                        $this->state = self::NORMAL;
                        $this->i++;
                    }
                    break;
                case self::BTICK:
                    $p = strpos($buf, '`', $this->i);
                    if ($p === false) {
                        $this->i = $n;
                        break 2;
                    }
                    $this->i = $p + 1;
                    $this->state = self::NORMAL;
                    break;
                case self::LINE:
                    $p = strpos($buf, "\n", $this->i);
                    if ($p === false) {
                        $this->i = $n;
                        break 2;
                    }
                    $this->i = $p + 1;
                    $this->state = self::NORMAL;
                    $this->dropLeadingComment();
                    break;
                case self::BLOCK:
                    $p = strpos($buf, '*/', $this->i);
                    if ($p === false) {
                        $this->i = max($this->i, $n - 1);
                        break 2;
                    }
                    $this->i = $p + 2;
                    $this->state = self::NORMAL;
                    $this->dropLeadingComment();
                    break;
            }
        }
        return $out;
    }
}
