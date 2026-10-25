<?php
/**
 * Plugin Name: AutoWP Breaker
 * Description: E2E fixture. v2.0.0 calls an undefined function on init, causing a fatal error.
 * Version: 2.0.0
 */
defined('ABSPATH') || exit;

add_action('init', function () {
    autowp_breaker_this_function_does_not_exist();
});
