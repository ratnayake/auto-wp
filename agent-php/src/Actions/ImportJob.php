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
 * on each new connection. `USE` and `CREATE/DROP DATABASE` are skipped so a dump can only ever touch the
 * site's own database.
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
            foreach ($state['replay'] as $sql) {
                try {
                    $db->exec($sql);
                } catch (AgentException $e) {
                    // Best effort: a SET that depended on an earlier user variable may not replay.
                }
            }
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
        if (preg_match('/^SET\s/i', $head) === 1 && strlen($sql) < 1024) {
            $replay = array_values(array_filter($state['replay'], static function (string $s) use ($sql): bool {
                return $s !== $sql;
            }));
            $replay[] = $sql;
            $state['replay'] = array_slice($replay, -self::MAX_REPLAY);
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
