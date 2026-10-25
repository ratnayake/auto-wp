<?php

declare(strict_types=1);

namespace AutoWp\Agent;

final class Json
{
    public static function encode($value): string
    {
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
            | JSON_PRESERVE_ZERO_FRACTION;
        $out = json_encode($value, $flags);
        if ($out === false) {
            throw AgentException::internal('could not encode JSON: ' . json_last_error_msg());
        }
        return $out;
    }

    /**
     * Decodes a JSON object into an associative array. `{}` and `[]` both decode to [].
     *
     * @return array<string|int, mixed>
     */
    public static function decodeObject(string $json, string $what = 'JSON'): array
    {
        $value = json_decode($json, true, 64);
        if (!is_array($value)) {
            throw new AgentException('bad_request', $what . ' must be a JSON object');
        }
        return $value;
    }

    /**
     * True when the array is a JSON object (string keys) or empty.
     *
     * @param array<mixed> $a
     */
    public static function isObjectLike(array $a): bool
    {
        if ($a === []) {
            return true;
        }
        foreach (array_keys($a) as $k) {
            if (!is_string($k)) {
                return false;
            }
        }
        return true;
    }

    /**
     * @param array<mixed> $a
     */
    public static function isList(array $a): bool
    {
        return $a === [] || array_keys($a) === range(0, count($a) - 1);
    }
}
