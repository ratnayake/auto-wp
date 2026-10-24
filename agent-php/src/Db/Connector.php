<?php

declare(strict_types=1);

namespace AutoWp\Agent\Db;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\WpConfigReader;

final class Connector
{
    /** @return array{DB_NAME: string, DB_USER: string, DB_PASSWORD: string, DB_HOST: string, DB_CHARSET: string, DB_COLLATE: string, table_prefix: string} */
    public static function wpConfig(string $wpRoot): array
    {
        $file = WpConfigReader::locate($wpRoot);
        if ($file === null) {
            throw new AgentException('capability', 'wp-config.php not found');
        }
        return WpConfigReader::readFile($file);
    }

    public static function fromWpRoot(string $wpRoot): Connection
    {
        $cfg = self::wpConfig($wpRoot);
        return self::connect($cfg);
    }

    /**
     * @param array{DB_NAME: string, DB_USER: string, DB_PASSWORD: string, DB_HOST: string} $cfg
     */
    public static function connect(array $cfg): Connection
    {
        $host = WpConfigReader::parseHost($cfg['DB_HOST']);
        if (extension_loaded('pdo_mysql')) {
            return new PdoConnection($host, $cfg['DB_NAME'], $cfg['DB_USER'], $cfg['DB_PASSWORD']);
        }
        if (extension_loaded('mysqli')) {
            return new MysqliConnection($host, $cfg['DB_NAME'], $cfg['DB_USER'], $cfg['DB_PASSWORD']);
        }
        throw new AgentException('capability', 'neither pdo_mysql nor mysqli is available');
    }

    /** Removes the password from a driver error message, just in case. */
    public static function scrub(string $message, string $password): string
    {
        if ($password !== '') {
            $message = str_replace($password, '***', $message);
        }
        return $message;
    }
}
