<?php

declare(strict_types=1);

namespace AutoWp\Agent\Security;

/**
 * A request failed verification steps 1-6. The reason goes to the audit log only; the client always
 * gets HTTP 404 with an empty body.
 */
final class AuthFailure extends \RuntimeException
{
    /** @var string */
    private $reason;

    public function __construct(string $reason)
    {
        parent::__construct('authentication failed');
        $this->reason = $reason;
    }

    public function getReason(): string
    {
        return $this->reason;
    }
}
