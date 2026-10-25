<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Actions\ImportJob;
use AutoWp\Agent\AgentException;
use AutoWp\Agent\Db\Connection;
use AutoWp\Agent\Security\IpMatcher;

/** Minimal in-memory stand-in for a MySQL session: tracks sql_mode and records statements. */
final class FakeSqlSession implements Connection
{
    /** @var string */
    public $mode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES';
    /** @var string[] */
    public $executed = [];

    public function fetchAll(string $sql): array
    {
        return [['m' => $this->mode]];
    }

    public function each(string $sql, callable $onRow): int
    {
        return 0;
    }

    public function exec(string $sql): void
    {
        $this->executed[] = $sql;
        if (preg_match("/sql_mode\\s*=\\s*'([^']*)'/i", $sql, $m) === 1) {
            $this->mode = $m[1];
        }
    }

    public function version(): string
    {
        return '10.11.0-MariaDB';
    }

    public function driver(): string
    {
        return 'fake';
    }
}

/** Regression test for PoC split.php (NO_BACKSLASH_ESCAPES statement injection) and low findings. */
final class ImportSafetyTest extends TestCase
{
    public function testDumpEnablingNoBackslashEscapesIsRefusedBeforeInjectedStatementsRun(): void
    {
        $s = $this->site();
        $db = new FakeSqlSession();
        $s['ctx']->useDb($db);
        $sql = "SET sql_mode='NO_BACKSLASH_ESCAPES';\nINSERT INTO wp_comments VALUES ('\\''); DROP TABLE wp_users; -- ');\n";
        file_put_contents($s['wp'] . '/evil.sql', $sql);
        $h = new ImportJob();
        $state = $h->init(['source' => 'evil.sql'], $s['ctx']);
        try {
            $h->step($state, $s['ctx'], INF);
            self::fail('import must refuse');
        } catch (AgentException $e) {
            self::assertSame('invalid_params', $e->getErrorCode());
            self::assertStringContainsString('NO_BACKSLASH_ESCAPES', $e->getMessage());
        }
        // The server's own default NO_BACKSLASH_ESCAPES was cleared at session start...
        self::assertStringContainsString("sql_mode = 'STRICT_TRANS_TABLES'", implode("\n", $db->executed));
        // ...and nothing after the offending SET reached the server.
        foreach ($db->executed as $q) {
            self::assertStringNotContainsString('DROP TABLE', $q);
            self::assertStringNotContainsString('INSERT', $q);
        }
    }

    public function testAnsiQuotesIsRefused(): void
    {
        $s = $this->site();
        $db = new FakeSqlSession();
        $s['ctx']->useDb($db);
        file_put_contents($s['wp'] . '/a.sql', "SET sql_mode='ANSI_QUOTES';\nSELECT 1;\n");
        $h = new ImportJob();
        $state = $h->init(['source' => 'a.sql'], $s['ctx']);
        $this->expectException(AgentException::class);
        $h->step($state, $s['ctx'], INF);
    }

    public function testIpv4MappedPrefixOutOfRangeDoesNotBlowUp(): void
    {
        self::assertFalse(IpMatcher::matches('::ffff:10.0.0.1', ['10.0.0.0/39']));
        self::assertTrue(IpMatcher::matches('::ffff:10.0.0.1', ['10.0.0.0/8']));
    }

    public function testAuthFailuresAreThrottledPerIp(): void
    {
        $now = 1000;
        $s = $this->site([], \AutoWp\Agent\Context::MODE_WEB, static function () use (&$now): int {
            return $now;
        });
        $log = $s['ctx']->authAudit();
        for ($i = 0; $i < 50; $i++) {
            $log->recordThrottled('auth_failed', '1.2.3.4|bad', ['ip' => '1.2.3.4']);
        }
        $log->recordThrottled('auth_failed', '5.6.7.8|bad', ['ip' => '5.6.7.8']);
        $now = 1061;
        $log->recordThrottled('auth_failed', '1.2.3.4|bad', ['ip' => '1.2.3.4']);
        $lines = array_values(array_filter(explode("\n", (string) file_get_contents($s['root'] . '/data/auth-failures.log.php')), static function (string $l): bool {
            return $l !== '' && $l[0] === '{';
        }));
        self::assertCount(3, $lines);
        self::assertSame(49, json_decode($lines[2], true)['suppressed']);
        self::assertFileDoesNotExist($s['root'] . '/data/audit.log.php.throttle', 'main audit log untouched');
    }
}
