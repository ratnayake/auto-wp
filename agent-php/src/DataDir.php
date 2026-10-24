<?php

declare(strict_types=1);

namespace AutoWp\Agent;

/**
 * The agent's private data directory (nonces, jobs, audit log, temp files). Files carry a PHP exit
 * header so that, if the directory is ever web-reachable, requesting them returns 404 and no content.
 */
final class DataDir
{
    public const HEADER = "<?php http_response_code(404); exit; ?>\n";

    /** @var string */
    private $dir;

    public function __construct(string $dir)
    {
        $this->dir = rtrim($dir, '/');
    }

    public function path(string $name = ''): string
    {
        return $name === '' ? $this->dir : $this->dir . '/' . $name;
    }

    public function ensure(string $sub = ''): string
    {
        $d = $this->path($sub);
        if (!is_dir($d)) {
            $old = umask(0077);
            try {
                if (!@mkdir($d, 0700, true) && !is_dir($d)) {
                    throw AgentException::internal('cannot create agent data directory');
                }
            } finally {
                umask($old);
            }
        }
        if ($sub === '') {
            $this->writeDenyFiles($d);
        }
        return $d;
    }

    /** Defence in depth for data dirs that end up inside the docroot. */
    private function writeDenyFiles(string $d): void
    {
        $files = [
            '.htaccess' => "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
                . "<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n",
            'index.php' => "<?php http_response_code(404);\n",
            'web.config' => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<configuration><system.webServer>"
                . "<security><authorization><remove users=\"*\" roles=\"\" verbs=\"\" />"
                . "<add accessType=\"Deny\" users=\"*\" /></authorization></security>"
                . "</system.webServer></configuration>\n",
        ];
        foreach ($files as $name => $content) {
            if (!file_exists($d . '/' . $name)) {
                @file_put_contents($d . '/' . $name, $content);
            }
        }
    }

    /** Reads a header-protected file, or null if missing. */
    public static function readProtected(string $file): ?string
    {
        if (!is_file($file)) {
            return null;
        }
        $raw = file_get_contents($file);
        if ($raw === false) {
            return null;
        }
        return self::stripHeader($raw);
    }

    public static function stripHeader(string $raw): string
    {
        if (strncmp($raw, self::HEADER, strlen(self::HEADER)) === 0) {
            return (string) substr($raw, strlen(self::HEADER));
        }
        return $raw;
    }

    /** Atomically writes a header-protected 0600 file. */
    public static function writeProtected(string $file, string $content): void
    {
        $tmp = $file . '.tmp-' . bin2hex(random_bytes(6));
        $old = umask(0077);
        try {
            if (file_put_contents($tmp, self::HEADER . $content) === false) {
                throw AgentException::internal('cannot write agent data file');
            }
        } finally {
            umask($old);
        }
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
            throw AgentException::internal('cannot write agent data file');
        }
    }
}
