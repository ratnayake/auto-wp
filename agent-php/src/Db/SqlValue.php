<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

/**
 * SQL literal formatting for the native dumper. Strings are escaped like mysqldump does (safe for
 * utf8mb4 and binary connection charsets, and with the default sql_mode, i.e. without
 * NO_BACKSLASH_ESCAPES, which the dump header resets); binary data is emitted as hex.
 */
final class SqlValue
{
    public const KIND_NUMBER = 'number';
    public const KIND_BINARY = 'binary';
    public const KIND_STRING = 'string';
    /** BIT(n): selected as `col + 0` (drivers disagree on how they return BIT) and written as a number. */
    public const KIND_BIT = 'bit';

    public static function ident(string $name): string
    {
        return '`' . str_replace('`', '``', $name) . '`';
    }

    public static function quote(string $s): string
    {
        return "'" . strtr($s, [
            '\\' => '\\\\',
            "\0" => '\\0',
            "\n" => '\\n',
            "\r" => '\\r',
            "'" => "\\'",
            '"' => '\\"',
            "\x1a" => '\\Z',
        ]) . "'";
    }

    /** Select-list expression for a column of the given kind. */
    public static function selectExpr(string $col, string $kind): string
    {
        return $kind === self::KIND_BIT ? '(' . self::ident($col) . ' + 0) AS ' . self::ident($col) : self::ident($col);
    }

    public static function hex(string $bin): string
    {
        return $bin === '' ? "''" : '0x' . bin2hex($bin);
    }

    /** Classifies a column type as reported by SHOW COLUMNS (e.g. `varbinary(255)`, `int(10) unsigned`). */
    public static function kindOf(string $type): string
    {
        $t = strtolower($type);
        if (preg_match('/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)\b/', $t) === 1) {
            return self::KIND_NUMBER;
        }
        if (preg_match('/^bit\b/', $t) === 1) {
            return self::KIND_BIT;
        }
        if (preg_match('/^(binary|varbinary|tinyblob|blob|mediumblob|longblob|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/', $t) === 1) {
            return self::KIND_BINARY;
        }
        return self::KIND_STRING;
    }

    public static function format(?string $v, string $kind): string
    {
        if ($v === null) {
            return 'NULL';
        }
        if ($kind === self::KIND_NUMBER || $kind === self::KIND_BIT) {
            if (preg_match('/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/D', $v) === 1) {
                return $v;
            }
            return self::quote($v);
        }
        if ($kind === self::KIND_BINARY) {
            return self::hex($v);
        }
        return self::quote($v);
    }
}
