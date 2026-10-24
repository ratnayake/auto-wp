<?php
/**
 * Plugin Name: AutoWP E2E fake updates
 * Description: Offers autowp-breaker 2.0.0 from the mock-feeds container as a plugin update.
 */
defined('ABSPATH') || exit;

const AUTOWP_E2E_BREAKER = 'autowp-breaker/autowp-breaker.php';

function autowp_e2e_offer($transient)
{
    if (!is_object($transient)) {
        $transient = new stdClass();
    }
    if (!isset($transient->response) || !is_array($transient->response)) {
        $transient->response = [];
    }
    $transient->response[AUTOWP_E2E_BREAKER] = (object) [
        'id' => 'w.org/plugins/autowp-breaker',
        'slug' => 'autowp-breaker',
        'plugin' => AUTOWP_E2E_BREAKER,
        'new_version' => '2.0.0',
        'url' => 'http://mock-feeds/',
        'package' => 'http://mock-feeds/autowp-breaker-2.0.0.zip',
        'tested' => '6.5',
        'requires_php' => '7.4',
    ];
    return $transient;
}

add_filter('pre_set_site_transient_update_plugins', 'autowp_e2e_offer');
// Also on read, so the offer survives a stored transient written while offline.
add_filter('site_transient_update_plugins', 'autowp_e2e_offer');

// Updates download from a private-network hostname; core's safe-fetch would otherwise reject it.
add_filter('http_request_host_is_external', function ($external, $host) {
    return $host === 'mock-feeds' ? true : $external;
}, 10, 2);
