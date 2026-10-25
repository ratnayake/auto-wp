<?php

declare(strict_types=1);

namespace AutoWp\Agent;

/**
 * An error that is reported to the client as `{"ok":false,"error":{"code":...,"message":...}}`.
 * Messages must never contain secrets.
 */
final class AgentException extends \RuntimeException
{
    public const CODES = [
        'bad_request',
        'unknown_action',
        'invalid_params',
        'path_jail',
        'not_found',
        'capability',
        'wp_fatal',
        'locked',
        'internal',
    ];

    /** @var string */
    private $errorCode;

    public function __construct(string $code, string $message, ?\Throwable $previous = null)
    {
        if (!in_array($code, self::CODES, true)) {
            $code = 'internal';
        }
        parent::__construct($message, 0, $previous);
        $this->errorCode = $code;
    }

    public function getErrorCode(): string
    {
        return $this->errorCode;
    }

    public static function invalidParams(string $message): self
    {
        return new self('invalid_params', $message);
    }

    public static function jail(string $message = 'path is outside the allowed roots'): self
    {
        return new self('path_jail', $message);
    }

    public static function notFound(string $message): self
    {
        return new self('not_found', $message);
    }

    public static function internal(string $message, ?\Throwable $previous = null): self
    {
        return new self('internal', $message, $previous);
    }
}
