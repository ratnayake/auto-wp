<?php
// Stub of the real agent: answers `probe` only, per docs/agent-protocol.md (CLI mode).
$action = $argv[2] ?? '';
$params = json_decode(stream_get_contents(STDIN), true);
if ($action === 'probe') {
    echo json_encode(['ok' => true, 'result' => [
        'shell' => false,
        'execEnabled' => true,
        'phpVersion' => PHP_VERSION,
        'phpCli' => PHP_BINARY,
        'wpCli' => ['available' => false],
        'binaries' => new stdClass(),
        'sodium' => extension_loaded('sodium'),
        'docroot' => '/home/tester/wp',
        'wpRoot' => '/home/tester/wp',
        'outsideDocrootDir' => '/home/tester/outside',
    ]]);
    exit(0);
}
echo json_encode(['ok' => false, 'error' => ['code' => 'unknown_action', 'message' => $action]]);
exit(1);
