<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\Params;

/**
 * The action allowlist and parameter specs, mirroring packages/contracts/src/actions.ts.
 */
final class Registry
{
    public const JOB_ACTIONS = ['fs.archive', 'fs.extract', 'db.dump', 'db.import', 'fs.count', 'fs.sha256'];
    public const BRIDGE_ACTIONS = ['wp.inventory', 'wp.upgrade'];

    /** @return array<string, array<string, array<string, mixed>>> */
    public static function specs(): array
    {
        $path = ['type' => 'path'];
        $excludes = ['type' => 'strings', 'default' => []];
        return [
            'probe' => [],
            'job.status' => ['jobId' => ['type' => 'string', 'maxLen' => 64]],
            'fs.stat' => ['path' => $path],
            'fs.list' => ['path' => $path],
            'fs.readChunk' => [
                'path' => $path,
                'offset' => ['type' => 'int', 'min' => 0],
                'length' => ['type' => 'int', 'min' => 1, 'max' => 8388608],
            ],
            'fs.writeChunk' => [
                'path' => $path,
                'offset' => ['type' => 'int', 'min' => 0],
                'dataB64' => ['type' => 'string', 'maxLen' => 12000000],
                'truncate' => ['type' => 'bool', 'default' => false],
                'mode' => ['type' => 'int', 'optional' => true, 'min' => 0, 'max' => 07777],
            ],
            'fs.mkdir' => [
                'path' => $path,
                'recursive' => ['type' => 'bool', 'default' => true],
                'mode' => ['type' => 'int', 'optional' => true, 'min' => 0, 'max' => 07777],
            ],
            'fs.rename' => ['from' => $path, 'to' => $path],
            'fs.remove' => ['path' => $path, 'recursive' => ['type' => 'bool', 'default' => false]],
            'fs.archive' => [
                'sourceDir' => $path,
                'dest' => $path,
                'excludes' => $excludes,
                'paths' => ['type' => 'paths', 'optional' => true],
            ],
            'fs.extract' => ['archive' => $path, 'destDir' => $path, 'overwrite' => ['type' => 'bool', 'default' => true]],
            'fs.count' => ['dir' => $path, 'excludes' => $excludes],
            'fs.sha256' => ['path' => $path],
            'fs.testArchive' => ['path' => $path],
            'db.info' => [],
            'db.dump' => ['dest' => $path, 'excludeTables' => ['type' => 'strings', 'default' => []]],
            'db.import' => ['source' => $path],
            'wp.inventory' => ['refresh' => ['type' => 'bool', 'default' => true]],
            'wp.upgrade' => [
                'type' => ['type' => 'enum', 'values' => ['core', 'plugin', 'theme']],
                'slug' => ['type' => 'string', 'minLen' => 1, 'maxLen' => 200, 'pattern' => Params::SLUG_PATTERN],
                'version' => ['type' => 'string', 'optional' => true, 'maxLen' => 64, 'pattern' => '/^[A-Za-z0-9._+-]+$/D'],
            ],
            'wp.maintenance' => [
                'enabled' => ['type' => 'bool'],
                'bypassToken' => ['type' => 'string', 'optional' => true, 'minLen' => 16, 'maxLen' => 128],
            ],
            'logs.tail' => [
                'path' => $path,
                'fromOffset' => ['type' => 'int', 'min' => 0],
                'maxBytes' => ['type' => 'int', 'min' => 1, 'default' => 1048576],
            ],
            'cache.flush' => [
                'opcache' => ['type' => 'bool', 'default' => true],
                'objectCache' => ['type' => 'bool', 'default' => true],
            ],
            'lock.acquire' => [
                'runId' => ['type' => 'string', 'minLen' => 1, 'maxLen' => 200],
                'ttlSec' => ['type' => 'int', 'min' => 1, 'max' => 604800, 'default' => 3600],
            ],
            'lock.release' => ['runId' => ['type' => 'string', 'minLen' => 1, 'maxLen' => 200]],
        ];
    }

    /** @return array<string, callable> synchronous actions */
    public static function sync(): array
    {
        return [
            'probe' => [Probe::class, 'run'],
            'fs.stat' => [FsActions::class, 'stat'],
            'fs.list' => [FsActions::class, 'list'],
            'fs.readChunk' => [FsActions::class, 'readChunk'],
            'fs.writeChunk' => [FsActions::class, 'writeChunk'],
            'fs.mkdir' => [FsActions::class, 'mkdir'],
            'fs.rename' => [FsActions::class, 'rename'],
            'fs.remove' => [FsActions::class, 'remove'],
            'fs.testArchive' => [TestArchive::class, 'run'],
            'db.info' => [DbInfo::class, 'run'],
            'wp.maintenance' => [SiteActions::class, 'maintenance'],
            'logs.tail' => [SiteActions::class, 'logsTail'],
            'lock.acquire' => [SiteActions::class, 'lockAcquire'],
            'lock.release' => [SiteActions::class, 'lockRelease'],
        ];
    }

    /** @return array<string, \AutoWp\Agent\Jobs\JobHandler> */
    public static function jobs(): array
    {
        return [
            'fs.archive' => new ArchiveJob(),
            'fs.extract' => new ExtractJob(),
            'db.dump' => new DumpJob(),
            'db.import' => new ImportJob(),
            'fs.count' => new CountJob(),
            'fs.sha256' => new Sha256Job(),
        ];
    }
}
