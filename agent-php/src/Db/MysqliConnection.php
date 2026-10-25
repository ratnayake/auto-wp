<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

use AutoWp\Agent\AgentException;

/** Fallback for hosts without pdo_mysql (WordPress itself only needs mysqli). */
final class MysqliConnection implements Connection
{
    /** @var \mysqli */
    private $db;

    /**
     * @param array{host: string, port: int|null, socket: string|null} $host
     */
    public function __construct(array $host, string $db, string $user, string $password)
    {
        mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
        try {
            $m = mysqli_init();
            $m->options(MYSQLI_OPT_CONNECT_TIMEOUT, 15);
            $m->real_connect(
                $host['socket'] !== null ? 'localhost' : $host['host'],
                $user,
                $password,
                $db,
                $host['port'] ?? 3306,
                $host['socket']
            );
            $m->set_charset('utf8mb4');
            $this->db = $m;
        } catch (\mysqli_sql_exception $e) {
            throw new AgentException('capability', 'database connection failed: ' . Connector::scrub($e->getMessage(), $password));
        }
    }

    public function fetchAll(string $sql): array
    {
        try {
            $res = $this->db->query($sql);
            if (!$res instanceof \mysqli_result) {
                return [];
            }
            $rows = [];
            while (($row = $res->fetch_assoc()) !== null) {
                $rows[] = $row;
            }
            $res->free();
            return $rows;
        } catch (\mysqli_sql_exception $e) {
            throw AgentException::internal('query failed: ' . $e->getMessage());
        }
    }

    public function each(string $sql, callable $onRow): int
    {
        $n = 0;
        try {
            $res = $this->db->query($sql, MYSQLI_USE_RESULT);
            if (!$res instanceof \mysqli_result) {
                return 0;
            }
            try {
                while (($row = $res->fetch_assoc()) !== null) {
                    $n++;
                    $onRow($row);
                }
            } finally {
                $res->free();
            }
        } catch (\mysqli_sql_exception $e) {
            throw AgentException::internal('query failed: ' . $e->getMessage());
        }
        return $n;
    }

    public function exec(string $sql): void
    {
        try {
            $res = $this->db->query($sql);
            if ($res instanceof \mysqli_result) {
                $res->free();
            }
        } catch (\mysqli_sql_exception $e) {
            throw AgentException::internal('statement failed: ' . $e->getMessage());
        }
    }

    public function version(): string
    {
        $rows = $this->fetchAll('SELECT VERSION() AS v');
        return (string) ($rows[0]['v'] ?? '');
    }

    public function driver(): string
    {
        return 'mysqli';
    }
}
