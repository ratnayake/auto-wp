<?php

declare(strict_types=1);

namespace AutoWp\Agent\Jobs;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Context;
use AutoWp\Agent\DataDir;
use AutoWp\Agent\Json;

/**
 * Runs JobHandlers. CLI mode runs a job to completion in one go. Web mode persists the job in the
 * agent's data dir and advances it by one slice per request (the first slice runs immediately, and
 * each `job.status` poll runs another), so no request exceeds max_execution_time.
 */
final class JobRunner
{
    public const ID_PATTERN = '/^[a-f0-9]{32}$/D';
    private const MAX_INTERRUPTED_SLICES = 3;
    private const RETENTION_SEC = 86400;

    /** @var Context */
    private $ctx;
    /** @var array<string, JobHandler> */
    private $handlers;

    /**
     * @param array<string, JobHandler> $handlers action name => handler
     */
    public function __construct(Context $ctx, array $handlers)
    {
        $this->ctx = $ctx;
        $this->handlers = $handlers;
    }

    /**
     * @param array<string, mixed> $params
     * @return array{result: mixed}|array{job: array{jobId: string}}
     */
    public function start(string $action, array $params): array
    {
        $h = $this->handler($action);
        $state = $h->init($params, $this->ctx);
        if ($this->ctx->isCli()) {
            @set_time_limit(0);
            $result = null;
            while ($result === null) {
                $result = $h->step($state, $this->ctx, INF);
            }
            return ['result' => $result];
        }

        $this->gc();
        $id = bin2hex(random_bytes(16));
        $job = [
            'jobId' => $id,
            'action' => $action,
            'state' => $state,
            'status' => 'running',
            'interrupted' => 0,
            'createdAt' => $this->ctx->now(),
        ];
        $this->save($job);
        $job = $this->advance($job);
        if ($job['status'] === 'done') {
            @unlink($this->file($id));
            return ['result' => $job['result']];
        }
        if ($job['status'] === 'failed') {
            @unlink($this->file($id));
            throw new AgentException((string) $job['error']['code'], (string) $job['error']['message']);
        }
        return ['job' => ['jobId' => $id]];
    }

    /** @return array<string, mixed> JobStatus */
    public function status(string $jobId): array
    {
        if (preg_match(self::ID_PATTERN, $jobId) !== 1) {
            throw AgentException::invalidParams('invalid jobId');
        }
        $lock = @fopen($this->file($jobId) . '.lock', 'c');
        if ($lock === false) {
            throw AgentException::internal('cannot lock job');
        }
        try {
            $job = $this->load($jobId);
            if ($job === null) {
                throw AgentException::notFound('unknown job');
            }
            if ($job['status'] === 'running' && flock($lock, LOCK_EX | LOCK_NB)) {
                $job = $this->load($jobId) ?? $job;
                if ($job['status'] === 'running') {
                    $job = $this->advance($job);
                }
                flock($lock, LOCK_UN);
            }
        } finally {
            fclose($lock);
        }
        return $this->describe($job);
    }

    /**
     * @param array<string, mixed> $job
     * @return array<string, mixed>
     */
    private function advance(array $job): array
    {
        $h = $this->handler((string) $job['action']);
        if ((int) $job['interrupted'] >= self::MAX_INTERRUPTED_SLICES) {
            $job['status'] = 'failed';
            $job['error'] = ['code' => 'internal', 'message' => 'job slice was repeatedly interrupted (execution time limit?)'];
            $this->save($job);
            return $job;
        }
        // Mark the slice as in-flight; a slice killed by the host leaves this counter raised.
        $job['interrupted'] = (int) $job['interrupted'] + 1;
        $this->save($job);
        $state = $job['state'];
        $budget = $this->ctx->sliceSeconds();
        @set_time_limit((int) ceil($budget * 3) + 30);
        try {
            $result = $h->step($state, $this->ctx, microtime(true) + $budget);
            $job['state'] = $state;
            if ($result !== null) {
                $job['status'] = 'done';
                $job['result'] = $result;
            }
        } catch (AgentException $e) {
            $job['status'] = 'failed';
            $job['error'] = ['code' => $e->getErrorCode(), 'message' => $e->getMessage()];
        } catch (\Throwable $e) {
            $job['status'] = 'failed';
            $job['error'] = ['code' => 'internal', 'message' => substr($e->getMessage(), 0, 500)];
        }
        $job['interrupted'] = 0;
        $job['progress'] = $h->progress($job['state']);
        $this->save($job);
        return $job;
    }

    /**
     * @param array<string, mixed> $job
     * @return array<string, mixed>
     */
    private function describe(array $job): array
    {
        $out = [
            'jobId' => $job['jobId'],
            'state' => $job['status'],
            'progress' => (object) ($job['progress'] ?? ['done' => 0]),
        ];
        if ($job['status'] === 'done') {
            $out['result'] = $job['result'];
        }
        if ($job['status'] === 'failed') {
            $out['error'] = $job['error'];
        }
        return $out;
    }

    private function handler(string $action): JobHandler
    {
        if (!isset($this->handlers[$action])) {
            throw new AgentException('unknown_action', 'not a job action');
        }
        return $this->handlers[$action];
    }

    private function file(string $id): string
    {
        return $this->ctx->data->ensure('jobs') . '/' . $id . '.php';
    }

    /** @return array<string, mixed>|null */
    private function load(string $id): ?array
    {
        $raw = DataDir::readProtected($this->file($id));
        if ($raw === null) {
            return null;
        }
        $job = json_decode($raw, true);
        return is_array($job) ? self::unwrap($job) : null;
    }

    /** @param array<string, mixed> $job */
    private function save(array $job): void
    {
        $job['updatedAt'] = $this->ctx->now();
        DataDir::writeProtected($this->file((string) $job['jobId']), Json::encode(self::wrap($job)));
    }

    /**
     * Job state can hold raw file names that are not valid UTF-8; wrap those so JSON keeps them intact.
     *
     * @param mixed $v
     * @return mixed
     */
    public static function wrap($v)
    {
        if (is_string($v)) {
            return preg_match('//u', $v) === 1 ? $v : ['__b64' => base64_encode($v)];
        }
        if (is_array($v)) {
            $out = [];
            foreach ($v as $k => $item) {
                $out[$k] = self::wrap($item);
            }
            return $out;
        }
        return $v;
    }

    /**
     * @param mixed $v
     * @return mixed
     */
    public static function unwrap($v)
    {
        if (is_array($v)) {
            if (count($v) === 1 && isset($v['__b64']) && is_string($v['__b64'])) {
                return (string) base64_decode($v['__b64'], true);
            }
            foreach ($v as $k => $item) {
                $v[$k] = self::unwrap($item);
            }
        }
        return $v;
    }

    private function gc(): void
    {
        $dir = $this->ctx->data->ensure('jobs');
        $cutoff = time() - self::RETENTION_SEC;
        foreach (glob($dir . '/*') ?: [] as $f) {
            $m = @filemtime($f);
            if ($m !== false && $m < $cutoff) {
                @unlink($f);
            }
        }
    }
}
