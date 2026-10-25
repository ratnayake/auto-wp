<?php

// Global-scope entry shared by bin/agent.php (dev) and dist/agent.php (built). WordPress must be
// required from global scope, hence this file is included rather than wrapped in a function.
if (!defined('AUTOWP_AGENT_FILE')) {
    http_response_code(404);
    exit;
}
$__autowp_bridge = \AutoWp\Agent\Agent::main(isset($argv) && is_array($argv) ? $argv : [], AUTOWP_AGENT_FILE);
if ($__autowp_bridge !== null) {
    $__autowp_bridge->prepare();
    require $__autowp_bridge->wpLoadPath();
    $__autowp_bridge->complete();
}
