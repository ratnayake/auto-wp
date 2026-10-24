<?php

declare(strict_types=1);

namespace AutoWp\Agent\Jobs;

use AutoWp\Agent\Context;

/**
 * A long-running action split into time-boxed slices. All state must be JSON-serialisable: it is
 * persisted between slices (and between HTTP requests in web mode).
 */
interface JobHandler
{
    /**
     * Validates (already schema-checked) params, resolves paths and returns the initial state.
     *
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    public function init(array $params, Context $ctx): array;

    /**
     * Advances the job until $deadline (microtime(true)) or completion.
     *
     * @param array<string, mixed> $state updated in place
     * @return array<string, mixed>|object|null the action result when finished, null otherwise
     */
    public function step(array &$state, Context $ctx, float $deadline);

    /**
     * @param array<string, mixed> $state
     * @return array{done: int|float, total?: int|float, message?: string}
     */
    public function progress(array $state): array;
}
