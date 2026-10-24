<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\WpConfigReader;

final class WpConfigReaderTest extends TestCase
{
    public function testStandardConfig(): void
    {
        $src = <<<'PHP'
<?php
/** The name of the database for WordPress */
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', 'wp_user' );
define( 'DB_PASSWORD', 'p@ss\'word\\x' );
define( 'DB_HOST', 'localhost:3307' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
$table_prefix = 'wp_abc_';
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }
require_once ABSPATH . 'wp-settings.php';
PHP;
        $c = WpConfigReader::parse($src);
        self::assertSame('wordpress', $c['DB_NAME']);
        self::assertSame('wp_user', $c['DB_USER']);
        self::assertSame("p@ss'word\\x", $c['DB_PASSWORD']);
        self::assertSame('localhost:3307', $c['DB_HOST']);
        self::assertSame('wp_abc_', $c['table_prefix']);
    }

    public function testTrickyConfig(): void
    {
        $src = <<<'PHP'
<?php
// define('DB_NAME', 'commented_out');
/* define('DB_USER', 'also_commented'); */
# define('DB_PASSWORD', 'hash comment');
define(
    "DB_NAME" , // trailing comment
    'real' . "_" . 'name'
);
\define('DB_USER', "us\x65r\n");
define( 'DB_PASSWORD', "pa'ss" );
define('DB_HOST', ('db.example.com'));
define('DB_NAME', 'second definition is ignored');
$table_prefix  = "wp" . '_' ;
$x->define('DB_CHARSET', 'not a real define');
define('DB_CHARSET', 'utf8');
PHP;
        $c = WpConfigReader::parse($src);
        self::assertSame('real_name', $c['DB_NAME']);
        self::assertSame("user\n", $c['DB_USER']);
        self::assertSame("pa'ss", $c['DB_PASSWORD']);
        self::assertSame('db.example.com', $c['DB_HOST']);
        self::assertSame('wp_', $c['table_prefix']);
        self::assertSame('utf8', $c['DB_CHARSET']);
    }

    public function testDollarAndEscapesInDoubleQuotes(): void
    {
        $src = '<?php define("DB_NAME","n"); define("DB_USER","u"); define("DB_HOST","h");'
            . ' define("DB_PASSWORD", "a\\$b\\\\c\\"d\\t\\101\\u{e9}");';
        self::assertSame("a\$b\\c\"d\tA\u{e9}", WpConfigReader::parse($src)['DB_PASSWORD']);
    }

    public function testNowdoc(): void
    {
        $src = "<?php define('DB_NAME','n'); define('DB_USER','u'); define('DB_HOST','h');\n"
            . "define('DB_PASSWORD', <<<'EOT'\nno\$interp\nEOT\n);";
        self::assertSame('no$interp', WpConfigReader::parse($src)['DB_PASSWORD']);
    }

    public function testNonLiteralIsRefusedNotEvaluated(): void
    {
        $src = "<?php define('DB_NAME','n'); define('DB_USER','u'); define('DB_HOST','h');\n"
            . "define('DB_PASSWORD', getenv('DB_PASS'));\ndefine('DB_PASSWORD', \"x{\$y}\");";
        $this->expectException(AgentException::class);
        $this->expectExceptionMessage('DB_PASSWORD');
        WpConfigReader::parse($src);
    }

    public function testParseHost(): void
    {
        self::assertSame(['host' => 'localhost', 'port' => null, 'socket' => null], WpConfigReader::parseHost('localhost'));
        self::assertSame(['host' => '127.0.0.1', 'port' => 3307, 'socket' => null], WpConfigReader::parseHost('127.0.0.1:3307'));
        self::assertSame(['host' => 'localhost', 'port' => null, 'socket' => '/tmp/my.sock'], WpConfigReader::parseHost('localhost:/tmp/my.sock'));
        self::assertSame(['host' => '::1', 'port' => 3306, 'socket' => null], WpConfigReader::parseHost('[::1]:3306'));
        self::assertSame(['host' => 'db', 'port' => null, 'socket' => null], WpConfigReader::parseHost('p:db'));
    }

    public function testLocateOneLevelUp(): void
    {
        $root = $this->tmpDir();
        mkdir($root . '/public_html');
        file_put_contents($root . '/wp-config.php', '<?php');
        self::assertSame($root . '/wp-config.php', WpConfigReader::locate($root . '/public_html'));
        file_put_contents($root . '/wp-settings.php', '<?php');
        self::assertNull(WpConfigReader::locate($root . '/public_html'));
    }
}
