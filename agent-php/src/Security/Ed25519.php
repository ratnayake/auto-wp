<?php

declare(strict_types=1);

namespace AutoWp\Agent\Security;

/**
 * Ed25519 detached-signature verification via ext-sodium, falling back to the bundled sodium_compat
 * (the build inlines it under a private class prefix so it never clashes with WordPress' own copy).
 */
final class Ed25519
{
    public static function hasExtension(): bool
    {
        return function_exists('sodium_crypto_sign_verify_detached');
    }

    public static function verify(string $signature, string $message, string $publicKey, bool $forceCompat = false): bool
    {
        if (strlen($signature) !== 64 || strlen($publicKey) !== 32) {
            return false;
        }
        try {
            if (!$forceCompat && self::hasExtension()) {
                return sodium_crypto_sign_verify_detached($signature, $message, $publicKey);
            }
            if (!class_exists('ParagonIE_Sodium_Core_Ed25519')) {
                return false;
            }
            return \ParagonIE_Sodium_Core_Ed25519::verify_detached($signature, $message, $publicKey);
        } catch (\Throwable $e) {
            return false;
        }
    }
}
