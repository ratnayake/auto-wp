<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Actions\ArchiveJob;
use AutoWp\Agent\Actions\CountJob;
use AutoWp\Agent\Actions\ExtractJob;
use AutoWp\Agent\Actions\TestArchive;
use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipReader;
use AutoWp\Agent\Archive\GzipWriter;
use AutoWp\Agent\Archive\TarWriter;
use AutoWp\Agent\Context;
use AutoWp\Agent\Fs\ExcludeMatcher;
use AutoWp\Agent\Jobs\JobHandler;

final class ArchiveTest extends TestCase
{
    private const LONG_DIR = 'wp-content/plugins/a-plugin-with-a-really-long-directory-name-that-goes-on-and-on/includes/sub-directory-level-two';

    /** Creates a sample tree in <wp>. @return array<string, string> rel => content */
    private function populate(string $wp): array
    {
        $files = [
            'index.php' => '<?php // index',
            'wp-config.php' => "<?php define('DB_NAME','x');",
            'wp-content/uploads/2026/10/ünïcødé photo.jpg' => random_bytes(70000),
            'wp-content/cache/page.html' => 'cached',
            'wp-content/debug.log' => "log line\n",
            self::LONG_DIR . '/' . str_repeat('very-long-file-name-', 8) . '.php' => '<?php // long',
            'wp-content/empty.txt' => '',
            '-starts-with-dash.txt' => 'dash',
            'auto-wp-backup/old/db.sql.gz' => 'must never be archived',
        ];
        foreach ($files as $rel => $content) {
            @mkdir(dirname($wp . '/' . $rel), 0755, true);
            file_put_contents($wp . '/' . $rel, $content);
        }
        mkdir($wp . '/wp-content/empty-dir', 0755, true);
        symlink('uploads/2026', $wp . '/wp-content/link-to-2026');
        return $files;
    }

    /**
     * Runs a job with a tiny slice budget so it needs many slices (each with a fresh handler, like
     * separate web requests, and a JSON round trip of the state).
     *
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    private static function runSliced(JobHandler $h, string $cls, array $params, Context $ctx, float $slice = 0.0): array
    {
        $state = $h->init($params, $ctx);
        for ($i = 0; $i < 100000; $i++) {
            $state = json_decode((string) json_encode(\AutoWp\Agent\Jobs\JobRunner::wrap($state)), true);
            $state = \AutoWp\Agent\Jobs\JobRunner::unwrap($state);
            $fresh = new $cls();
            $r = $fresh->step($state, $ctx, microtime(true) + $slice);
            if ($r !== null) {
                return $r;
            }
        }
        self::fail('job did not finish');
    }

    public function testNativeTarRoundTripWithLongNamesAcrossSlices(): void
    {
        $s = $this->site([], Context::MODE_WEB);
        $files = $this->populate($s['wp']);
        $ctx = $s['ctx'];
        $res = self::runSliced(new ArchiveJob(), ArchiveJob::class, [
            'sourceDir' => '.',
            'dest' => $s['root'] . '/out.tar.gz',
        ] + ['excludes' => ['wp-content/cache', '*.log'], 'paths' => null], $this->withOutside($s), 0.0);

        self::assertSame(64, strlen($res['sha256']));
        self::assertSame(hash_file('sha256', $s['root'] . '/out.tar.gz'), $res['sha256']);
        // files: all minus cache, log, backup dir; plus the symlink.
        self::assertSame(count($files) - 3 + 1, $res['fileCount']);

        // fs.count agrees with the archive.
        $count = self::runSliced(new CountJob(), CountJob::class, ['dir' => '.', 'excludes' => ['wp-content/cache', '*.log']], $ctx);
        self::assertSame($res['fileCount'], $count['fileCount']);
        self::assertSame($res['bytes'], $count['bytes']);

        $t = TestArchive::test($s['root'] . '/out.tar.gz');
        self::assertTrue($t['ok'], $t['error'] ?? '');

        // GNU tar can read it, including the long names.
        if (is_executable('/usr/bin/tar') || is_executable('/bin/tar')) {
            $list = shell_exec('tar -tzf ' . escapeshellarg($s['root'] . '/out.tar.gz'));
            self::assertStringContainsString(str_repeat('very-long-file-name-', 8) . '.php', (string) $list);
        }

        // Extract (also sliced) into a fresh directory and compare.
        mkdir($s['wp'] . '/restore');
        $x = self::runSliced(new ExtractJob(), ExtractJob::class, [
            'archive' => $s['root'] . '/out.tar.gz', 'destDir' => 'restore', 'overwrite' => true,
        ], $this->withOutside($s), 0.0);
        self::assertSame($res['fileCount'], $x['fileCount']);
        foreach ($files as $rel => $content) {
            $path = $s['wp'] . '/restore/' . $rel;
            if ($rel === 'wp-content/cache/page.html' || $rel === 'wp-content/debug.log' || strpos($rel, 'auto-wp-backup') === 0) {
                self::assertFileDoesNotExist($path);
                continue;
            }
            self::assertSame($content, file_get_contents($path), $rel);
        }
        self::assertDirectoryExists($s['wp'] . '/restore/wp-content/empty-dir');
        self::assertSame('uploads/2026', readlink($s['wp'] . '/restore/wp-content/link-to-2026'));
        self::assertDirectoryDoesNotExist($s['wp'] . '/restore/auto-wp-agent');
    }

    private function withOutside(array $s): Context
    {
        $cfg = \AutoWp\Agent\Config::fromArray([
            'siteId' => 'site-agent',
            'wpRoot' => $s['wp'],
            'dataDir' => $s['root'] . '/data',
            'outsideDocrootDir' => $s['root'],
            'extractLinks' => true,
        ]);
        return new Context($cfg, Context::MODE_WEB, 'time', $s['wp'] . '/auto-wp-agent/agent.php');
    }

    public function testTarBinaryPathMatchesNative(): void
    {
        $s = $this->site();
        $this->populate($s['wp']);
        $ctx = $this->withOutsideCli($s);
        if (!$ctx->mayUseBinaries() || $ctx->binaries->find('tar') === null) {
            self::markTestSkipped('tar not available');
        }
        $h = new ArchiveJob();
        $state = $h->init(['sourceDir' => '.', 'dest' => $s['root'] . '/bin.tar.gz', 'excludes' => ['wp-content/cache'], 'paths' => null], $ctx);
        self::assertSame('tar', $state['method']);
        $res = $h->step($state, $ctx, INF);
        self::assertTrue(TestArchive::test($s['root'] . '/bin.tar.gz')['ok']);
        mkdir($s['root'] . '/x');
        $x = (new ExtractJob());
        $st = $x->init(['archive' => $s['root'] . '/bin.tar.gz', 'destDir' => $s['root'] . '/x', 'overwrite' => true], $ctx);
        $r = $x->step($st, $ctx, INF);
        self::assertSame($res['fileCount'], $r['fileCount'] + $r['skippedLinks'], 'symlinks are skipped by default');
        self::assertSame(1, $r['skippedLinks']);
        self::assertFileExists($s['root'] . '/x/-starts-with-dash.txt');
        self::assertFileDoesNotExist($s['root'] . '/x/auto-wp-backup/old/db.sql.gz');
    }

    private function withOutsideCli(array $s): Context
    {
        $cfg = \AutoWp\Agent\Config::fromArray([
            'siteId' => 'site-agent', 'wpRoot' => $s['wp'], 'dataDir' => $s['root'] . '/data', 'outsideDocrootDir' => $s['root'],
        ]);
        return new Context($cfg, Context::MODE_CLI, 'time', $s['wp'] . '/auto-wp-agent/agent.php');
    }

    /** Writes a .tar.gz with arbitrary raw entries. */
    private static function evilArchive(string $file, array $entries): void
    {
        $gz = new GzipWriter($file);
        $tar = new TarWriter($gz);
        foreach ($entries as [$name, $type, $data, $link]) {
            $tar->header($name, $type, strlen($data), 0644, 0, $link);
            $tar->write($data);
            $tar->pad(strlen($data));
        }
        $tar->finish();
        $gz->close();
    }

    /** @return array<string, array{0: array}> */
    public function evilEntries(): array
    {
        return [
            'dot-dot' => [[['../escape.txt', '0', 'x', '']]],
            'nested dot-dot' => [[['a/../../escape.txt', '0', 'x', '']]],
            'absolute' => [[['/tmp/escape.txt', '0', 'x', '']]],
            'symlink then write through it' => [[['link', '2', '', '/tmp'], ['link/escape.txt', '0', 'x', '']]],
            'relative symlink escape then write' => [[['d/', '5', '', ''], ['d/up', '2', '', '../../..'], ['d/up/escape.txt', '0', 'x', '']]],
            'chained symlinks climbing out' => [[
                ['a/', '5', '', ''], ['a/l', '2', '', '..'], ['a/m', '2', '', 'l/..'], ['a/n', '2', '', 'm/..'],
                ['a/n/escape.txt', '0', 'x', ''], ['a/m/escape.txt', '0', 'x', ''],
            ]],
            'hard link to a file outside' => [[['a/', '5', '', ''], ['a/l', '2', '', '..'], ['a/m', '2', '', 'l/..'], ['leak', '1', '', 'a/m/secret.txt']]],
        ];
    }

    /** @dataProvider evilEntries */
    public function testExtractRefusesTraversal(array $entries): void
    {
        $s = $this->site();
        $arch = $s['wp'] . '/evil.tar.gz';
        file_put_contents($s['wp'] . '/secret.txt', 'outside destDir');
        self::evilArchive($arch, $entries);
        mkdir($s['wp'] . '/dest');
        $h = new ExtractJob();
        $state = $h->init(['archive' => $arch, 'destDir' => 'dest', 'overwrite' => true], $s['ctx']);
        try {
            $h->step($state, $s['ctx'], INF);
        } catch (AgentException $e) {
            self::assertSame('path_jail', $e->getErrorCode());
        }
        self::assertFileDoesNotExist($s['root'] . '/escape.txt');
        self::assertFileDoesNotExist($s['wp'] . '/escape.txt');
        self::assertFileDoesNotExist('/tmp/escape.txt');
        self::assertFileDoesNotExist($s['wp'] . '/dest/leak');
        self::assertFalse(is_link($s['wp'] . '/dest/a/m'), 'link climbing out of destDir must not be created');
        self::assertFalse(is_link($s['wp'] . '/dest/link'), 'absolute symlink must not be created');
        self::assertFalse(is_link($s['wp'] . '/dest/d/up'), 'escaping symlink must not be created');
    }

    public function testSlicedExtractWithOverwriteFalseSkipsCleanly(): void
    {
        $s = $this->site([], Context::MODE_WEB);
        $files = $this->populate($s['wp']);
        $h = new ArchiveJob();
        $state = $h->init(['sourceDir' => 'wp-content', 'dest' => 'a.tar.gz', 'excludes' => [], 'paths' => null], $s['ctx']);
        $h->step($state, $s['ctx'], INF);
        mkdir($s['wp'] . '/r');
        // Pre-existing files with other content must survive overwrite=false.
        mkdir($s['wp'] . '/r/uploads/2026/10', 0755, true);
        file_put_contents($s['wp'] . '/r/uploads/2026/10/ünïcødé photo.jpg', 'keep me');
        file_put_contents($s['wp'] . '/r/debug.log', 'keep me too');
        $x = self::runSliced(new ExtractJob(), ExtractJob::class, ['archive' => 'a.tar.gz', 'destDir' => 'r', 'overwrite' => false], $s['ctx'], 0.0);
        self::assertSame('keep me', file_get_contents($s['wp'] . '/r/uploads/2026/10/ünïcødé photo.jpg'));
        self::assertSame('keep me too', file_get_contents($s['wp'] . '/r/debug.log'));
        self::assertSame($files['wp-content/cache/page.html'], file_get_contents($s['wp'] . '/r/cache/page.html'));
        self::assertSame([], glob($s['wp'] . '/r/{,*/,*/*/}.*.autowp-part', GLOB_BRACE));
        self::assertSame(3, $x['fileCount']);
        self::assertSame(1, $x['skippedLinks']);
    }

    public function testTruncatedAndCorruptArchivesFailTest(): void
    {
        $s = $this->site();
        $this->populate($s['wp']);
        $h = new ArchiveJob();
        $state = $h->init(['sourceDir' => '.', 'dest' => 'auto-wp-backup/a.tar.gz', 'excludes' => [], 'paths' => null], $s['ctx']);
        $state['method'] = 'native';
        $h->step($state, $s['ctx'], INF);
        $file = $s['wp'] . '/auto-wp-backup/a.tar.gz';
        $data = (string) file_get_contents($file);
        self::assertTrue(TestArchive::test($file)['ok']);

        file_put_contents($file, substr($data, 0, (int) (strlen($data) / 2)));
        $r = TestArchive::test($file);
        self::assertFalse($r['ok']);

        $corrupt = $data;
        $corrupt[(int) (strlen($data) / 2)] = chr(ord($corrupt[(int) (strlen($data) / 2)]) ^ 0xff);
        file_put_contents($file, $corrupt);
        self::assertFalse(TestArchive::test($file)['ok']);

        file_put_contents($file, 'not gzip at all');
        self::assertFalse(TestArchive::test($file)['ok']);
    }

    public function testGzipReaderCheckpointResumeOnMultiMember(): void
    {
        $dir = $this->tmpDir();
        $file = $dir . '/m.gz';
        $plain = '';
        $size = 0;
        for ($i = 0; $i < 5; $i++) {
            $w = new GzipWriter($file, $size);
            $chunk = str_repeat("member $i ", 1000) . random_bytes(100);
            $w->write($chunk);
            $plain .= $chunk;
            $size = $w->close();
        }
        self::assertSame($plain, file_get_contents('compress.zlib://' . $file));
        $r = new GzipReader($file);
        $first = $r->read(23456);
        $cp = $r->checkpoint();
        $r2 = new GzipReader($file, json_decode((string) json_encode($cp), true));
        $rest = '';
        while (($c = $r2->read(7777)) !== '') {
            $rest .= $c;
        }
        self::assertSame($plain, $first . $rest);
    }

    public function testExcludeMatcher(): void
    {
        $m = new ExcludeMatcher(['*.log', 'wp-content/cache', '/node_modules/', 'wp-content/uploads/**/*.zip', 'tmp[0-9]']);
        self::assertTrue($m->excluded('debug.log', false));
        self::assertTrue($m->excluded('a/b/debug.log', false));
        self::assertTrue($m->excluded('wp-content/cache', true));
        self::assertFalse($m->excluded('x/wp-content/cache', true));
        self::assertTrue($m->excluded('node_modules', true));
        self::assertFalse($m->excluded('node_modules', false));
        self::assertTrue($m->excluded('wp-content/uploads/2026/10/a.zip', false));
        self::assertTrue($m->excluded('wp-content/uploads/a.zip', false));
        self::assertTrue($m->excluded('x/tmp5', true));
        self::assertFalse($m->excluded('wp-content/uploads/a.jpg', false));
    }
}
