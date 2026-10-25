<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Actions\ImportJob;
use AutoWp\Agent\Db\NativeDumper;
use AutoWp\Agent\Db\SqlSplitter;
use AutoWp\Agent\Db\SqlValue;

final class SqlTest extends TestCase
{
    /** @return string[] */
    private static function split(string $sql, int $chunk): array
    {
        $s = new SqlSplitter();
        $out = [];
        for ($i = 0; $i < strlen($sql); $i += $chunk) {
            foreach ($s->feed(substr($sql, $i, $chunk)) as $st) {
                $out[] = $st['sql'];
            }
        }
        foreach ($s->finish() as $st) {
            $out[] = $st['sql'];
        }
        return $out;
    }

    public function testSplitterEdgeCases(): void
    {
        $sql = "-- header comment; with semicolon\n"
            . "/*!40101 SET NAMES utf8mb4 */;\n"
            . "# hash comment;\n"
            . "INSERT INTO `t;x` VALUES ('a;b','it''s','back\\\\slash\\';still',\"dq;\\\"x\");\n"
            . "/* block ; comment */\n"
            . "SELECT 1--1;\n"
            . "SELECT '--not a comment';\n"
            . "DELIMITER ;;\n"
            . "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END ;;\n"
            . "DELIMITER ;\n"
            . "delimiter $$\nSELECT 2$$\nDELIMITER ;\n"
            . "INSERT INTO t VALUES (0x00ff);\n"
            . "SELECT 'no trailing delimiter'";
        $expected = [
            '/*!40101 SET NAMES utf8mb4 */',
            "INSERT INTO `t;x` VALUES ('a;b','it''s','back\\\\slash\\';still',\"dq;\\\"x\")",
            'SELECT 1--1',
            "SELECT '--not a comment'",
            'CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END',
            'SELECT 2',
            'INSERT INTO t VALUES (0x00ff)',
            "SELECT 'no trailing delimiter'",
        ];
        foreach ([1, 2, 3, 7, 64, 100000] as $chunk) {
            self::assertSame($expected, self::split($sql, $chunk), "chunk size $chunk");
        }
    }

    public function testSplitterOffsetsAllowResume(): void
    {
        $sql = "SET a=1;\nINSERT INTO t VALUES ('x;y');\nDELIMITER //\nSELECT 1//\nSELECT 2//\n";
        $s = new SqlSplitter();
        $all = $s->feed($sql);
        $all = array_merge($all, $s->finish());
        self::assertCount(4, $all);
        // Resume after the third statement with the recorded delimiter.
        $resume = new SqlSplitter($all[2]['end'], $all[2]['delim']);
        $rest = array_merge($resume->feed(substr($sql, $all[2]['end'])), $resume->finish());
        self::assertSame('SELECT 2', $rest[0]['sql']);
        self::assertSame(strlen($sql) - 1, $rest[0]['end']);
    }

    public function testCommentOnlyInputYieldsNothing(): void
    {
        self::assertSame([], self::split("-- a\n/* b */\n# c\n  \n", 5));
    }

    public function testDumperEscaping(): void
    {
        self::assertSame("'it\\'s'", SqlValue::quote("it's"));
        self::assertSame("'a\\\\b\\0c\\nd\\re\\Zf\\\"g'", SqlValue::quote("a\\b\0c\nd\re\x1af\"g"));
        self::assertSame("'ünïcødé 🎉'", SqlValue::quote('ünïcødé 🎉'));
        self::assertSame('NULL', SqlValue::format(null, SqlValue::KIND_STRING));
        self::assertSame("''", SqlValue::format('', SqlValue::KIND_BINARY));
        self::assertSame('0x00ff27', SqlValue::format("\x00\xff'", SqlValue::KIND_BINARY));
        self::assertSame('-12.5e3', SqlValue::format('-12.5e3', SqlValue::KIND_NUMBER));
        self::assertSame("'1; DROP TABLE x'", SqlValue::format('1; DROP TABLE x', SqlValue::KIND_NUMBER));
        self::assertSame('`we``ird`', SqlValue::ident('we`ird'));
        self::assertSame(SqlValue::KIND_BINARY, SqlValue::kindOf('varbinary(255)'));
        self::assertSame(SqlValue::KIND_BINARY, SqlValue::kindOf('longblob'));
        self::assertSame(SqlValue::KIND_BIT, SqlValue::kindOf('bit(1)'));
        self::assertSame('165', SqlValue::format('165', SqlValue::KIND_BIT));
        self::assertSame('(`b` + 0) AS `b`', SqlValue::selectExpr('b', SqlValue::KIND_BIT));
        self::assertSame(SqlValue::KIND_NUMBER, SqlValue::kindOf('bigint(20) unsigned'));
        self::assertSame(SqlValue::KIND_STRING, SqlValue::kindOf('longtext'));
        self::assertSame(SqlValue::KIND_STRING, SqlValue::kindOf('datetime'));
        self::assertSame(SqlValue::KIND_STRING, SqlValue::kindOf('binaryish_enum')); // word boundary

        // Escaped strings survive our own splitter.
        $v = "x';DROP TABLE t;--\\'\n\"";
        $stmts = self::split('INSERT INTO t VALUES (' . SqlValue::quote($v) . ');SELECT 1;', 3);
        self::assertCount(2, $stmts);
    }

    public function testKeysetConditionAndDefiner(): void
    {
        $c = NativeDumper::keysetCondition(['a', 'b'], ['5', "x'y"], ['a' => SqlValue::KIND_NUMBER, 'b' => SqlValue::KIND_STRING]);
        self::assertSame("((`a` > 5) OR (`a` = 5 AND `b` > 'x\\'y'))", $c);
        self::assertSame(
            'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1',
            NativeDumper::stripDefiner('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1')
        );
    }

    public function testImportHead(): void
    {
        self::assertSame('SET NAMES utf8mb4 */', ImportJob::head('/*!40101 SET NAMES utf8mb4 */'));
        self::assertSame('USE `other`', ImportJob::head("-- c\n/* x */ USE `other`"));
    }
}
