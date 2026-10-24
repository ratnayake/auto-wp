<?php

declare(strict_types=1);

namespace AutoWp\Agent\Wp;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Json;

/**
 * A request to run a bridge action inside WordPress, in this process. wp-load.php has to be required
 * from global scope (wp-config.php defines globals such as $table_prefix), so the entry script does:
 *
 *     $r->prepare(); require $r->wpLoadPath(); $r->complete();
 *
 * prepare() installs a shutdown guard: if WordPress dies (fatal error, exit, wp_die) before complete()
 * ran, the guard discards WordPress' output and answers `wp_fatal` instead.
 */
final class BridgeRequest
{
    public const MARKER = "\n@@AUTOWP-BRIDGE-RESULT@@";

    /** @var string */
    private $action;
    /** @var array<string, mixed> */
    private $params;
    /** @var string */
    private $wpRoot;
    /** @var bool true = HTTP response, false = marker line on stdout (CLI child) */
    private $web;
    /** @var string|null */
    private $siteHost;
    /** @var string[] */
    private $flushed;
    /** @var bool */
    private $completed = false;
    /** @var int */
    private $obLevel = 0;

    /**
     * @param array<string, mixed> $params
     * @param string[] $flushed already-flushed caches (cache.flush)
     */
    public function __construct(string $action, array $params, string $wpRoot, bool $web, ?string $siteHost = null, array $flushed = [])
    {
        $this->action = $action;
        $this->params = $params;
        $this->wpRoot = $wpRoot;
        $this->web = $web;
        $this->siteHost = $siteHost;
        $this->flushed = $flushed;
    }

    public function wpLoadPath(): string
    {
        $p = $this->wpRoot . '/wp-load.php';
        if (!is_file($p)) {
            $this->respond(['ok' => false, 'error' => ['code' => 'wp_fatal', 'message' => 'wp-load.php not found']]);
            exit(0);
        }
        return $p;
    }

    public function prepare(): void
    {
        if (!$this->web) {
            $host = $this->siteHost ?? 'localhost';
            $_SERVER['HTTP_HOST'] = $_SERVER['HTTP_HOST'] ?? $host;
            $_SERVER['SERVER_NAME'] = $_SERVER['SERVER_NAME'] ?? $host;
            $_SERVER['REQUEST_URI'] = $_SERVER['REQUEST_URI'] ?? '/';
            $_SERVER['REQUEST_METHOD'] = $_SERVER['REQUEST_METHOD'] ?? 'GET';
            $_SERVER['SERVER_PROTOCOL'] = $_SERVER['SERVER_PROTOCOL'] ?? 'HTTP/1.1';
            $_SERVER['REMOTE_ADDR'] = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
        }
        // Pre-initialised hooks (WP_Hook::build_preinitialized_hooks): never let our own .maintenance
        // lock us out, and use direct filesystem access for upgrades.
        $GLOBALS['wp_filter']['enable_maintenance_mode'][1][] = [
            'function' => static function () {
                return false;
            },
            'accepted_args' => 1,
        ];
        $GLOBALS['wp_filter']['filesystem_method'][1000][] = [
            'function' => static function () {
                return 'direct';
            },
            'accepted_args' => 1,
        ];
        @set_time_limit($this->web ? 300 : 0);
        register_shutdown_function([$this, 'shutdownGuard']);
        $this->obLevel = ob_get_level();
        ob_start();
    }

    public function complete(): void
    {
        try {
            $ops = new WpOps();
            switch ($this->action) {
                case 'wp.inventory':
                    $result = $ops->inventory((bool) $this->params['refresh']);
                    break;
                case 'wp.upgrade':
                    $result = $ops->upgrade((string) $this->params['type'], (string) $this->params['slug'], $this->params['version'] ?? null);
                    break;
                case 'cache.flush':
                    $result = ['flushed' => array_merge($this->flushed, $ops->flushObjectCache())];
                    break;
                default:
                    throw new AgentException('unknown_action', 'not a bridge action');
            }
            $env = ['ok' => true, 'result' => $result];
        } catch (AgentException $e) {
            $env = ['ok' => false, 'error' => ['code' => $e->getErrorCode(), 'message' => $e->getMessage()]];
        } catch (\Throwable $e) {
            $env = ['ok' => false, 'error' => ['code' => 'wp_fatal', 'message' => substr(get_class($e) . ': ' . $e->getMessage(), 0, 500)]];
        }
        $this->completed = true;
        $this->respond($env);
        exit(0);
    }

    public function shutdownGuard(): void
    {
        if ($this->completed) {
            return;
        }
        $this->completed = true;
        $err = error_get_last();
        $fatal = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR;
        if ($err !== null && ($err['type'] & $fatal) !== 0) {
            $msg = 'WordPress fatal error: ' . $err['message'] . ' in ' . basename((string) $err['file']) . ':' . $err['line'];
        } else {
            $output = '';
            while (ob_get_level() > $this->obLevel) {
                $output = (string) ob_get_clean() . $output;
            }
            $text = trim((string) preg_replace('/\s+/', ' ', strip_tags($output)));
            $msg = 'WordPress exited during bootstrap' . ($text !== '' ? ': ' . substr($text, 0, 300) : '');
        }
        if ($this->action === 'cache.flush') {
            // A broken WordPress must not turn a cache flush into an error: report what was flushed.
            $this->respond(['ok' => true, 'result' => ['flushed' => $this->flushed]]);
        } else {
            $this->respond(['ok' => false, 'error' => ['code' => 'wp_fatal', 'message' => substr($msg, 0, 800)]]);
        }
        // exit() inside a shutdown function skips the remaining ones (e.g. WordPress' own fatal handler,
        // which would append an HTML error page).
        exit(0);
    }

    /** @param array<string, mixed> $env */
    private function respond(array $env): void
    {
        while (ob_get_level() > $this->obLevel) {
            ob_end_clean();
        }
        $json = Json::encode($env);
        if ($this->web) {
            if (!headers_sent()) {
                header_remove();
                // After a fatal error PHP has already chosen 500; an explicit status line overrides it.
                $proto = (string) ($_SERVER['SERVER_PROTOCOL'] ?? '');
                if (preg_match('#^HTTP/[0-9.]+$#D', $proto) !== 1) {
                    $proto = 'HTTP/1.1';
                }
                header($proto . ' 200 OK', true, 200);
                header('Content-Type: application/json; charset=utf-8');
                header('Cache-Control: no-store');
                header('X-Content-Type-Options: nosniff');
            }
            echo $json;
        } else {
            echo self::MARKER . $json . "\n";
        }
        // Push the answer out, then swallow anything WordPress' shutdown hooks might still print.
        flush();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        }
        ob_start(static function (): string {
            return '';
        });
    }

    /**
     * Extracts the envelope from a bridge child's stdout.
     *
     * @return array<string, mixed>|null
     */
    public static function parseChildOutput(string $stdout): ?array
    {
        $pos = strrpos($stdout, self::MARKER);
        if ($pos === false) {
            return null;
        }
        $rest = substr($stdout, $pos + strlen(self::MARKER));
        $nl = strpos($rest, "\n");
        $json = trim($nl === false ? $rest : substr($rest, 0, $nl));
        $env = json_decode($json, true);
        return is_array($env) && isset($env['ok']) ? $env : null;
    }
}
