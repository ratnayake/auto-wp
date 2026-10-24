<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Archive\GzipReader;
use AutoWp\Agent\Archive\PlainReader;
use AutoWp\Agent\Archive\TarReader;
use AutoWp\Agent\Context;

/** fs.testArchive: streams the whole gzip (CRC-checked) and tar, counting entries. */
final class TestArchive
{
    /**
     * @param array{path: string} $p
     * @return array{ok: bool, entries: int, error?: string}
     */
    public static function run(array $p, Context $ctx): array
    {
        $abs = $ctx->jail->resolve($p['path']);
        if (!is_file($abs)) {
            throw AgentException::notFound('archive not found');
        }
        @set_time_limit(0);
        return self::test($abs);
    }

    /**
     * @return array{ok: bool, entries: int, error?: string}
     */
    public static function test(string $abs): array
    {
        $entries = 0;
        try {
            $src = PlainReader::isGzip($abs) ? new GzipReader($abs) : new PlainReader($abs);
            $tar = new TarReader($src);
            while ($tar->next() !== null) {
                $entries++;
            }
            while ($src->read(1048576) !== '') {
            }
            return ['ok' => true, 'entries' => $entries];
        } catch (AgentException $e) {
            return ['ok' => false, 'entries' => $entries, 'error' => $e->getMessage()];
        }
    }
}
