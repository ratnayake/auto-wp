<?php

declare(strict_types=1);

namespace AutoWp\Agent;

use AutoWp\Agent\Wp\BridgeRequest;

/**
 * CLI mode (over SSH): `php agent.php --cli <action> [--config <path>] [--wp-root <path>]`, params JSON on
 * stdin, response JSON on stdout. No signature: SSH authenticates. Refuses to run under a web SAPI.
 * `--wp-bridge <action>` is the internal WordPress bridge child process.
 */
final class Cli
{
    /**
     * @param string[] $argv
     */
    public static function main(array $argv, string $agentFile): ?BridgeRequest
    {
        if (PHP_SAPI !== 'cli' && PHP_SAPI !== 'phpdbg') {
            return null;
        }
        $opts = self::parseArgs($argv);
        if ($opts === null) {
            fwrite(STDERR, "usage: php agent.php --cli <action> [--config <path>] [--wp-root <path>] < params.json\n");
            exit(2);
        }
        try {
            $config = self::loadConfig($opts['config'], $opts['wpRoot']);
            $ctx = new Context($config, Context::MODE_CLI, 'time', $agentFile);
        } catch (\Throwable $e) {
            self::emit(['ok' => false, 'error' => ['code' => 'bad_request', 'message' => 'configuration error: ' . $e->getMessage()]]);
            exit(2);
        }
        $stdin = (string) stream_get_contents(STDIN);

        if ($opts['bridge']) {
            $in = trim($stdin) === '' ? [] : json_decode($stdin, true);
            $params = is_array($in) && is_array($in['params'] ?? null) ? $in['params'] : [];
            $flushed = is_array($in) && is_array($in['flushed'] ?? null) ? array_map('strval', $in['flushed']) : [];
            if ($opts['action'] !== 'cache.flush') {
                $specs = Actions\Registry::specs();
                if (!in_array($opts['action'], Actions\Registry::BRIDGE_ACTIONS, true)) {
                    exit(2);
                }
                $params = Params::validate($params, $specs[$opts['action']]);
            }
            return new BridgeRequest($opts['action'], $params, $config->wpRoot, false, $config->siteHost, $flushed);
        }

        $agent = new Agent($ctx);
        try {
            $params = trim($stdin) === '' ? [] : Json::decodeObject($stdin, 'params');
            $out = $agent->dispatch($opts['action'], $params);
            if ($out instanceof BridgeRequest) {
                return $out; // exec disabled: load WordPress in this process
            }
            $env = ['ok' => true] + $out;
        } catch (AgentException $e) {
            $env = ['ok' => false, 'error' => ['code' => $e->getErrorCode(), 'message' => $e->getMessage()]];
        } catch (\Throwable $e) {
            $env = ['ok' => false, 'error' => ['code' => 'internal', 'message' => Agent::safeMessage($e)]];
        }
        $ctx->audit->record('cli', [
            'action' => substr($opts['action'], 0, 64),
            'outcome' => $env['ok'] ? 'ok' : $env['error']['code'],
        ]);
        self::emit($env);
        return null;
    }

    /** @param array<string, mixed> $env */
    private static function emit(array $env): void
    {
        fwrite(STDOUT, Json::encode($env) . "\n");
    }

    /**
     * @param string[] $argv
     * @return array{action: string, bridge: bool, config: string|null, wpRoot: string|null}|null
     */
    public static function parseArgs(array $argv): ?array
    {
        $action = null;
        $bridge = false;
        $config = null;
        $wpRoot = null;
        $n = count($argv);
        for ($i = 1; $i < $n; $i++) {
            $a = $argv[$i];
            if (($a === '--cli' || $a === '--wp-bridge') && $i + 1 < $n) {
                $bridge = $a === '--wp-bridge';
                $action = $argv[++$i];
            } elseif ($a === '--config' && $i + 1 < $n) {
                $config = $argv[++$i];
            } elseif ($a === '--wp-root' && $i + 1 < $n) {
                $wpRoot = $argv[++$i];
            } else {
                return null;
            }
        }
        if ($action === null || preg_match('/^[a-z]+(\.[A-Za-z0-9]+)?$/D', $action) !== 1) {
            return null;
        }
        return ['action' => $action, 'bridge' => $bridge, 'config' => $config, 'wpRoot' => $wpRoot];
    }

    public static function homeDir(): string
    {
        $home = getenv('HOME');
        if (is_string($home) && $home !== '') {
            return rtrim($home, '/');
        }
        if (function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
            $pw = posix_getpwuid(posix_geteuid());
            if (is_array($pw) && !empty($pw['dir'])) {
                return rtrim((string) $pw['dir'], '/');
            }
        }
        throw new \RuntimeException('cannot determine the home directory');
    }

    private static function loadConfig(?string $path, ?string $wpRoot): Config
    {
        $defaultData = self::homeDir() . '/.auto-wp/data';
        if ($path === null) {
            $candidate = self::homeDir() . '/.auto-wp/config.php';
            if (is_file($candidate)) {
                $path = $candidate;
            }
        }
        if ($path !== null) {
            if (!is_file($path)) {
                throw new \InvalidArgumentException('config file not found');
            }
            $real = (string) realpath($path);
            $data = (static function (string $f) {
                return require $f;
            })($real);
            if (!is_array($data)) {
                throw new \InvalidArgumentException('config file must return an array');
            }
            if ($wpRoot !== null) {
                $data['wpRoot'] = $wpRoot;
            }
            $data['dataDir'] = $data['dataDir'] ?? $defaultData;
            return Config::fromArray($data, $real);
        }
        if ($wpRoot === null) {
            throw new \InvalidArgumentException('no config: pass --config or --wp-root');
        }
        return Config::fromArray(['siteId' => 'cli', 'wpRoot' => $wpRoot, 'dataDir' => $defaultData]);
    }
}
