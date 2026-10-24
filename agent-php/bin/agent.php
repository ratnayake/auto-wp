<?php

// Development entry point (uses Composer's autoloader). The deployable artefact is dist/agent.php.
declare(strict_types=1);

define('AUTOWP_AGENT_FILE', __FILE__);
require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../src/main.php';
