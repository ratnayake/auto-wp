<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipWriter;
use AutoWp\Agent\Context;
use AutoWp\Agent\Db\Connection;
use AutoWp\Agent\Db\Connector;
use AutoWp\Agent\Db\NativeDumper;
use AutoWp\Agent\Db\SqlValue;
use AutoWp\Agent\Fs\FsUtil;
use AutoWp\Agent\Jobs\JobHandler;
use AutoWp\Agent\WpConfigReader;

/**
 * db.dump: gzipped SQL ending with `-- Dump completed <ISO8601>`. Uses mysqldump (credentials in a 0600
 * --defaults-extra-file that is deleted right after) when binaries are allowed in this mode, else the
 * native resumable dumper.
 */
final class DumpJob implements JobHandler
{
    /** @var Connection|null connection on which the snapshot transaction was started */
    private $snapshotOn;

    public function init(array $params, Context $ctx): array
    {
        $dest = $ctx->jail->resolve($params['dest']);
        if (is_dir($dest)) {
            throw AgentException::invalidParams('dest is a directory');
        }
        FsUtil::mkdirs(dirname($dest));
        $db = $ctx->db();
        $method = $ctx->mayUseBinaries() && $ctx->binaries->find('mysqldump') !== null ? 'mysqldump' : 'native';
        if ($method === 'native') {
            $this->snapshot($db);
        }
        $dump = NativeDumper::initialState($db, $params['excludeTables']);
        return ['dest' => $dest, 'gz' => 0, 'method' => $method, 'dump' => $dump, 'excludeTables' => $params['excludeTables']];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        if ($state['method'] === 'mysqldump') {
            return $this->runMysqldump($state, $ctx);
        }
        $db = $ctx->db();
        $this->snapshot($db);
        $gz = new GzipWriter($state['dest'], $state['gz']);
        try {
            $done = (new NativeDumper($db, $gz))->step($state['dump'], $deadline);
        } finally {
            $state['gz'] = $gz->close();
        }
        if (!$done) {
            return null;
        }
        $db->exec('COMMIT');
        $this->snapshotOn = null;
        return $this->result($state, 'native');
    }

    private function snapshot(Connection $db): void
    {
        if ($this->snapshotOn !== $db) {
            NativeDumper::beginSnapshot($db);
            $this->snapshotOn = $db;
        }
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, mixed>
     */
    private function result(array $state, string $method): array
    {
        $tables = [];
        foreach ($state['dump']['tables'] as $t) {
            $tables[] = ['name' => $t['name'], 'rows' => (int) $t['rows']];
        }
        clearstatcache(true, $state['dest']);
        return [
            'tables' => $tables,
            'bytes' => (int) filesize($state['dest']),
            'sha256' => FsUtil::sha256File($state['dest']),
            'method' => $method,
        ];
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, mixed>
     */
    private function runMysqldump(array &$state, Context $ctx): array
    {
        @set_time_limit(0);
        $cfg = Connector::wpConfig($ctx->config->wpRoot);
        if ($cfg['DB_NAME'] === '' || $cfg['DB_NAME'][0] === '-') {
            throw new AgentException('capability', 'unsupported database name');
        }
        // Row counts first (exact COUNT(*)); mysqldump itself runs in its own snapshot.
        $db = $ctx->db();
        foreach ($state['dump']['tables'] as $i => $t) {
            $state['dump']['tables'][$i]['rows'] = DbInfo::count($db, $t['name']);
        }
        $tmp = $ctx->data->ensure('tmp');
        $errFile = $tmp . '/dump-' . bin2hex(random_bytes(8)) . '.err';
        // Credentials go through an inherited pipe (/dev/fd/3) where the OS has one, so no file with
        // the password ever exists. Otherwise: a 0600 file, removed in finally, on shutdown, and by the
        // tmp GC (Context) should the process be killed.
        $viaPipe = is_dir('/dev/fd');
        $defaults = $viaPipe ? '/dev/fd/3' : $tmp . '/my-' . bin2hex(random_bytes(8)) . '.cnf';
        if (!$viaPipe) {
            $old = umask(0077);
            $written = file_put_contents($defaults, self::defaultsFile($cfg));
            umask($old);
            if ($written === false) {
                throw AgentException::internal('cannot write mysqldump defaults file');
            }
            @chmod($defaults, 0600);
            register_shutdown_function(static function () use ($defaults): void {
                @unlink($defaults);
            });
        }
        $gz = null;
        try {
            $argv = ['mysqldump', '--defaults-extra-file=' . $defaults, '--single-transaction', '--quick',
                '--routines', '--triggers', '--hex-blob', '--default-character-set=utf8mb4', '--no-tablespaces',
                '--skip-add-locks', '--skip-dump-date'];
            // Like WordPress' mysqli connection: no TLS. MariaDB 11.4+ clients otherwise insist on it.
            if (stripos($ctx->binaries->version('mysqldump'), 'mariadb') !== false) {
                $argv[] = '--skip-ssl';
            }
            foreach ($state['excludeTables'] as $t) {
                $argv[] = '--ignore-table=' . $cfg['DB_NAME'] . '.' . $t;
            }
            $argv[] = $cfg['DB_NAME'];
            $pipes = [];
            $desc = [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $errFile, 'w']];
            if ($viaPipe) {
                $desc[3] = ['pipe', 'r'];
            }
            $proc = $ctx->binaries->open($argv, $desc, $pipes);
            if ($viaPipe) {
                FsUtil::writeAll($pipes[3], self::defaultsFile($cfg));
                fclose($pipes[3]);
            }
            $gz = new GzipWriter($state['dest'], 0);
            while (!feof($pipes[1])) {
                $chunk = fread($pipes[1], 1048576);
                if ($chunk === false) {
                    break;
                }
                $gz->write($chunk);
            }
            fclose($pipes[1]);
            $code = proc_close($proc);
            if ($code !== 0) {
                $err = Connector::scrub(substr((string) @file_get_contents($errFile), 0, 400), $cfg['DB_PASSWORD']);
                throw AgentException::internal('mysqldump failed (exit ' . $code . '): ' . trim($err));
            }
            $gz->write("\n-- Dump completed " . gmdate('Y-m-d\TH:i:s\Z') . "\n");
            $state['gz'] = $gz->close();
            $gz = null;
        } finally {
            if ($gz !== null) {
                $gz->close();
            }
            if (!$viaPipe) {
                @unlink($defaults);
            }
            @unlink($errFile);
        }
        return $this->result($state, 'mysqldump');
    }

    /**
     * @param array{DB_USER: string, DB_PASSWORD: string, DB_HOST: string} $cfg
     */
    public static function defaultsFile(array $cfg): string
    {
        $h = WpConfigReader::parseHost($cfg['DB_HOST']);
        $lines = ['[client]', 'user=' . self::optValue($cfg['DB_USER']), 'password=' . self::optValue($cfg['DB_PASSWORD'])];
        if ($h['socket'] !== null) {
            $lines[] = 'socket=' . self::optValue($h['socket']);
        } else {
            $lines[] = 'host=' . self::optValue($h['host']);
            if ($h['port'] !== null) {
                $lines[] = 'port=' . $h['port'];
            }
        }
        return implode("\n", $lines) . "\n";
    }

    /** Double-quoted option-file value with MySQL's escape sequences. */
    public static function optValue(string $v): string
    {
        return '"' . strtr($v, ['\\' => '\\\\', '"' => '\\"', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t']) . '"';
    }

    public function progress(array $state): array
    {
        $d = $state['dump'];
        return [
            'done' => (int) $d['ti'],
            'total' => count($d['tables']),
            'message' => $state['method'] . ' ' . ($d['tables'][$d['ti']]['name'] ?? $d['phase']),
        ];
    }
}
