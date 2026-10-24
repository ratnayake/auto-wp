<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

/** A MySQL/MariaDB connection (PDO or mysqli). Values are always returned as strings or null. */
interface Connection
{
    /**
     * Buffered query.
     *
     * @return array<int, array<string, string|null>>
     */
    public function fetchAll(string $sql): array;

    /**
     * Unbuffered streaming query; no other query may run until it finishes.
     *
     * @param callable(array<string, string|null>): void $onRow
     * @return int rows seen
     */
    public function each(string $sql, callable $onRow): int;

    public function exec(string $sql): void;

    /** `SELECT VERSION()` */
    public function version(): string;

    /** 'pdo' or 'mysqli' */
    public function driver(): string;
}
