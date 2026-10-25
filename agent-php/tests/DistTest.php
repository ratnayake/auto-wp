<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

/**
 * Checks the committed single-file build: up to date with src/, free of flagged constructs, and its
 * bundled sodium_compat subset verifies the test vectors (in a separate process without ext-sodium
 * functions being used).
 */
final class DistTest extends TestCase
{
    private static function dist(): string
    {
        return dirname(__DIR__) . '/dist/agent.php';
    }

    public function testDistIsFreshAndClean(): void
    {
        $code = (string) file_get_contents(self::dist());
        self::assertStringNotContainsString('eval(', $code);
        self::assertStringNotContainsString("class ParagonIE_Sodium", $code);
        self::assertStringContainsString('class AutoWpVendor_ParagonIE_Sodium_Core_Ed25519', $code);
        $out = [];
        exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(dirname(__DIR__) . '/bin/build.php') . ' --check 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
        // Every src class is in the build.
        foreach (glob(dirname(__DIR__) . '/src/{,*/}*.php', GLOB_BRACE) ?: [] as $f) {
            if (basename($f) === 'main.php') {
                continue;
            }
            self::assertStringContainsString('// ---- src/' . substr($f, strlen(dirname(__DIR__) . '/src/')), $code);
        }
    }

    public function testBundledCompatVerifiesVectors(): void
    {
        $code = (string) file_get_contents(self::dist());
        $lib = substr($code, 0, (int) strpos($code, '// ---- entry'));
        $dir = $this->tmpDir();
        file_put_contents($dir . '/lib.php', $lib);
        $v = self::vectors();
        $script = '<?php require ' . var_export($dir . '/lib.php', true) . ';' . "\n"
            . '$ok = 0; foreach (json_decode(' . var_export(json_encode($v['requests']), true) . ', true) as $r) {'
            . ' $ok += \AutoWp\Agent\Security\Ed25519::verify(base64_decode($r["ed25519SignatureB64"]), $r["canonical"], base64_decode('
            . var_export($v['ed25519']['publicKeyB64'], true) . '), true) ? 1 : 0; }'
            . ' $bad = \AutoWp\Agent\Security\Ed25519::verify(str_repeat("\0", 64), "x", base64_decode(' . var_export($v['ed25519']['publicKeyB64'], true) . '), true);'
            . ' echo $ok, $bad ? "bad" : "", class_exists("ParagonIE_Sodium_Core_Ed25519", false) ? "leak" : "";';
        file_put_contents($dir . '/run.php', $script);
        $out = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($dir . '/run.php') . ' 2>&1');
        self::assertSame((string) count($v['requests']), trim((string) $out));
    }
}
