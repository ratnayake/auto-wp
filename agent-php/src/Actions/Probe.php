<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\Context;
use AutoWp\Agent\Security\Ed25519;

/** probe: Capabilities (contracts connection.ts). */
final class Probe
{
    /** @return array<string, mixed> */
    public static function run(array $p, Context $ctx): array
    {
        $cfg = $ctx->config;
        $out = [
            'shell' => false,
            'execEnabled' => $ctx->binaries->execEnabled(),
            'phpVersion' => PHP_VERSION,
            'wpCli' => ['available' => false],
            'binaries' => (object) $ctx->binaries->all(),
            'sodium' => Ed25519::hasExtension(),
            'docroot' => $cfg->docroot,
            'wpRoot' => $cfg->wpRoot,
        ];
        if ($ctx->isCli() && PHP_BINARY !== '') {
            $out['phpCli'] = PHP_BINARY;
            $phar = dirname($ctx->agentFile) . '/wp-cli.phar';
            if (is_file($phar)) {
                $out['wpCli'] = ['available' => true, 'path' => $phar];
            }
        }
        if ($cfg->outsideDocrootDir !== null) {
            $out['outsideDocrootDir'] = $cfg->outsideDocrootDir;
        }
        $free = @disk_free_space($cfg->wpRoot);
        if ($free !== false) {
            $out['diskFreeBytes'] = (int) $free;
        }
        $sha = @hash_file('sha256', $ctx->agentFile);
        if ($sha !== false) {
            $out['agentSha256'] = $sha;
        }
        return $out;
    }
}
