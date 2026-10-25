<?php

declare(strict_types=1);

namespace AutoWp\Agent;

use AutoWp\Agent\Actions\Registry;
use AutoWp\Agent\Jobs\JobRunner;
use AutoWp\Agent\Security\AuthFailure;
use AutoWp\Agent\Security\NonceStore;
use AutoWp\Agent\Security\RequestVerifier;
use AutoWp\Agent\Wp\Bridge;
use AutoWp\Agent\Wp\BridgeRequest;

/**
 * Entry point and dispatcher. See docs/agent-protocol.md.
 */
final class Agent
{
    public const VERSION = '1.0.0';

    /** @var Context */
    private $ctx;

    public function __construct(Context $ctx)
    {
        $this->ctx = $ctx;
    }

    /**
     * Entry used by bin/agent.php and dist/agent.php. Returns a BridgeRequest when WordPress has to be
     * loaded from global scope; null when the response has been sent.
     *
     * @param string[] $argv
     */
    public static function main(array $argv, string $agentFile): ?BridgeRequest
    {
        if (PHP_SAPI === 'cli' || PHP_SAPI === 'phpdbg') {
            return Cli::main($argv, $agentFile);
        }
        return self::webMain($agentFile);
    }

    private static function webMain(string $agentFile): ?BridgeRequest
    {
        $configPath = dirname($agentFile) . '/config.php';
        try {
            $config = Config::load($configPath);
            $ctx = new Context($config, Context::MODE_WEB, 'time', $agentFile);
        } catch (\Throwable $e) {
            self::notFound();
            return null;
        }
        $agent = new self($ctx);
        $server = $_SERVER;
        $body = self::readBody($config->maxBodyBytes);
        $out = $agent->handleWeb($server, $body);
        if ($out instanceof BridgeRequest) {
            return $out;
        }
        [$status, $json] = $out;
        if ($status === 404) {
            self::notFound();
            return null;
        }
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        echo $json;
        return null;
    }

    private static function notFound(): void
    {
        if (!headers_sent()) {
            http_response_code(404);
            header('Content-Type: text/plain');
            header('Content-Length: 0');
        }
    }

    /** The raw body, or null when it exceeds $max (the request then fails verification step 2). */
    private static function readBody(int $max): ?string
    {
        $len = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
        if ($len > $max) {
            return null;
        }
        $fh = @fopen('php://input', 'rb');
        if ($fh === false) {
            return '';
        }
        $body = (string) stream_get_contents($fh, $max + 1);
        fclose($fh);
        return strlen($body) > $max ? null : $body;
    }

    /**
     * Verifies and handles one web request.
     *
     * @param array<string, mixed> $server $_SERVER-like array
     * @param string|null $body null when the body exceeded the size cap
     * @return array{0: int, 1: string}|BridgeRequest [HTTP status, body]; 404 means "empty 404"
     */
    public function handleWeb(array $server, ?string $body)
    {
        $headers = [];
        foreach ($server as $k => $v) {
            if (is_string($k) && strncmp($k, 'HTTP_X_AUTOWP_', 14) === 0 && is_string($v)) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = $v;
            }
        }
        $method = strtoupper((string) ($server['REQUEST_METHOD'] ?? 'GET'));
        $path = (string) parse_url((string) ($server['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        $ip = (string) ($server['REMOTE_ADDR'] ?? '');
        $verifier = new RequestVerifier(
            $this->ctx->config,
            new NonceStore($this->ctx->data->path('nonces.php')),
            $this->ctx->clock
        );
        try {
            if (!$this->isHttps($server)) {
                throw new AuthFailure('insecure_transport');
            }
            if ($body === null) {
                throw new AuthFailure('body_too_large');
            }
            $keyId = $verifier->verify($method, $path, $headers, $body, $ip);
        } catch (AuthFailure $e) {
            $this->ctx->authAudit()->recordThrottled('auth_failed', $ip . '|' . $e->getReason(), ['ip' => substr($ip, 0, 64), 'reason' => $e->getReason()]);
            return [404, ''];
        }

        $start = microtime(true);
        $action = '';
        try {
            $req = Json::decodeObject($body, 'request body');
            $action = is_string($req['action'] ?? null) ? $req['action'] : '';
            $params = $req['params'] ?? [];
            if (!is_array($params)) {
                throw new AgentException('bad_request', 'params must be an object');
            }
            $result = $this->dispatch($action, $params);
            if ($result instanceof BridgeRequest) {
                $this->ctx->audit->record('request', ['ip' => $ip, 'keyId' => $keyId, 'action' => $action, 'outcome' => 'bridge']);
                return $result;
            }
            $env = ['ok' => true] + $result;
        } catch (AgentException $e) {
            $env = ['ok' => false, 'error' => ['code' => $e->getErrorCode(), 'message' => $e->getMessage()]];
        } catch (\Throwable $e) {
            $env = ['ok' => false, 'error' => ['code' => 'internal', 'message' => self::safeMessage($e)]];
        }
        $this->ctx->audit->record('request', [
            'ip' => $ip,
            'keyId' => $keyId,
            'action' => substr($action, 0, 64),
            'outcome' => $env['ok'] ? 'ok' : $env['error']['code'],
            'ms' => (int) round((microtime(true) - $start) * 1000),
        ]);
        return [200, Json::encode($env)];
    }

    /**
     * Validates and runs one action. Shared by web and CLI mode.
     *
     * @param array<string|int, mixed> $rawParams
     * @return array{result: mixed}|array{job: array{jobId: string}}|BridgeRequest
     */
    public function dispatch(string $action, array $rawParams)
    {
        $specs = Registry::specs();
        if (!isset($specs[$action])) {
            throw new AgentException('unknown_action', 'unknown action');
        }
        $params = Params::validate($rawParams, $specs[$action]);

        set_error_handler(static function (int $no, string $str, string $file = '', int $line = 0): bool {
            if ((error_reporting() & $no) === 0) {
                return false;
            }
            throw new \ErrorException($str, 0, $no, $file, $line);
        }, E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
        try {
            return $this->run($action, $params);
        } finally {
            restore_error_handler();
        }
    }

    /**
     * @param array<string, mixed> $params
     * @return array{result: mixed}|array{job: array{jobId: string}}|BridgeRequest
     */
    private function run(string $action, array $params)
    {
        if (in_array($action, Registry::JOB_ACTIONS, true)) {
            return (new JobRunner($this->ctx, Registry::jobs()))->start($action, $params);
        }
        if ($action === 'job.status') {
            return ['result' => (new JobRunner($this->ctx, Registry::jobs()))->status((string) $params['jobId'])];
        }
        if (in_array($action, Registry::BRIDGE_ACTIONS, true)) {
            return self::bridgeResult(Bridge::run($this->ctx, $action, $params));
        }
        if ($action === 'cache.flush') {
            $flushed = [];
            if ($params['opcache'] && function_exists('opcache_reset') && @opcache_reset()) {
                $flushed[] = $this->ctx->isCli() ? 'opcache:cli' : 'opcache';
            }
            if (!$params['objectCache']) {
                return ['result' => ['flushed' => $flushed]];
            }
            $r = Bridge::run($this->ctx, 'cache.flush', [], $flushed);
            if ($r instanceof BridgeRequest) {
                return $r;
            }
            // A broken WordPress must not turn a cache flush into an error: report what was flushed.
            return ['result' => ['flushed' => $r['ok'] ? ($r['result']['flushed'] ?? $flushed) : $flushed]];
        }
        $sync = Registry::sync();
        return ['result' => call_user_func($sync[$action], $params, $this->ctx)];
    }

    /**
     * @param array<string, mixed>|BridgeRequest $r
     * @return array{result: mixed}|BridgeRequest
     */
    private static function bridgeResult($r)
    {
        if ($r instanceof BridgeRequest) {
            return $r;
        }
        if (!empty($r['ok'])) {
            return ['result' => $r['result'] ?? null];
        }
        $err = is_array($r['error'] ?? null) ? $r['error'] : [];
        throw new AgentException((string) ($err['code'] ?? 'wp_fatal'), (string) ($err['message'] ?? 'WordPress bridge failed'));
    }

    /** @param array<string, mixed> $server */
    private function isHttps(array $server): bool
    {
        $cfg = $this->ctx->config;
        if ($cfg->allowInsecureHttp) {
            return true;
        }
        $https = strtolower((string) ($server['HTTPS'] ?? ''));
        if ($https !== '' && $https !== 'off') {
            return true;
        }
        if ((string) ($server['REQUEST_SCHEME'] ?? '') === 'https') {
            return true;
        }
        return $cfg->trustForwardedProto && strtolower((string) ($server['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    }

    public static function safeMessage(\Throwable $e): string
    {
        return substr($e->getMessage(), 0, 500);
    }

    public function context(): Context
    {
        return $this->ctx;
    }
}
