<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

use AutoWp\Agent\AgentException;

final class PdoConnection implements Connection
{
    /** @var \PDO */
    private $pdo;

    /**
     * @param array{host: string, port: int|null, socket: string|null} $host
     */
    public function __construct(array $host, string $db, string $user, string $password)
    {
        $dsn = 'mysql:dbname=' . $db . ';charset=utf8mb4';
        if ($host['socket'] !== null) {
            $dsn .= ';unix_socket=' . $host['socket'];
        } else {
            $dsn .= ';host=' . $host['host'];
            if ($host['port'] !== null) {
                $dsn .= ';port=' . $host['port'];
            }
        }
        try {
            $this->pdo = new \PDO($dsn, $user, $password, [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_EMULATE_PREPARES => true,
                \PDO::ATTR_STRINGIFY_FETCHES => true,
                \PDO::MYSQL_ATTR_MULTI_STATEMENTS => false,
                \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => true,
                \PDO::ATTR_TIMEOUT => 15,
            ]);
        } catch (\PDOException $e) {
            throw new AgentException('capability', 'database connection failed: ' . Connector::scrub($e->getMessage(), $password));
        }
    }

    public function fetchAll(string $sql): array
    {
        try {
            $st = $this->pdo->query($sql);
            $rows = $st->fetchAll(\PDO::FETCH_ASSOC);
            $st->closeCursor();
            return $rows;
        } catch (\PDOException $e) {
            throw AgentException::internal('query failed: ' . $e->getMessage());
        }
    }

    public function each(string $sql, callable $onRow): int
    {
        $n = 0;
        $this->pdo->setAttribute(\PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
        try {
            $st = $this->pdo->query($sql);
            while (($row = $st->fetch(\PDO::FETCH_ASSOC)) !== false) {
                $n++;
                $onRow($row);
            }
            $st->closeCursor();
        } catch (\PDOException $e) {
            throw AgentException::internal('query failed: ' . $e->getMessage());
        } finally {
            $this->pdo->setAttribute(\PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
        }
        return $n;
    }

    public function exec(string $sql): void
    {
        try {
            $st = $this->pdo->query($sql);
            if ($st instanceof \PDOStatement) {
                // Drain any result set (e.g. SELECT inside an import) so the connection stays usable.
                do {
                    if ($st->columnCount() > 0) {
                        $st->fetchAll();
                    }
                } while ($st->nextRowset());
                $st->closeCursor();
            }
        } catch (\PDOException $e) {
            throw AgentException::internal('statement failed: ' . $e->getMessage());
        }
    }

    public function version(): string
    {
        return (string) $this->pdo->query('SELECT VERSION()')->fetchColumn();
    }

    public function driver(): string
    {
        return 'pdo';
    }
}
