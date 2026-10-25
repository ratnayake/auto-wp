<?php

declare(strict_types=1);

namespace AutoWp\Agent;

/**
 * Minimal strict parameter validation mirroring the zod schemas in packages/contracts/src/actions.ts.
 * Unknown keys are rejected. Spec entries: ['type' => string|int|bool|enum|strings, 'default' => ...,
 * 'optional' => bool, 'min' => int, 'max' => int, 'minLen' => int, 'maxLen' => int, 'pattern' => regex,
 * 'values' => [...], 'maxItems' => int].
 */
final class Params
{
    public const SLUG_PATTERN = '/^[a-z0-9_.-]+$/iD';

    /**
     * @param array<string|int, mixed> $input
     * @param array<string, array<string, mixed>> $spec
     * @return array<string, mixed>
     */
    public static function validate(array $input, array $spec): array
    {
        if (!Json::isObjectLike($input)) {
            throw AgentException::invalidParams('params must be an object');
        }
        foreach (array_keys($input) as $k) {
            if (!isset($spec[$k])) {
                throw AgentException::invalidParams('unknown parameter: ' . self::safe((string) $k));
            }
        }
        $out = [];
        foreach ($spec as $name => $rule) {
            if (!array_key_exists($name, $input)) {
                if (array_key_exists('default', $rule)) {
                    $out[$name] = $rule['default'];
                    continue;
                }
                if (!empty($rule['optional'])) {
                    $out[$name] = null;
                    continue;
                }
                throw AgentException::invalidParams('missing parameter: ' . $name);
            }
            $out[$name] = self::check($name, $input[$name], $rule);
        }
        return $out;
    }

    /**
     * @param mixed $v
     * @param array<string, mixed> $rule
     * @return mixed
     */
    private static function check(string $name, $v, array $rule)
    {
        $type = $rule['type'];
        if ($v === null && !empty($rule['optional'])) {
            return null;
        }
        switch ($type) {
            case 'string':
            case 'path':
                if (!is_string($v)) {
                    throw AgentException::invalidParams($name . ' must be a string');
                }
                $min = $rule['minLen'] ?? ($type === 'path' ? 1 : 0);
                $max = $rule['maxLen'] ?? ($type === 'path' ? 4096 : 65536);
                $len = function_exists('mb_strlen') ? mb_strlen($v, 'UTF-8') : strlen($v);
                if ($len < $min || $len > $max) {
                    throw AgentException::invalidParams($name . ' has an invalid length');
                }
                if ($type === 'path' && strpos($v, "\0") !== false) {
                    throw AgentException::jail('invalid path');
                }
                if (isset($rule['pattern']) && preg_match($rule['pattern'], $v) !== 1) {
                    throw AgentException::invalidParams($name . ' has an invalid format');
                }
                return $v;
            case 'int':
                if (!is_int($v)) {
                    throw AgentException::invalidParams($name . ' must be an integer');
                }
                if (isset($rule['min']) && $v < $rule['min']) {
                    throw AgentException::invalidParams($name . ' is too small');
                }
                if (isset($rule['max']) && $v > $rule['max']) {
                    throw AgentException::invalidParams($name . ' is too large');
                }
                return $v;
            case 'bool':
                if (!is_bool($v)) {
                    throw AgentException::invalidParams($name . ' must be a boolean');
                }
                return $v;
            case 'enum':
                if (!is_string($v) || !in_array($v, $rule['values'], true)) {
                    throw AgentException::invalidParams($name . ' has an invalid value');
                }
                return $v;
            case 'strings':
            case 'paths':
                if (!is_array($v) || !Json::isList($v)) {
                    throw AgentException::invalidParams($name . ' must be an array');
                }
                if (count($v) > ($rule['maxItems'] ?? 10000)) {
                    throw AgentException::invalidParams($name . ' has too many items');
                }
                $itemRule = ['type' => $type === 'paths' ? 'path' : 'string', 'maxLen' => 4096];
                $items = [];
                foreach ($v as $item) {
                    $items[] = self::check($name . '[]', $item, $itemRule);
                }
                return $items;
        }
        throw AgentException::internal('bad parameter spec');
    }

    private static function safe(string $s): string
    {
        return substr((string) preg_replace('/[^A-Za-z0-9_.-]/', '?', $s), 0, 64);
    }
}
