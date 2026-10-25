<?php

declare(strict_types=1);

namespace AutoWp\Agent;

/**
 * Reads DB settings from wp-config.php with the PHP tokenizer. The file is NEVER included or evaluated:
 * only constant expressions made of string/number literals and `.` concatenation are understood.
 */
final class WpConfigReader
{
    private const CONSTANTS = ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_CHARSET', 'DB_COLLATE'];

    /**
     * Locates wp-config.php the way WordPress does: in the WP root, or one directory up when that
     * directory is not itself a WordPress install.
     */
    public static function locate(string $wpRoot): ?string
    {
        $here = $wpRoot . '/wp-config.php';
        if (is_file($here)) {
            return $here;
        }
        $up = dirname($wpRoot) . '/wp-config.php';
        if (is_file($up) && !is_file(dirname($wpRoot) . '/wp-settings.php')) {
            return $up;
        }
        return null;
    }

    /**
     * @return array{DB_NAME: string, DB_USER: string, DB_PASSWORD: string, DB_HOST: string, DB_CHARSET: string, DB_COLLATE: string, table_prefix: string}
     */
    public static function readFile(string $path): array
    {
        $src = @file_get_contents($path);
        if ($src === false) {
            throw new AgentException('capability', 'wp-config.php is not readable');
        }
        return self::parse($src);
    }

    /**
     * @return array{DB_NAME: string, DB_USER: string, DB_PASSWORD: string, DB_HOST: string, DB_CHARSET: string, DB_COLLATE: string, table_prefix: string}
     */
    public static function parse(string $src): array
    {
        $tokens = self::significantTokens($src);
        $found = [];
        $prefix = null;
        $n = count($tokens);
        for ($i = 0; $i < $n; $i++) {
            $t = $tokens[$i];
            // define( 'NAME', <expr> )
            if (is_array($t) && $t[0] === T_STRING && strtolower($t[1]) === 'define'
                && self::isChar($tokens[$i + 1] ?? null, '(')
                && !self::isObjectOperator($tokens[$i - 1] ?? null)) {
                $nameTok = $tokens[$i + 2] ?? null;
                if (!is_array($nameTok) || $nameTok[0] !== T_CONSTANT_ENCAPSED_STRING) {
                    continue;
                }
                $name = self::decodeString($nameTok[1]);
                if ($name === null || !in_array($name, self::CONSTANTS, true) || isset($found[$name])) {
                    continue;
                }
                if (!self::isChar($tokens[$i + 3] ?? null, ',')) {
                    continue;
                }
                $j = $i + 4;
                $value = self::evalExpr($tokens, $j, [')', ',']);
                if ($value !== null) {
                    $found[$name] = $value;
                }
                continue;
            }
            // $table_prefix = <expr>;
            if ($prefix === null && is_array($t) && $t[0] === T_VARIABLE && $t[1] === '$table_prefix'
                && self::isChar($tokens[$i + 1] ?? null, '=')) {
                $j = $i + 2;
                $value = self::evalExpr($tokens, $j, [';']);
                if ($value !== null) {
                    $prefix = $value;
                }
            }
        }
        foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $required) {
            if (!isset($found[$required])) {
                throw new AgentException(
                    'capability',
                    'could not read ' . $required . ' from wp-config.php (not a literal string)'
                );
            }
        }
        return [
            'DB_NAME' => $found['DB_NAME'],
            'DB_USER' => $found['DB_USER'],
            'DB_PASSWORD' => $found['DB_PASSWORD'],
            'DB_HOST' => $found['DB_HOST'],
            'DB_CHARSET' => $found['DB_CHARSET'] ?? 'utf8mb4',
            'DB_COLLATE' => $found['DB_COLLATE'] ?? '',
            'table_prefix' => $prefix ?? 'wp_',
        ];
    }

    /**
     * Evaluates `literal ( . literal )*` (optionally parenthesised) and stops at one of $terminators.
     * Returns null for anything else (function calls, constants, variables, interpolation...).
     *
     * @param array<int, array{0:int,1:string,2?:int}|string> $tokens
     * @param string[] $terminators
     */
    private static function evalExpr(array $tokens, int &$j, array $terminators): ?string
    {
        $out = '';
        $expectOperand = true;
        $depth = 0;
        $n = count($tokens);
        for (; $j < $n; $j++) {
            $t = $tokens[$j];
            if ($expectOperand) {
                if (self::isChar($t, '(')) {
                    $depth++;
                    continue;
                }
                if (is_array($t) && $t[0] === T_CONSTANT_ENCAPSED_STRING) {
                    $s = self::decodeString($t[1]);
                    if ($s === null) {
                        return null;
                    }
                    $out .= $s;
                } elseif (is_array($t) && ($t[0] === T_LNUMBER || $t[0] === T_DNUMBER)) {
                    $out .= str_replace('_', '', $t[1]);
                } elseif (is_array($t) && $t[0] === T_START_HEREDOC) {
                    $s = self::readNowdoc($tokens, $j);
                    if ($s === null) {
                        return null;
                    }
                    $out .= $s;
                } else {
                    return null;
                }
                $expectOperand = false;
                continue;
            }
            if (self::isChar($t, '.')) {
                $expectOperand = true;
                continue;
            }
            if ($depth > 0 && self::isChar($t, ')')) {
                $depth--;
                continue;
            }
            if ($depth === 0) {
                foreach ($terminators as $term) {
                    if (self::isChar($t, $term)) {
                        return $out;
                    }
                }
            }
            return null;
        }
        return null;
    }

    /**
     * Nowdoc only (`<<<'EOT'`); heredoc may interpolate and is refused.
     *
     * @param array<int, array{0:int,1:string,2?:int}|string> $tokens
     */
    private static function readNowdoc(array $tokens, int &$j): ?string
    {
        $start = $tokens[$j];
        if (!is_array($start) || strpos($start[1], "'") === false) {
            return null;
        }
        $body = '';
        $n = count($tokens);
        for ($k = $j + 1; $k < $n; $k++) {
            $t = $tokens[$k];
            if (is_array($t) && $t[0] === T_END_HEREDOC) {
                $j = $k;
                // The final newline before the closing marker is not part of the string.
                $body = preg_replace('/\r?\n$/', '', $body);
                // PHP 7.3+ flexible nowdoc: strip the closing marker's indentation from each line.
                $indent = '';
                if (preg_match('/^([ \t]*)/', $t[1], $m) === 1) {
                    $indent = $m[1];
                }
                if ($indent !== '') {
                    $body = preg_replace('/^' . preg_quote($indent, '/') . '/m', '', (string) $body);
                }
                return (string) $body;
            }
            if (is_array($t) && $t[0] === T_ENCAPSED_AND_WHITESPACE) {
                $body .= $t[1];
                continue;
            }
            return null;
        }
        return null;
    }

    /**
     * Decodes a T_CONSTANT_ENCAPSED_STRING literal without evaluating it.
     */
    public static function decodeString(string $lit): ?string
    {
        if ($lit !== '' && ($lit[0] === 'b' || $lit[0] === 'B')) {
            $lit = substr($lit, 1);
        }
        $len = strlen($lit);
        if ($len < 2) {
            return null;
        }
        $q = $lit[0];
        if ($lit[$len - 1] !== $q) {
            return null;
        }
        $body = substr($lit, 1, -1);
        if ($q === "'") {
            return preg_replace_callback('/\\\\([\\\\\'])/', static function (array $m): string {
                return $m[1];
            }, $body);
        }
        if ($q !== '"') {
            return null;
        }
        return self::decodeDoubleQuoted($body);
    }

    private static function decodeDoubleQuoted(string $s): string
    {
        $out = '';
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            $c = $s[$i];
            if ($c !== '\\' || $i + 1 >= $n) {
                $out .= $c;
                continue;
            }
            $d = $s[$i + 1];
            $simple = ['n' => "\n", 't' => "\t", 'r' => "\r", 'v' => "\v", 'e' => "\x1b", 'f' => "\f",
                '\\' => '\\', '$' => '$', '"' => '"'];
            if (isset($simple[$d])) {
                $out .= $simple[$d];
                $i++;
                continue;
            }
            if ($d === 'x' && preg_match('/^[0-9A-Fa-f]{1,2}/', substr($s, $i + 2, 2), $m) === 1) {
                $out .= chr((int) hexdec($m[0]));
                $i += 1 + strlen($m[0]);
                continue;
            }
            if ($d === 'u' && preg_match('/^\{([0-9A-Fa-f]+)\}/', substr($s, $i + 2), $m) === 1) {
                $out .= self::utf8((int) hexdec($m[1]));
                $i += 1 + strlen($m[0]);
                continue;
            }
            if (preg_match('/^[0-7]{1,3}/', substr($s, $i + 1, 3), $m) === 1) {
                $out .= chr(((int) octdec($m[0])) & 0xff);
                $i += strlen($m[0]);
                continue;
            }
            $out .= '\\';
        }
        return $out;
    }

    private static function utf8(int $cp): string
    {
        if ($cp < 0x80) {
            return chr($cp);
        }
        if ($cp < 0x800) {
            return chr(0xC0 | ($cp >> 6)) . chr(0x80 | ($cp & 0x3F));
        }
        if ($cp < 0x10000) {
            return chr(0xE0 | ($cp >> 12)) . chr(0x80 | (($cp >> 6) & 0x3F)) . chr(0x80 | ($cp & 0x3F));
        }
        return chr(0xF0 | ($cp >> 18)) . chr(0x80 | (($cp >> 12) & 0x3F)) . chr(0x80 | (($cp >> 6) & 0x3F))
            . chr(0x80 | ($cp & 0x3F));
    }

    /**
     * @return array<int, array{0:int,1:string,2?:int}|string>
     */
    private static function significantTokens(string $src): array
    {
        $out = [];
        foreach (token_get_all($src) as $t) {
            if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG], true)) {
                continue;
            }
            // PHP 8 tokenises `\define` as T_NAME_FULLY_QUALIFIED.
            if (is_array($t) && defined('T_NAME_FULLY_QUALIFIED') && $t[0] === T_NAME_FULLY_QUALIFIED
                && strtolower($t[1]) === '\\define') {
                $t = [T_STRING, 'define', $t[2] ?? 0];
            }
            $out[] = $t;
        }
        return $out;
    }

    /**
     * @param array{0:int,1:string,2?:int}|string|null $t
     */
    private static function isChar($t, string $c): bool
    {
        return is_string($t) && $t === $c;
    }

    /**
     * @param array{0:int,1:string,2?:int}|string|null $t
     */
    private static function isObjectOperator($t): bool
    {
        return is_array($t) && ($t[0] === T_OBJECT_OPERATOR || $t[0] === T_DOUBLE_COLON || $t[0] === T_FUNCTION
            || (defined('T_NULLSAFE_OBJECT_OPERATOR') && $t[0] === T_NULLSAFE_OBJECT_OPERATOR));
    }

    /**
     * Splits DB_HOST into PDO/mysqli connection parts. Supports `host`, `host:port`, `host:/socket`,
     * `/socket`, `[ipv6]:port` and mysqli's `p:` persistent prefix.
     *
     * @return array{host: string, port: int|null, socket: string|null}
     */
    public static function parseHost(string $dbHost): array
    {
        $h = trim($dbHost);
        if (strncmp($h, 'p:', 2) === 0) {
            $h = substr($h, 2);
        }
        if ($h !== '' && $h[0] === '/') {
            return ['host' => 'localhost', 'port' => null, 'socket' => $h];
        }
        if ($h !== '' && $h[0] === '[') {
            $end = strpos($h, ']');
            if ($end !== false) {
                $host = substr($h, 1, $end - 1);
                $rest = substr($h, $end + 1);
                $port = (strlen($rest) > 1 && $rest[0] === ':' && ctype_digit(substr($rest, 1)))
                    ? (int) substr($rest, 1) : null;
                return ['host' => $host, 'port' => $port, 'socket' => null];
            }
        }
        if (substr_count($h, ':') === 1) {
            [$host, $rest] = explode(':', $h, 2);
            if ($rest !== '' && $rest[0] === '/') {
                return ['host' => $host === '' ? 'localhost' : $host, 'port' => null, 'socket' => $rest];
            }
            if (ctype_digit($rest)) {
                return ['host' => $host === '' ? 'localhost' : $host, 'port' => (int) $rest, 'socket' => null];
            }
        }
        return ['host' => $h === '' ? 'localhost' : $h, 'port' => null, 'socket' => null];
    }
}
