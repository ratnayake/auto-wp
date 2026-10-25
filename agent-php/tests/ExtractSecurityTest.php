<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Actions\ExtractJob;
use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipWriter;
use AutoWp\Agent\Archive\TarWriter;
use AutoWp\Agent\Config;
use AutoWp\Agent\Context;

/**
 * Regression tests for the PR #15 security review PoCs (scratchpad poc/extract.php and poc/sym.php):
 * hard-link copy of the agent config, symlink to the agent config / data dir, and the `s -> t/..`,
 * `t -> .` chain that escaped the jail.
 */
final class ExtractSecurityTest extends TestCase
{
    /** @return array{0: string, 1: Context} */
    private function linkSite(bool $links): array
    {
        $root = $this->tmpDir();
        mkdir("$root/wp/auto-wp-agent", 0755, true);
        file_put_contents("$root/wp/auto-wp-agent/agent.php", '<?php');
        file_put_contents("$root/wp/auto-wp-agent/config.php", "<?php return ['secret'=>'HMACSECRET'];");
        file_put_contents("$root/outside.txt", 'OUTSIDE');
        $cfg = Config::fromArray(['siteId' => 's', 'wpRoot' => "$root/wp", 'dataDir' => "$root/data", 'extractLinks' => $links], "$root/wp/auto-wp-agent/config.php");
        return [$root, new Context($cfg, Context::MODE_WEB, 'time', "$root/wp/auto-wp-agent/agent.php")];
    }

    /** @param array<int, array{0: string, 1: string, 2: string, 3: string}> $entries */
    private static function arch(string $f, array $entries): void
    {
        $gz = new GzipWriter($f);
        $t = new TarWriter($gz);
        foreach ($entries as [$n, $ty, $d, $l]) {
            $t->header($n, $ty, strlen($d), 0644, 0, $l);
            $t->write($d);
            $t->pad(strlen($d));
        }
        $t->finish();
        $gz->close();
    }

    /** @return array<string, mixed>|null */
    private static function extract(Context $ctx, string $a, string $dest): ?array
    {
        $h = new ExtractJob();
        $s = $h->init(['archive' => $a, 'destDir' => $dest, 'overwrite' => true], $ctx);
        try {
            return $h->step($s, $ctx, INF);
        } catch (AgentException $e) {
            return null;
        }
    }

    /** @return array<string, array{0: bool}> */
    public function linkModes(): array
    {
        return ['links skipped (default)' => [false], 'links enabled (validated)' => [true]];
    }

    /** @dataProvider linkModes PoC A */
    public function testHardLinkToAgentConfigIsRefused(bool $links): void
    {
        [$root, $ctx] = $this->linkSite($links);
        self::arch("$root/wp/a.tar.gz", [['leak.txt', '1', '', 'auto-wp-agent/config.php']]);
        $r = self::extract($ctx, "$root/wp/a.tar.gz", '.');
        self::assertFileDoesNotExist("$root/wp/leak.txt");
        self::assertSame(1, $r['skippedLinks'] ?? null);
    }

    /** @dataProvider linkModes PoC B / B2 */
    public function testSymlinkChainCannotEscape(bool $links): void
    {
        [$root, $ctx] = $this->linkSite($links);
        mkdir("$root/wp/dest");
        self::arch("$root/wp/b.tar.gz", [['s', '2', '', 't/..'], ['t', '2', '', '.']]);
        self::extract($ctx, "$root/wp/b.tar.gz", 'dest');
        $real = @realpath("$root/wp/dest/s");
        self::assertTrue($real === false || strpos($real, "$root/wp/dest") === 0, 'dest/s must not resolve outside dest');
        self::assertFalse(@file_get_contents("$root/wp/dest/s/auto-wp-agent/config.php"));

        self::arch("$root/wp/c.tar.gz", [['s', '2', '', 't/..'], ['t', '2', '', '.']]);
        self::extract($ctx, "$root/wp/c.tar.gz", '.');
        $real = @realpath("$root/wp/s");
        self::assertTrue($real === false || strpos($real, "$root/wp") === 0, 'wp/s must not resolve outside the WP root');
        self::assertFalse(@file_get_contents("$root/wp/s/outside.txt"));
    }

    /** @dataProvider linkModes PoC sym.php */
    public function testSymlinkToAgentConfigOrDataDirIsRefused(bool $links): void
    {
        [$root, $ctx] = $this->linkSite($links);
        self::arch("$root/wp/d.tar.gz", [['leak.txt', '2', '', 'auto-wp-agent/config.php'], ['data-leak', '2', '', '../data'], ['ok-link', '2', '', 'real.txt'], ['real.txt', '0', 'fine', '']]);
        $r = self::extract($ctx, "$root/wp/d.tar.gz", '.');
        self::assertFalse(is_link("$root/wp/leak.txt"));
        self::assertFalse(is_link("$root/wp/data-leak"));
        self::assertSame('fine', file_get_contents("$root/wp/real.txt"));
        if ($links) {
            self::assertSame('real.txt', readlink("$root/wp/ok-link"), 'benign links work when enabled');
            self::assertSame(2, $r['skippedLinks']);
        } else {
            self::assertFalse(is_link("$root/wp/ok-link"));
            self::assertSame(3, $r['skippedLinks']);
        }
    }

    public function testNoWritesThroughPreexistingSymlinkOutOfDest(): void
    {
        [$root, $ctx] = $this->linkSite(false);
        mkdir("$root/wp/dest");
        mkdir("$root/wp/elsewhere");
        symlink("$root/wp/elsewhere", "$root/wp/dest/sub");
        self::arch("$root/wp/e.tar.gz", [['sub/x.php', '0', '<?php', '']]);
        self::assertNull(self::extract($ctx, "$root/wp/e.tar.gz", 'dest'));
        self::assertFileDoesNotExist("$root/wp/elsewhere/x.php");
    }

    public function testWorldWritableModesAreMasked(): void
    {
        [$root, $ctx] = $this->linkSite(false);
        $gz = new GzipWriter("$root/wp/m.tar.gz");
        $t = new TarWriter($gz);
        $t->header('d', '5', 0, 0777, 0);
        $t->header('d/f.php', '0', 1, 04777, 0);
        $t->write('x');
        $t->pad(1);
        $t->finish();
        $gz->close();
        mkdir("$root/wp/r");
        self::extract($ctx, "$root/wp/m.tar.gz", 'r');
        clearstatcache();
        self::assertSame(0755, fileperms("$root/wp/r/d/f.php") & 07777);
        self::assertSame(0755, fileperms("$root/wp/r/d") & 07777);
    }
}
