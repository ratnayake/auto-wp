<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Security\PathJail;

final class PathJailTest extends TestCase
{
    /** @return array{0: PathJail, 1: string, 2: string} */
    private function jail(): array
    {
        $root = $this->tmpDir();
        mkdir($root . '/wp/wp-content/uploads', 0755, true);
        mkdir($root . '/wp/auto-wp-agent', 0755, true);
        mkdir($root . '/outside', 0755, true);
        mkdir($root . '/secret', 0755, true);
        file_put_contents($root . '/secret/passwd', 'x');
        file_put_contents($root . '/wp/wp-config.php', '<?php');
        $jail = new PathJail($root . '/wp', [$root . '/wp', $root . '/outside'], [$root . '/wp/auto-wp-agent', $root . '/data']);
        return [$jail, $root . '/wp', $root];
    }

    private function assertJailed(PathJail $j, string $path, bool $noFollow = false): void
    {
        try {
            $noFollow ? $j->resolveNoFollow($path) : $j->resolve($path);
            self::fail('expected path_jail for ' . json_encode($path));
        } catch (AgentException $e) {
            self::assertSame('path_jail', $e->getErrorCode(), $path);
        }
    }

    public function testResolvesRelativeAndAbsoluteInsideRoots(): void
    {
        [$j, $wp, $root] = $this->jail();
        self::assertSame($wp . '/wp-config.php', $j->resolve('wp-config.php'));
        self::assertSame($wp . '/wp-content/new/file.txt', $j->resolve('wp-content/./new//file.txt'));
        self::assertSame($wp . '/wp-config.php', $j->resolve('wp-content/../wp-config.php'));
        self::assertSame($root . '/outside/x', $j->resolve($root . '/outside/x'));
    }

    public function testDotDotEscapes(): void
    {
        [$j, , $root] = $this->jail();
        $this->assertJailed($j, '../secret/passwd');
        $this->assertJailed($j, 'wp-content/../../secret/passwd');
        $this->assertJailed($j, '../../../../../../../../etc/passwd');
        $this->assertJailed($j, '..');
    }

    public function testAbsoluteOutside(): void
    {
        [$j, , $root] = $this->jail();
        $this->assertJailed($j, '/etc/passwd');
        $this->assertJailed($j, $root . '/secret/passwd');
        $this->assertJailed($j, '/');
    }

    public function testNullByte(): void
    {
        [$j] = $this->jail();
        $this->assertJailed($j, "wp-config.php\0.txt");
        $this->assertJailed($j, "\0");
    }

    public function testSymlinkEscape(): void
    {
        [$j, $wp, $root] = $this->jail();
        symlink($root . '/secret', $wp . '/wp-content/evil');
        symlink($root . '/secret/passwd', $wp . '/wp-content/evil-file');
        symlink($root . '/nowhere', $wp . '/wp-content/dangling');
        $this->assertJailed($j, 'wp-content/evil/passwd');
        $this->assertJailed($j, 'wp-content/evil/newfile');
        $this->assertJailed($j, 'wp-content/evil-file');
        $this->assertJailed($j, 'wp-content/dangling');
        $this->assertJailed($j, 'wp-content/dangling/x');
        // The link itself may be stat'ed/removed (no-follow), but a link to a forbidden path may not.
        self::assertSame($wp . '/wp-content/evil', $j->resolveNoFollow('wp-content/evil'));
        symlink($wp . '/auto-wp-agent', $wp . '/wp-content/agent-link');
        $this->assertJailed($j, 'wp-content/agent-link', true);
        // A symlink pointing inside the jail is fine.
        symlink($wp . '/wp-content/uploads', $wp . '/uploads-link');
        self::assertSame($wp . '/wp-content/uploads/a.jpg', $j->resolve('uploads-link/a.jpg'));
    }

    public function testAgentDirIsForbidden(): void
    {
        [$j, $wp] = $this->jail();
        $this->assertJailed($j, 'auto-wp-agent');
        $this->assertJailed($j, 'auto-wp-agent/config.php');
        $this->assertJailed($j, 'wp-content/../auto-wp-agent/agent.php');
        self::assertTrue($j->containsForbidden($wp));
        self::assertFalse($j->containsForbidden($wp . '/wp-content'));
    }

    public function testSafeRelative(): void
    {
        self::assertSame('a/b', PathJail::safeRelative('./a//b/'));
        foreach (['/abs', '../x', 'a/../../x', "a\0b", '', '.'] as $bad) {
            try {
                PathJail::safeRelative($bad);
                self::fail('expected failure for ' . json_encode($bad));
            } catch (AgentException $e) {
                self::assertSame('path_jail', $e->getErrorCode());
            }
        }
    }
}
