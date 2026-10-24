<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipReader;
use AutoWp\Agent\Archive\PlainReader;
use AutoWp\Agent\Context;
use AutoWp\Agent\Db\Connection;
use AutoWp\Agent\Db\NativeDumper;
use AutoWp\Agent\Db\SqlSplitter;
use AutoWp\Agent\Jobs\JobHandler;

/**
 * db.import: streams a (gzipped) SQL file through SqlSplitter and executes it statement by statement.
 * Resumes at the end of the last executed statement; session `SET` statements seen so far are replayed
 * on each new connection. Leading `USE` and `CREATE/DROP DATABASE` statements are skipped; cross-database
 * references inside statements are only limited by the DB user's grants. Dumps that switch sql_mode to
 * NO_BACKSLASH_ESCAPES or ANSI_QUOTES are refused.
 */
final class ImportJob implements JobHandler
{
    private const READ = 1048576;
    private const MAX_REPLAY = 64;

    /** @var Connection|null */
    private $prepared;

    public function init(array $params, Context $ctx): array
    {
        $src = $ctx->jail->resolve($params['source']);
        if (!is_file($src)) {
            throw AgentException::notFound('source not found');
        }
        $ctx->db();
        return [
            'source' => $src,
            'gzip' => PlainReader::isGzip($src),
            'pos' => null,
            'delim' => ';',
            'statements' => 0,
            'skipped' => 0,
            'replay' => [],
            'size' => (int) filesize($src),
        ];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        $db = $ctx->db();
        if ($this->prepared !== $db) {
            $db->exec('SET NAMES utf8mb4');
            // SqlSplitter lexes strings the default way; these modes would make the server lex them
            // differently (statement injection from row data), so they are cleared and then policed.
            $rows = $db->fetchAll('SELECT @@SESSION.sql_mode AS m');
            $modes = array_filter(explode(',', strtoupper((string) ($rows[0]['m'] ?? ''))), static function (string $m): bool {
                return $m !== '' && !in_array($m, ['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES', 'ANSI'], true);
            });
            $db->exec("SET SESSION sql_mode = '" . implode(',', array_map(static function (string $m): string {
                return (string) preg_replace('/[^A-Z0-9_]/', '', $m);
            }, $modes)) . "'");
            foreach ($state['replay'] as $sql) {
                try {
                    $db->exec($sql);
                } catch (AgentException $e) {
                    // Best effort: a SET that depended on an earlier user variable may not replay.
                }
            }
            self::assertLexerCompatible($db);
            $this->prepared = $db;
        }
        $reader = $state['gzip'] ? new GzipReader($state['source'], $state['pos']) : new PlainReader($state['source'], $state['pos']);
        $splitter = new SqlSplitter((int) ($state['pos']['logical'] ?? 0), $state['delim']);
        while (true) {
            $chunk = $reader->read(self::READ);
            $final = $chunk === '';
            $stmts = $final ? $splitter->finish() : $splitter->feed($chunk);
            foreach ($stmts as $st) {
                $this->execute($db, $st['sql'], $state);
                $state['pos'] = $reader->checkpointAt($st['end']);
                $state['delim'] = $st['delim'];
                if (microtime(true) >= $deadline) {
                    return null;
                }
            }
            if ($final) {
                return ['statements' => $state['statements']];
            }
        }
    }

    /** @param array<string, mixed> $state */
    private function execute(Connection $db, string $sql, array &$state): void
    {
        $head = self::head($sql);
        if (preg_match('/^(USE\b|CREATE\s+(DATABASE|SCHEMA)\b|DROP\s+(DATABASE|SCHEMA)\b)/i', $head) === 1) {
            $state['skipped']++;
            return;
        }
        if (preg_match('/^CREATE\b/i', $head) === 1) {
            $prefix = substr($sql, 0, 600);
            if (stripos($prefix, 'DEFINER') !== false) {
                // The site's DB user usually lacks SUPER/SET USER: create objects as itself.
                $sql = NativeDumper::stripDefiner($prefix) . substr($sql, 600);
            }
        }
        try {
            $db->exec($sql);
        } catch (AgentException $e) {
            throw AgentException::internal('statement ' . ($state['statements'] + 1) . ' failed: ' . substr($e->getMessage(), 0, 300));
        }
        $state['statements']++;
        if (preg_match('/^(INSERT|REPLACE)\b/i', $head) !== 1) {
            // Anything but plain data rows might have changed sql_mode (SET, PREPARE/EXECUTE, ...).
            self::assertLexerCompatible($db);
        }
        if (preg_match('/^SET\s/i', $head) === 1 && strlen($sql) < 1024) {
            $replay = array_values(array_filter($state['replay'], static function (string $s) use ($sql): bool {
                return $s !== $sql;
            }));
            $replay[] = $sql;
            $state['replay'] = array_slice($replay, -self::MAX_REPLAY);
        }
    }

    /** Refuses to go on when the session would lex quotes differently from SqlSplitter. */
    public static function assertLexerCompatible(Connection $db): void
    {
        $rows = $db->fetchAll('SELECT @@SESSION.sql_mode AS m');
        $mode = strtoupper((string) ($rows[0]['m'] ?? ''));
        foreach (['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES'] as $bad) {
            if (strpos($mode, $bad) !== false) {
                throw AgentException::invalidParams('the dump enables sql_mode ' . $bad . ', which db.import refuses (statement splitting would be unsafe)');
            }
        }
    }

    /** The statement with leading comments removed and `/*!NNNNN` wrappers unwrapped. */
    public static function head(string $sql): string
    {
        $s = ltrim($sql);
        while (true) {
            if (preg_match('#^/\*!\d*\s*#', $s, $m) === 1) {
                return ltrim(substr($s, strlen($m[0])));
            }
            if (strncmp($s, '/*', 2) === 0) {
                $end = strpos($s, '*/');
                if ($end === false) {
                    return $s;
                }
                $s = ltrim(substr($s, $end + 2));
                continue;
            }
            if (strncmp($s, '--', 2) === 0 || strncmp($s, '#', 1) === 0) {
                $nl = strpos($s, "\n");
                if ($nl === false) {
                    return '';
                }
                $s = ltrim(substr($s, $nl + 1));
                continue;
            }
            return $s;
        }
    }

    public function progress(array $state): array
    {
        $done = (int) ($state['pos']['memberOffset'] ?? ($state['pos']['logical'] ?? 0));
        return ['done' => $done, 'total' => $state['size'], 'message' => $state['statements'] . ' statements'];
    }
}
