<?php

declare(strict_types=1);

namespace AutoWp\Agent\Wp;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\Json;

/**
 * Runs a bridge action in WordPress isolated from the agent: in CLI mode as a separate PHP process
 * (`php agent.php --wp-bridge <action>`), in web mode as a shutdown-guarded in-process include.
 */
final class Bridge
{
    /**
     * @param array<string, mixed> $params
     * @param string[] $flushed
     * @return array<string, mixed>|BridgeRequest a response envelope (CLI) or an in-process request (web)
     */
    public static function run(Context $ctx, string $action, array $params, array $flushed = [])
    {
        if (!$ctx->isCli() || !$ctx->binaries->execEnabled() || PHP_BINARY === '') {
            return new BridgeRequest($action, $params, $ctx->config->wpRoot, !$ctx->isCli(), $ctx->config->siteHost, $flushed);
        }
        return self::runChild($ctx, $action, $params, $flushed);
    }

    /**
     * @param array<string, mixed> $params
     * @param string[] $flushed
     * @return array<string, mixed>
     */
    private static function runChild(Context $ctx, string $action, array $params, array $flushed): array
    {
        $argv = [PHP_BINARY, $ctx->agentFile, '--wp-bridge', $action];
        if ($ctx->config->path !== null) {
            $argv[] = '--config';
            $argv[] = $ctx->config->path;
        }
        $argv[] = '--wp-root';
        $argv[] = $ctx->config->wpRoot;
        $tmp = $ctx->data->ensure('tmp');
        $errFile = $tmp . '/bridge-' . bin2hex(random_bytes(8)) . '.err';
        $pipes = [];
        $proc = proc_open($argv, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $errFile, 'w']], $pipes, $ctx->config->wpRoot);
        if (!is_resource($proc)) {
            throw new AgentException('capability', 'cannot start the WordPress bridge process');
        }
        try {
            fwrite($pipes[0], Json::encode(['params' => (object) $params, 'flushed' => $flushed]));
            fclose($pipes[0]);
            $out = (string) stream_get_contents($pipes[1]);
            fclose($pipes[1]);
            $code = proc_close($proc);
            $env = BridgeRequest::parseChildOutput($out);
            if ($env === null) {
                $err = trim(substr((string) @file_get_contents($errFile), 0, 400));
                if ($err === '') {
                    $err = trim(substr((string) preg_replace('/\s+/', ' ', strip_tags($out)), 0, 400));
                }
                return ['ok' => false, 'error' => ['code' => 'wp_fatal', 'message' => 'WordPress bridge died (exit ' . $code . ')' . ($err !== '' ? ': ' . $err : '')]];
            }
            return $env;
        } finally {
            @unlink($errFile);
        }
    }
}
