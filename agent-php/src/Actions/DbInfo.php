<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\Context;
use AutoWp\Agent\Db\Connection;
use AutoWp\Agent\Db\SqlValue;

/** db.info: server, version, charset and an exact COUNT(*) per base table. */
final class DbInfo
{
    /**
     * @return array{server: string, version: string, charset: string, tables: array<int, array{name: string, rows: int}>}
     */
    public static function run(array $p, Context $ctx): array
    {
        @set_time_limit(0);
        $db = $ctx->db();
        $version = $db->version();
        $charset = $db->fetchAll('SELECT @@character_set_database AS c');
        $tables = [];
        foreach (self::baseTables($db) as $t) {
            $tables[] = ['name' => $t, 'rows' => self::count($db, $t)];
        }
        return [
            'server' => stripos($version, 'mariadb') !== false ? 'MariaDB' : 'MySQL',
            'version' => $version,
            'charset' => (string) ($charset[0]['c'] ?? ''),
            'tables' => $tables,
        ];
    }

    /** @return string[] */
    public static function baseTables(Connection $db): array
    {
        $out = [];
        foreach ($db->fetchAll("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'") as $row) {
            $out[] = (string) reset($row);
        }
        sort($out, SORT_STRING);
        return $out;
    }

    public static function count(Connection $db, string $table): int
    {
        $rows = $db->fetchAll('SELECT COUNT(*) AS n FROM ' . SqlValue::ident($table));
        return (int) ($rows[0]['n'] ?? 0);
    }
}
