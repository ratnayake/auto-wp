<?php

declare(strict_types=1);

namespace AutoWp\Agent\Fs;

use AutoWp\Agent\AgentException;

/**
 * The only way the agent runs external programs: proc_open() with an argv array (no shell) and a binary
 * from a fixed allowlist, located in fixed system directories.
 */
final class Binaries
{
    public const ALLOWLIST = ['tar', 'gzip', 'mysqldump', 'mysql', 'find', 'sha256sum'];
    private const ALIASES = ['mysqldump' => ['mariadb-dump', 'mysqldump'], 'mysql' => ['mariadb', 'mysql']];
    private const DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/usr/local/mysql/bin', '/opt/homebrew/bin'];

    /** @var array<string, string|null> */
    private $cache = [];
    /** @var bool|null */
    private $execEnabled;

    public function execEnabled(): bool
    {
        if ($this->execEnabled === null) {
            $disabled = array_map('trim', explode(',', strtolower((string) ini_get('disable_functions'))));
            $this->execEnabled = function_exists('proc_open') && !in_array('proc_open', $disabled, true)
                && function_exists('proc_close') && !in_array('proc_close', $disabled, true);
        }
        return $this->execEnabled;
    }

    public function find(string $name): ?string
    {
        if (!in_array($name, self::ALLOWLIST, true)) {
            throw AgentException::internal('binary not in allowlist');
        }
        if (!$this->execEnabled()) {
            return null;
        }
        if (array_key_exists($name, $this->cache)) {
            return $this->cache[$name];
        }
        $found = null;
        $openBasedir = (string) ini_get('open_basedir');
        if ($openBasedir === '') {
            foreach (self::ALIASES[$name] ?? [$name] as $candidate) {
                foreach (self::DIRS as $dir) {
                    $p = $dir . '/' . $candidate;
                    if (@is_file($p) && @is_executable($p)) {
                        $found = $p;
                        break 2;
                    }
                }
            }
        }
        $this->cache[$name] = $found;
        return $found;
    }

    /** First line of `<binary> --version` ('' if it cannot be run). */
    public function version(string $name): string
    {
        $pipes = [];
        try {
            $proc = $this->open([$name, '--version'], [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        } catch (AgentException $e) {
            return '';
        }
        $out = (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        proc_close($proc);
        return trim((string) strtok($out, "\n"));
    }

    /** @return array<string, string> */
    public function all(): array
    {
        $out = [];
        foreach (self::ALLOWLIST as $b) {
            $p = $this->find($b);
            if ($p !== null) {
                $out[$b] = $p;
            }
        }
        return $out;
    }

    /**
     * Starts an allowlisted binary. $argv[0] must be the allowlist name; it is replaced by the full path.
     *
     * @param string[] $argv
     * @param array<int, mixed> $descriptors
     * @param array<int, resource> $pipes
     * @return resource
     */
    public function open(array $argv, array $descriptors, &$pipes, ?string $cwd = null)
    {
        $name = (string) ($argv[0] ?? '');
        $path = $this->find($name);
        if ($path === null) {
            throw new AgentException('capability', $name . ' is not available');
        }
        $argv[0] = $path;
        foreach ($argv as $a) {
            if (!is_string($a) || strpos($a, "\0") !== false) {
                throw AgentException::internal('invalid argv');
            }
        }
        $env = ['PATH' => '/usr/bin:/bin:/usr/local/bin', 'LC_ALL' => 'C'];
        $proc = proc_open($argv, $descriptors, $pipes, $cwd, $env);
        if (!is_resource($proc)) {
            throw new AgentException('capability', 'could not start ' . $name);
        }
        return $proc;
    }
}
