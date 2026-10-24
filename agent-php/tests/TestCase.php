<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Config;
use AutoWp\Agent\Context;

abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    /** @var string[] */
    private $tmpDirs = [];

    protected function tmpDir(): string
    {
        $base = sys_get_temp_dir() . '/autowp-test-' . bin2hex(random_bytes(6));
        mkdir($base, 0700, true);
        $real = (string) realpath($base);
        $this->tmpDirs[] = $real;
        return $real;
    }

    protected function tearDown(): void
    {
        foreach ($this->tmpDirs as $d) {
            self::rm($d);
        }
        $this->tmpDirs = [];
    }

    private static function rm(string $p): void
    {
        if (is_link($p) || is_file($p)) {
            @unlink($p);
            return;
        }
        if (!is_dir($p)) {
            return;
        }
        @chmod($p, 0700);
        foreach (scandir($p) ?: [] as $n) {
            if ($n !== '.' && $n !== '..') {
                self::rm($p . '/' . $n);
            }
        }
        @rmdir($p);
    }

    /** @return array<string, mixed> */
    protected static function vectors(): array
    {
        $path = dirname(__DIR__, 2) . '/packages/contracts/test-vectors.json';
        return json_decode((string) file_get_contents($path), true);
    }

    /**
     * A site layout: <root>/wp (WP root), <root>/data (agent data), <root>/wp/auto-wp-agent (agent dir).
     *
     * @param array<string, mixed> $extra
     * @return array{root: string, wp: string, ctx: Context}
     */
    protected function site(array $extra = [], string $mode = Context::MODE_CLI, ?callable $clock = null): array
    {
        $root = $this->tmpDir();
        mkdir($root . '/wp/auto-wp-agent', 0755, true);
        file_put_contents($root . '/wp/auto-wp-agent/agent.php', '<?php // test');
        $cfg = Config::fromArray($extra + [
            'siteId' => 'site-agent',
            'wpRoot' => $root . '/wp',
            'dataDir' => $root . '/data',
        ]);
        $ctx = new Context($cfg, $mode, $clock ?? 'time', $root . '/wp/auto-wp-agent/agent.php');
        return ['root' => $root, 'wp' => $root . '/wp', 'ctx' => $ctx];
    }
}
