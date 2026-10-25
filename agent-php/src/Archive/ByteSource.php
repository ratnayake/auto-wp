<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

interface ByteSource
{
    /** Up to $n bytes; '' at end of stream. */
    public function read(int $n): string;

    /** Logical offset of the next byte. */
    public function position(): int;
}
