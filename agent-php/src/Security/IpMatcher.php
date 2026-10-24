<?php

declare(strict_types=1);

namespace AutoWp\Agent\Security;

/** Matches an IP address against exact addresses and CIDR ranges (IPv4 and IPv6). */
final class IpMatcher
{
    /**
     * @param string[] $allow
     */
    public static function matches(string $ip, array $allow): bool
    {
        $addr = @inet_pton($ip);
        if ($addr === false) {
            return false;
        }
        foreach ($allow as $rule) {
            $rule = trim($rule);
            $bits = null;
            if (strpos($rule, '/') !== false) {
                [$net, $len] = explode('/', $rule, 2);
                if (!ctype_digit($len)) {
                    continue;
                }
                $bits = (int) $len;
            } else {
                $net = $rule;
            }
            $netBin = @inet_pton($net);
            if ($netBin === false || strlen($netBin) !== strlen($addr)) {
                // Allow an IPv4 rule to match an IPv4-mapped IPv6 address.
                if ($netBin !== false && strlen($netBin) === 4 && strlen($addr) === 16
                    && substr($addr, 0, 12) === str_repeat("\0", 10) . "\xff\xff") {
                    $addr4 = substr($addr, 12);
                    if (self::prefixMatch($addr4, $netBin, $bits ?? 32)) {
                        return true;
                    }
                }
                continue;
            }
            $max = strlen($addr) * 8;
            if ($bits === null) {
                $bits = $max;
            }
            if ($bits < 0 || $bits > $max) {
                continue;
            }
            if (self::prefixMatch($addr, $netBin, $bits)) {
                return true;
            }
        }
        return false;
    }

    private static function prefixMatch(string $a, string $b, int $bits): bool
    {
        $bytes = intdiv($bits, 8);
        if (substr($a, 0, $bytes) !== substr($b, 0, $bytes)) {
            return false;
        }
        $rem = $bits % 8;
        if ($rem === 0) {
            return true;
        }
        $mask = (0xff << (8 - $rem)) & 0xff;
        return (ord($a[$bytes]) & $mask) === (ord($b[$bytes]) & $mask);
    }
}
