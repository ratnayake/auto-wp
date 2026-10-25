<?php

declare(strict_types=1);

namespace AutoWp\Agent\Actions;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\Fs\FsUtil;
use AutoWp\Agent\Jobs\JobHandler;

/**
 * fs.sha256, streamed. Where HashContext can be serialised (PHP 8) the hash resumes across slices;
 * on PHP 7.4 the file is hashed within one slice.
 */
final class Sha256Job implements JobHandler
{
    private const CHUNK = 4194304;

    public function init(array $params, Context $ctx): array
    {
        $abs = $ctx->jail->resolve($params['path']);
        if (!is_file($abs)) {
            throw AgentException::notFound('file not found');
        }
        return ['path' => $abs, 'offset' => 0, 'size' => (int) filesize($abs), 'ctx' => null];
    }

    public function step(array &$state, Context $ctx, float $deadline)
    {
        if (!self::resumable()) {
            $h = FsUtil::sha256File($state['path']);
            clearstatcache(true, $state['path']);
            return ['sha256' => $h, 'bytes' => (int) filesize($state['path'])];
        }
        $hc = $state['ctx'] === null ? hash_init('sha256') : unserialize(base64_decode($state['ctx']), ['allowed_classes' => [\HashContext::class]]);
        if (!$hc instanceof \HashContext) {
            throw AgentException::internal('corrupt job state');
        }
        $fh = @fopen($state['path'], 'rb');
        if ($fh === false || fseek($fh, $state['offset']) !== 0) {
            throw AgentException::internal('cannot read file');
        }
        try {
            while (true) {
                $chunk = fread($fh, self::CHUNK);
                if ($chunk === false || $chunk === '') {
                    return ['sha256' => hash_final($hc), 'bytes' => $state['offset']];
                }
                hash_update($hc, $chunk);
                $state['offset'] += strlen($chunk);
                if (microtime(true) >= $deadline) {
                    $state['ctx'] = base64_encode(serialize($hc));
                    return null;
                }
            }
        } finally {
            fclose($fh);
        }
    }

    public function progress(array $state): array
    {
        return ['done' => $state['offset'], 'total' => $state['size']];
    }

    private static function resumable(): bool
    {
        static $ok = null;
        if ($ok === null) {
            try {
                serialize(hash_init('sha256'));
                $ok = true;
            } catch (\Throwable $e) {
                $ok = false;
            }
        }
        return $ok;
    }
}
