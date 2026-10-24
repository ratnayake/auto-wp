<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

use AutoWp\Agent\Archive\ByteSink;

/**
 * Pure-PHP mysqldump replacement. Tables are read in primary-key order in chunks (keyset pagination),
 * written as extended INSERTs with explicit column lists (generated columns are left out), binary
 * columns as hex. The position is a JSON-serialisable state so a dump can continue in a later request.
 *
 * Consistency: every connection starts `START TRANSACTION WITH CONSISTENT SNAPSHOT`, so a dump that runs
 * on one connection (CLI) is a consistent snapshot. A dump spread over several web requests is
 * consistent per slice only.
 */
final class NativeDumper
{
    public const CHUNK_ROWS = 1000;
    public const MAX_STATEMENT_BYTES = 1048576;

    /** @var Connection */
    private $db;
    /** @var ByteSink */
    private $out;

    public function __construct(Connection $db, ByteSink $out)
    {
        $this->db = $db;
        $this->out = $out;
    }

    public static function beginSnapshot(Connection $db): void
    {
        $db->exec("SET SESSION time_zone = '+00:00'");
        $db->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        $db->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    }

    /**
     * @param string[] $excludeTables
     * @return array<string, mixed>
     */
    public static function initialState(Connection $db, array $excludeTables): array
    {
        $tables = [];
        foreach ($db->fetchAll("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'") as $row) {
            $name = (string) reset($row);
            if (!in_array($name, $excludeTables, true)) {
                $tables[] = ['name' => $name, 'rows' => 0];
            }
        }
        usort($tables, static function (array $a, array $b): int {
            return strcmp($a['name'], $b['name']);
        });
        return ['phase' => 'header', 'tables' => $tables, 'ti' => 0, 'schemaDone' => false, 'cursor' => null];
    }

    /**
     * Advances the dump; returns true when finished.
     *
     * @param array<string, mixed> $s
     */
    public function step(array &$s, float $deadline): bool
    {
        while (true) {
            switch ($s['phase']) {
                case 'header':
                    $this->out->write($this->header());
                    $s['phase'] = 'tables';
                    break;
                case 'tables':
                    if ($s['ti'] >= count($s['tables'])) {
                        $s['phase'] = 'objects';
                        break;
                    }
                    if ($this->dumpTable($s, $deadline)) {
                        $s['ti']++;
                        $s['schemaDone'] = false;
                        $s['cursor'] = null;
                    }
                    break;
                case 'objects':
                    $this->dumpViews();
                    $this->dumpTriggers(array_column($s['tables'], 'name'));
                    $this->dumpRoutines();
                    $s['phase'] = 'footer';
                    break;
                case 'footer':
                    $this->out->write($this->footer());
                    $s['phase'] = 'done';
                    return true;
                case 'done':
                    return true;
            }
            if (microtime(true) >= $deadline) {
                return $s['phase'] === 'done';
            }
        }
    }

    private function header(): string
    {
        return "-- auto-wp native SQL dump\n"
            . '-- Server version: ' . preg_replace('/[^\w.\-+ ]/', '', $this->db->version()) . "\n\n"
            . "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n"
            . "/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;\n"
            . "/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;\n"
            . "/*!40101 SET NAMES utf8mb4 */;\n"
            . "/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n"
            . "/*!40103 SET TIME_ZONE='+00:00' */;\n"
            . "/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n"
            . "/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n"
            . "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n"
            . "/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;\n\n";
    }

    private function footer(): string
    {
        return "/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n"
            . "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n"
            . "/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n"
            . "/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n"
            . "/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n"
            . "/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;\n"
            . "/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;\n"
            . "/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;\n\n"
            . '-- Dump completed ' . gmdate('Y-m-d\TH:i:s\Z') . "\n";
    }

    /**
     * Dumps (part of) the current table. Returns true when the table is complete.
     *
     * @param array<string, mixed> $s
     */
    private function dumpTable(array &$s, float $deadline): bool
    {
        $table = $s['tables'][$s['ti']]['name'];
        $q = SqlValue::ident($table);
        if (!$s['schemaDone']) {
            $create = $this->db->fetchAll('SHOW CREATE TABLE ' . $q);
            $ddl = (string) ($create[0]['Create Table'] ?? '');
            if ($ddl === '') {
                throw new \RuntimeException('cannot read the definition of a table');
            }
            $this->out->write("--\n-- Table " . $q . "\n--\n\nDROP TABLE IF EXISTS " . $q . ";\n"
                . "/*!40101 SET @saved_cs_client = @@character_set_client */;\n"
                . "/*!40101 SET character_set_client = utf8mb4 */;\n"
                . $ddl . ";\n/*!40101 SET character_set_client = @saved_cs_client */;\n\n");
            $s['schemaDone'] = true;
        }
        $cols = $this->columns($table);
        if ($cols['names'] === []) {
            return true;
        }
        $exprs = [];
        foreach ($cols['names'] as $n) {
            $exprs[] = SqlValue::selectExpr($n, $cols['kinds'][$n]);
        }
        $select = 'SELECT ' . implode(',', $exprs) . ' FROM ' . $q;
        $prefix = 'INSERT INTO ' . $q . ' (' . implode(',', array_map([SqlValue::class, 'ident'], $cols['names'])) . ') VALUES ';
        $pk = $this->primaryKey($table);
        $pkUsable = $pk !== [] && array_diff($pk, $cols['names']) === [];

        if (!$pkUsable) {
            // No usable key for keyset pagination: stream the whole table in one go.
            $rows = $this->emitRows($select, $prefix, $cols['kinds'], null);
            $s['tables'][$s['ti']]['rows'] += $rows['count'];
            return true;
        }
        $order = ' ORDER BY ' . implode(',', array_map([SqlValue::class, 'ident'], $pk));
        while (true) {
            $where = '';
            if ($s['cursor'] !== null) {
                $where = ' WHERE ' . $this->keysetCondition($pk, $s['cursor'], $cols['kinds']);
            }
            $rows = $this->emitRows($select . $where . $order . ' LIMIT ' . self::CHUNK_ROWS, $prefix, $cols['kinds'], $pk);
            $s['tables'][$s['ti']]['rows'] += $rows['count'];
            if ($rows['count'] < self::CHUNK_ROWS) {
                return true;
            }
            $s['cursor'] = $rows['last'];
            if (microtime(true) >= $deadline) {
                return false;
            }
        }
    }

    /**
     * @param array<string, string> $kinds column => kind
     * @param string[]|null $pk
     * @return array{count: int, last: array<int, string|null>|null}
     */
    private function emitRows(string $sql, string $prefix, array $kinds, ?array $pk): array
    {
        $buf = '';
        $last = null;
        $out = $this->out;
        $count = $this->db->each($sql, static function (array $row) use (&$buf, &$last, $prefix, $kinds, $pk, $out): void {
            $vals = [];
            foreach ($row as $col => $v) {
                $vals[] = SqlValue::format($v, $kinds[$col] ?? SqlValue::KIND_STRING);
            }
            $tuple = '(' . implode(',', $vals) . ')';
            if ($buf === '') {
                $buf = $prefix . $tuple;
            } else {
                $buf .= ',' . $tuple;
            }
            if (strlen($buf) >= self::MAX_STATEMENT_BYTES) {
                $out->write($buf . ";\n");
                $buf = '';
            }
            if ($pk !== null) {
                $last = [];
                foreach ($pk as $k) {
                    $last[] = $row[$k];
                }
            }
        });
        if ($buf !== '') {
            $out->write($buf . ";\n");
        }
        return ['count' => $count, 'last' => $last];
    }

    /**
     * `(a,b) > (x,y)` written out as `a > x OR (a = x AND b > y)` so it works on every server version.
     *
     * @param string[] $pk
     * @param array<int, string|null> $cursor
     * @param array<string, string> $kinds
     */
    public static function keysetCondition(array $pk, array $cursor, array $kinds): string
    {
        $ors = [];
        $n = count($pk);
        for ($i = 0; $i < $n; $i++) {
            $ands = [];
            for ($j = 0; $j < $i; $j++) {
                $ands[] = SqlValue::ident($pk[$j]) . ' = ' . SqlValue::format($cursor[$j], $kinds[$pk[$j]] ?? SqlValue::KIND_STRING);
            }
            $ands[] = SqlValue::ident($pk[$i]) . ' > ' . SqlValue::format($cursor[$i], $kinds[$pk[$i]] ?? SqlValue::KIND_STRING);
            $ors[] = '(' . implode(' AND ', $ands) . ')';
        }
        return '(' . implode(' OR ', $ors) . ')';
    }

    /**
     * @return array{names: string[], kinds: array<string, string>}
     */
    private function columns(string $table): array
    {
        $names = [];
        $kinds = [];
        foreach ($this->db->fetchAll('SHOW COLUMNS FROM ' . SqlValue::ident($table)) as $c) {
            $extra = strtolower((string) ($c['Extra'] ?? ''));
            if (strpos($extra, 'generated') !== false || strpos($extra, 'persistent') !== false
                || strpos($extra, 'virtual') !== false) {
                continue;
            }
            $name = (string) $c['Field'];
            $names[] = $name;
            $kinds[$name] = SqlValue::kindOf((string) $c['Type']);
        }
        return ['names' => $names, 'kinds' => $kinds];
    }

    /** @return string[] */
    private function primaryKey(string $table): array
    {
        $cols = [];
        foreach ($this->db->fetchAll('SHOW KEYS FROM ' . SqlValue::ident($table) . " WHERE Key_name = 'PRIMARY'") as $k) {
            $cols[(int) $k['Seq_in_index']] = (string) $k['Column_name'];
        }
        ksort($cols);
        return array_values($cols);
    }

    private function dumpViews(): void
    {
        foreach ($this->db->fetchAll("SHOW FULL TABLES WHERE Table_type = 'VIEW'") as $row) {
            $name = (string) reset($row);
            $q = SqlValue::ident($name);
            try {
                $create = $this->db->fetchAll('SHOW CREATE VIEW ' . $q);
            } catch (\Throwable $e) {
                continue;
            }
            $ddl = self::stripDefiner((string) ($create[0]['Create View'] ?? ''));
            if ($ddl !== '') {
                $this->out->write('DROP TABLE IF EXISTS ' . $q . ";\nDROP VIEW IF EXISTS " . $q . ";\n" . $ddl . ";\n\n");
            }
        }
    }

    /** @param string[] $tables */
    private function dumpTriggers(array $tables): void
    {
        foreach ($this->db->fetchAll('SHOW TRIGGERS') as $t) {
            if (!in_array((string) ($t['Table'] ?? ''), $tables, true)) {
                continue;
            }
            $q = SqlValue::ident((string) $t['Trigger']);
            try {
                $create = $this->db->fetchAll('SHOW CREATE TRIGGER ' . $q);
            } catch (\Throwable $e) {
                continue;
            }
            $ddl = self::stripDefiner((string) ($create[0]['SQL Original Statement'] ?? ''));
            if ($ddl !== '') {
                $this->out->write('DROP TRIGGER IF EXISTS ' . $q . ";\nDELIMITER ;;\n" . $ddl . ";;\nDELIMITER ;\n\n");
            }
        }
    }

    private function dumpRoutines(): void
    {
        foreach (['PROCEDURE' => 'Create Procedure', 'FUNCTION' => 'Create Function'] as $kind => $col) {
            try {
                $list = $this->db->fetchAll('SHOW ' . $kind . ' STATUS WHERE Db = DATABASE()');
            } catch (\Throwable $e) {
                continue;
            }
            foreach ($list as $r) {
                $q = SqlValue::ident((string) $r['Name']);
                try {
                    $create = $this->db->fetchAll('SHOW CREATE ' . $kind . ' ' . $q);
                } catch (\Throwable $e) {
                    continue;
                }
                $ddl = self::stripDefiner((string) ($create[0][$col] ?? ''));
                if ($ddl !== '') {
                    $this->out->write('DROP ' . $kind . ' IF EXISTS ' . $q . ";\nDELIMITER ;;\n" . $ddl . ";;\nDELIMITER ;\n\n");
                }
            }
        }
    }

    /** Removes `DEFINER=user@host` so the import works for the site's (non-SUPER) DB user. */
    public static function stripDefiner(string $ddl): string
    {
        return (string) preg_replace('/\sDEFINER\s*=\s*(?:`[^`]*`|\'[^\']*\'|[^\s@]+)@(?:`[^`]*`|\'[^\']*\'|[^\s]+)/i', '', $ddl, 1);
    }
}
