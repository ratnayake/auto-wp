<?php

declare(strict_types=1);

namespace AutoWp\Agent\Wp;

use AutoWp\Agent\AgentException;
use AutoWp\Agent\Params;

/**
 * Operations that run inside a bootstrapped WordPress (see BridgeRequest). Only WordPress APIs are used.
 *
 * @phpstan-ignore-next-line WordPress functions are not known statically.
 */
final class WpOps
{
    /** @return array<string, mixed> WpInventory */
    public function inventory(bool $refresh): array
    {
        $this->loadAdmin(false);
        if ($refresh) {
            $this->forceUpdateChecks();
        }
        global $wp_version, $wpdb;

        $core = ['version' => (string) $wp_version, 'locale' => (string) get_locale()];
        $coreUpdate = $this->coreUpdate(null);
        if ($coreUpdate !== null) {
            $core['update'] = $this->coreUpdateInfo($coreUpdate);
        }

        $pluginUpdates = get_site_transient('update_plugins');
        $plugins = [];
        foreach (get_plugins() as $file => $data) {
            $slug = self::pluginSlug((string) $file);
            if (!self::validSlug($slug)) {
                continue; // contracts require a conservative slug alphabet
            }
            $p = [
                'slug' => $slug,
                'file' => (string) $file,
                'name' => (string) ($data['Name'] ?? $slug),
                'version' => (string) ($data['Version'] ?? ''),
                'active' => is_plugin_active($file),
                'networkActive' => is_multisite() && is_plugin_active_for_network($file),
                'requiresPlugins' => self::csv((string) ($data['RequiresPlugins'] ?? '')),
            ];
            if (isset($data['UpdateURI']) && $data['UpdateURI'] !== '') {
                $p['updateUri'] = (string) $data['UpdateURI'];
            }
            $u = is_object($pluginUpdates) && isset($pluginUpdates->response[$file]) ? $pluginUpdates->response[$file] : null;
            if (is_object($u) && isset($u->new_version)) {
                $p['update'] = self::updateInfo((array) $u);
            }
            $plugins[] = $p;
        }

        $themeUpdates = get_site_transient('update_themes');
        $active = get_stylesheet();
        $themes = [];
        foreach (wp_get_themes() as $stylesheet => $theme) {
            $stylesheet = (string) $stylesheet;
            if (!self::validSlug($stylesheet)) {
                continue;
            }
            $t = [
                'slug' => $stylesheet,
                'name' => (string) $theme->get('Name'),
                'version' => (string) $theme->get('Version'),
                'active' => $stylesheet === $active,
            ];
            $template = (string) $theme->get_template();
            if ($template !== '' && $template !== $stylesheet) {
                $t['parent'] = $template;
            }
            $u = is_object($themeUpdates) && isset($themeUpdates->response[$stylesheet]) ? $themeUpdates->response[$stylesheet] : null;
            if (is_array($u) && isset($u['new_version'])) {
                $t['update'] = self::updateInfo($u);
            }
            $themes[] = $t;
        }

        $mu = [];
        foreach (get_mu_plugins() as $file => $data) {
            $m = ['file' => (string) $file, 'name' => (string) ($data['Name'] ?? $file)];
            if (!empty($data['Version'])) {
                $m['version'] = (string) $data['Version'];
            }
            $mu[] = $m;
        }

        $db = '';
        if (isset($wpdb) && is_object($wpdb)) {
            $db = method_exists($wpdb, 'db_server_info') ? (string) $wpdb->db_server_info() : (string) $wpdb->db_version();
        }
        return [
            'core' => $core,
            'plugins' => $plugins,
            'themes' => $themes,
            'mustUse' => $mu,
            'php' => PHP_VERSION,
            'db' => $db,
        ];
    }

    /**
     * @return array{fromVersion: string, toVersion: string, messages: string[]}
     */
    public function upgrade(string $type, string $slug, ?string $version): array
    {
        if (!self::validSlug($slug)) {
            throw AgentException::invalidParams('invalid slug');
        }
        $this->loadAdmin(true);
        $skin = new \Automatic_Upgrader_Skin();
        switch ($type) {
            case 'plugin':
                return $this->upgradePlugin($skin, $slug, $version);
            case 'theme':
                return $this->upgradeTheme($skin, $slug, $version);
            case 'core':
                return $this->upgradeCore($skin, $version);
        }
        throw AgentException::invalidParams('invalid type');
    }

    /** @return string[] */
    public function flushObjectCache(): array
    {
        $out = [];
        if (function_exists('wp_cache_flush') && wp_cache_flush()) {
            $out[] = 'objectCache';
        }
        return $out;
    }

    /**
     * @return array{fromVersion: string, toVersion: string, messages: string[]}
     */
    private function upgradePlugin(\Automatic_Upgrader_Skin $skin, string $slug, ?string $version): array
    {
        wp_update_plugins();
        $file = null;
        foreach (get_plugins() as $f => $data) {
            if (self::pluginSlug((string) $f) === $slug) {
                $file = (string) $f;
                break;
            }
        }
        if ($file === null) {
            throw AgentException::notFound('plugin not installed');
        }
        $from = (string) (get_plugins()[$file]['Version'] ?? '');
        $t = get_site_transient('update_plugins');
        $info = is_object($t) && isset($t->response[$file]) ? $t->response[$file] : null;
        $available = is_object($info) ? (string) ($info->new_version ?? '') : '';
        if ($version !== null && $version === $from) {
            return ['fromVersion' => $from, 'toVersion' => $from, 'messages' => ['already at the requested version']];
        }
        $upgrader = new \Plugin_Upgrader($skin);
        // Behave like WordPress background updates: the plugin stays active (no silent deactivation),
        // and active plugins get maintenance mode while their files are replaced.
        $cron = static function () {
            return true;
        };
        add_filter('wp_doing_cron', $cron);
        try {
            if ($version !== null && $version !== $available) {
                $result = $upgrader->install(
                    'https://downloads.wordpress.org/plugin/' . rawurlencode($slug) . '.' . rawurlencode($version) . '.zip',
                    ['overwrite_package' => true]
                );
            } elseif ($available === '') {
                return ['fromVersion' => $from, 'toVersion' => $from, 'messages' => ['no update available']];
            } else {
                $result = $upgrader->upgrade($file);
            }
        } finally {
            remove_filter('wp_doing_cron', $cron);
        }
        $this->assertSuccess($result, $skin);
        wp_clean_plugins_cache(true);
        $data = get_plugin_data(WP_PLUGIN_DIR . '/' . $file, false, false);
        return ['fromVersion' => $from, 'toVersion' => (string) ($data['Version'] ?? ''), 'messages' => self::messages($skin)];
    }

    /**
     * @return array{fromVersion: string, toVersion: string, messages: string[]}
     */
    private function upgradeTheme(\Automatic_Upgrader_Skin $skin, string $slug, ?string $version): array
    {
        wp_update_themes();
        $theme = wp_get_theme($slug);
        if (!$theme->exists()) {
            throw AgentException::notFound('theme not installed');
        }
        $from = (string) $theme->get('Version');
        $t = get_site_transient('update_themes');
        $info = is_object($t) && isset($t->response[$slug]) ? $t->response[$slug] : null;
        $available = is_array($info) ? (string) ($info['new_version'] ?? '') : '';
        if ($version !== null && $version === $from) {
            return ['fromVersion' => $from, 'toVersion' => $from, 'messages' => ['already at the requested version']];
        }
        $upgrader = new \Theme_Upgrader($skin);
        if ($version !== null && $version !== $available) {
            $result = $upgrader->install(
                'https://downloads.wordpress.org/theme/' . rawurlencode($slug) . '.' . rawurlencode($version) . '.zip',
                ['overwrite_package' => true]
            );
        } elseif ($available === '') {
            return ['fromVersion' => $from, 'toVersion' => $from, 'messages' => ['no update available']];
        } else {
            $result = $upgrader->upgrade($slug);
        }
        $this->assertSuccess($result, $skin);
        wp_clean_themes_cache(true);
        $style = get_theme_root($slug) . '/' . $slug . '/style.css';
        $hdr = get_file_data($style, ['Version' => 'Version']);
        return ['fromVersion' => $from, 'toVersion' => (string) ($hdr['Version'] ?? ''), 'messages' => self::messages($skin)];
    }

    /**
     * @return array{fromVersion: string, toVersion: string, messages: string[]}
     */
    private function upgradeCore(\Automatic_Upgrader_Skin $skin, ?string $version): array
    {
        global $wp_version;
        $from = (string) $wp_version;
        if ($version !== null && $version === $from) {
            return ['fromVersion' => $from, 'toVersion' => $from, 'messages' => ['already at the requested version']];
        }
        wp_version_check([], true);
        $update = $this->coreUpdate($version);
        if ($update === null) {
            if ($version !== null) {
                throw AgentException::notFound('requested core version is not offered by the update API');
            }
            return ['fromVersion' => $from, 'toVersion' => $from, 'messages' => ['no update available']];
        }
        $upgrader = new \Core_Upgrader($skin);
        $result = $upgrader->upgrade($update);
        $this->assertSuccess($result, $skin);
        return ['fromVersion' => $from, 'toVersion' => self::installedCoreVersion(), 'messages' => self::messages($skin)];
    }

    /** Reads $wp_version from wp-includes/version.php without including it again. */
    private static function installedCoreVersion(): string
    {
        $src = @file_get_contents(ABSPATH . WPINC . '/version.php');
        if (is_string($src) && preg_match('/\$wp_version\s*=\s*[\'"]([^\'"]+)[\'"]/', $src, $m) === 1) {
            return $m[1];
        }
        return '';
    }

    /** @return object|null */
    private function coreUpdate(?string $version)
    {
        if (!function_exists('get_core_updates')) {
            return null;
        }
        $updates = get_core_updates(['dismissed' => true]);
        if (!is_array($updates)) {
            return null;
        }
        foreach ($updates as $u) {
            if (!is_object($u) || !isset($u->response)) {
                continue;
            }
            if ($version !== null) {
                if ((string) ($u->current ?? '') === $version && in_array($u->response, ['upgrade', 'latest', 'autoupdate'], true)) {
                    return $u;
                }
                continue;
            }
            if ($u->response === 'upgrade') {
                return $u;
            }
        }
        return null;
    }

    /**
     * @param object $u
     * @return array<string, string>
     */
    private function coreUpdateInfo($u): array
    {
        $info = ['version' => (string) ($u->current ?? '')];
        if (!empty($u->php_version)) {
            $info['requiresPhp'] = (string) $u->php_version;
        }
        $pkg = $u->packages->full ?? ($u->download ?? '');
        if (is_string($pkg) && $pkg !== '') {
            $info['package'] = $pkg;
        }
        return $info;
    }

    /**
     * @param array<string, mixed> $u
     * @return array<string, string>
     */
    private static function updateInfo(array $u): array
    {
        $info = ['version' => (string) $u['new_version']];
        if (!empty($u['requires']) && is_scalar($u['requires'])) {
            $info['requiresWp'] = (string) $u['requires'];
        }
        if (!empty($u['requires_php']) && is_scalar($u['requires_php'])) {
            $info['requiresPhp'] = (string) $u['requires_php'];
        }
        if (!empty($u['package']) && is_string($u['package'])) {
            $info['package'] = $u['package'];
        }
        return $info;
    }

    /** Makes the next wp_update_*() calls hit the API regardless of their cache timeouts. */
    private function forceUpdateChecks(): void
    {
        foreach (['update_plugins', 'update_themes'] as $name) {
            $t = get_site_transient($name);
            if (is_object($t)) {
                $t->last_checked = 0;
                set_site_transient($name, $t);
            }
        }
        wp_version_check([], true);
        wp_update_plugins();
        wp_update_themes();
    }

    private function loadAdmin(bool $upgrader): void
    {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/update.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        if ($upgrader) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
            require_once ABSPATH . 'wp-admin/includes/misc.php';
            require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        }
    }

    /**
     * @param mixed $result
     */
    private function assertSuccess($result, \Automatic_Upgrader_Skin $skin): void
    {
        if (is_wp_error($result)) {
            throw AgentException::internal('upgrade failed: ' . $result->get_error_message());
        }
        if (isset($skin->result) && is_wp_error($skin->result)) {
            throw AgentException::internal('upgrade failed: ' . $skin->result->get_error_message());
        }
        if ($result === false || $result === null) {
            $msgs = self::messages($skin);
            throw AgentException::internal('upgrade failed' . ($msgs !== [] ? ': ' . implode(' | ', array_slice($msgs, -3)) : ''));
        }
    }

    /** @return string[] */
    private static function messages(\Automatic_Upgrader_Skin $skin): array
    {
        $out = [];
        foreach ((array) $skin->get_upgrade_messages() as $m) {
            $t = trim(html_entity_decode(strip_tags((string) $m), ENT_QUOTES));
            if ($t !== '') {
                $out[] = substr($t, 0, 500);
            }
        }
        return $out;
    }

    public static function pluginSlug(string $file): string
    {
        $dir = dirname($file);
        return $dir === '.' ? basename($file, '.php') : $dir;
    }

    public static function validSlug(string $slug): bool
    {
        return $slug !== '.' && $slug !== '..' && preg_match(Params::SLUG_PATTERN, $slug) === 1;
    }

    /** @return string[] */
    private static function csv(string $s): array
    {
        $out = [];
        foreach (explode(',', $s) as $part) {
            $part = trim($part);
            if ($part !== '') {
                $out[] = $part;
            }
        }
        return $out;
    }
}
