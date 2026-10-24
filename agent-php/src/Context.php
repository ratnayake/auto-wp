<?php

declare(strict_types=1);

namespace AutoWp\Agent;

use AutoWp\Agent\Db\Connection;
use AutoWp\Agent\Db\Connector;
use AutoWp\Agent\Fs\Binaries;
use AutoWp\Agent\Security\PathJail;

/** Everything an action needs, created once per request/process. */
final class Context
{
    public const MODE_CLI = 'cli';
    public const MODE_WEB = 'web';

    /** @var Config */
    public $config;
    /** @var PathJail */
    public $jail;
    /** @var DataDir */
    public $data;
    /** @var AuditLog */
    public $audit;
    /** @var callable(): int */
    public $clock;
    /** @var string */
    public $mode;
    /** @var Binaries */
    public $binaries;
    /** @var string Absolute path of the running agent file (for the CLI WordPress bridge). */
    public $agentFile;
    /** @var Connection|null */
    private $db;

    public function __construct(Config $config, string $mode, callable $clock, string $agentFile)
    {
        $this->config = $config;
        $this->mode = $mode;
        $this->clock = $clock;
        $this->agentFile = $agentFile;
        $this->data = new DataDir($config->dataDir);
        $this->data->ensure();
        $this->audit = new AuditLog($this->data->path('audit.log.php'), $clock);
        $this->binaries = new Binaries();
        $roots = [$config->wpRoot];
        if ($config->outsideDocrootDir !== null) {
            $roots[] = $config->outsideDocrootDir;
        }
        $forbidden = [$config->dataDir];
        // The agent's own directory is off-limits when it is a dedicated one; otherwise just the file.
        if (in_array(\AutoWp\Agent\Security\PathJail::baseName(dirname($agentFile)), ['auto-wp-agent', '.auto-wp'], true)) {
            $forbidden[] = dirname($agentFile);
        } else {
            $forbidden[] = $agentFile;
        }
        if ($config->path !== null) {
            $forbidden[] = $config->path;
        }
        $this->jail = new PathJail($config->wpRoot, $roots, $forbidden);
    }

    public function now(): int
    {
        return ($this->clock)();
    }

    public function isCli(): bool
    {
        return $this->mode === self::MODE_CLI;
    }

    /** Whether external binaries may be used for long-running work in this mode. */
    public function mayUseBinaries(): bool
    {
        return $this->config->useBinaries && $this->binaries->execEnabled()
            && ($this->isCli() || $this->config->webUseBinaries);
    }

    public function db(): Connection
    {
        if ($this->db === null) {
            $this->db = Connector::fromWpRoot($this->config->wpRoot);
        }
        return $this->db;
    }

    /** Slice budget in seconds for time-boxed jobs, kept under max_execution_time. */
    public function sliceSeconds(): float
    {
        $budget = (float) $this->config->sliceSeconds;
        $max = (int) ini_get('max_execution_time');
        if ($max > 0) {
            $budget = min($budget, max(2.0, $max * 0.6));
        }
        return $budget;
    }
}
