<?php

declare(strict_types=1);

namespace AutoWp\Agent\Tests;

use AutoWp\Agent\Security\NonceStore;

final class NonceStoreTest extends TestCase
{
    public function testReplayIsRejectedWithinTtlAndAcceptedAfter(): void
    {
        $file = $this->tmpDir() . '/nonces.php';
        $s = new NonceStore($file, 600);
        self::assertTrue($s->checkAndRecord('AAECAwQFBgcICQoLDA0ODw', 1000));
        self::assertFalse($s->checkAndRecord('AAECAwQFBgcICQoLDA0ODw', 1001));
        self::assertFalse((new NonceStore($file, 600))->checkAndRecord('AAECAwQFBgcICQoLDA0ODw', 1599));
        self::assertTrue($s->checkAndRecord('EBESExQVFhcYGRobHB0eHw', 1002));
        // Expired entries are pruned.
        self::assertTrue($s->checkAndRecord('AAECAwQFBgcICQoLDA0ODw', 1600));
        self::assertStringStartsWith('<?php', (string) file_get_contents($file));
    }

    public function testCorruptStoreFailsClosed(): void
    {
        $file = $this->tmpDir() . '/nonces.php';
        file_put_contents($file, 'garbage{');
        self::assertFalse((new NonceStore($file))->checkAndRecord('AAECAwQFBgcICQoLDA0ODw', 1000));
    }
}
