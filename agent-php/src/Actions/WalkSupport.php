<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\Context;
use AutoWp\Agent\Security\PathJail;

/** Paths every walk (fs.archive, fs.count) leaves out, whatever the excludes say. */
final class WalkSupport
{
    public const BACKUP_DIR = 'auto-wp-backup';

    /**
     * @param string[] $extra absolute paths to skip as well (e.g. the archive being written)
     * @return callable(string): bool
     */
    public static function skipper(Context $ctx, array $extra = []): callable
    {
        $skip = array_merge($ctx->jail->forbiddenPaths(), $extra, [$ctx->config->wpRoot . '/' . self::BACKUP_DIR]);
        if ($ctx->config->outsideDocrootDir !== null) {
            $skip[] = $ctx->config->outsideDocrootDir . '/' . self::BACKUP_DIR;
        }
        return static function (string $abs) use ($skip): bool {
            foreach ($skip as $s) {
                if (PathJail::isInside($abs, $s)) {
                    return true;
                }
            }
            return false;
        };
    }
}
