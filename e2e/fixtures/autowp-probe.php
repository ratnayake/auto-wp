<?php
header('Content-Type: application/json');
echo json_encode([
    'exec' => function_exists('exec'),
    'shell_exec' => function_exists('shell_exec'),
    'proc_open' => function_exists('proc_open'),
    'disable_functions' => ini_get('disable_functions'),
    'max_execution_time' => ini_get('max_execution_time'),
]);
