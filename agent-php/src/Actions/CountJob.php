<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\Fs\ExcludeMatcher;
use AutoWp\Agent\Fs\TreeWalker;
use AutoWp\Agent\Jobs\JobHandler;

/** fs.count: files (regular + symlinks) and regular-file bytes under a directory, honouring excludes. */
final class CountJob implements JobHandler
{
    public function init(array $params, Context $ctx): array
    {
        $dir = $ctx->jail->resolve($params['dir']);
        if (!is_dir($dir)) {
            throw AgentException::notFound('directory not found');
        }
        return ['dir' => $dir, 'excludes' => $params['excludes'], 'walker' => null, 'fileCount' => 0, 'bytes' => 0];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        $walker = new TreeWalker(
            $state['dir'],
            new ExcludeMatcher($state['excludes']),
            WalkSupport::skipper($ctx),
            $state['walker']
        );
        $n = 0;
        while (($e = $walker->next()) !== null) {
            if ($e['type'] === 'file' || $e['type'] === 'symlink') {
                $state['fileCount']++;
                $state['bytes'] += $e['size'];
            }
            if ((++$n & 255) === 0 && microtime(true) >= $deadline) {
                $state['walker'] = $walker->state();
                return null;
            }
        }
        return ['fileCount' => $state['fileCount'], 'bytes' => $state['bytes']];
    }

    public function progress(array $state): array
    {
        return ['done' => $state['fileCount'], 'message' => 'counting files'];
    }
}
